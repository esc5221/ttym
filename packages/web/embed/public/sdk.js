/*
 * ttym embed SDK — /embed/v1/sdk.js
 *
 *   <script src="/studio/embed/v1/sdk.js"></script>
 *   const t = TtymEmbed.mount(el, { base: '/studio', grant: () => fetch('/studio/grant').then(r => r.json()) })
 *
 * The contract is this file's surface: mount() options, the handle's methods and
 * events. How it talks to the panel iframe (postMessage) is private and may change
 * with the panel, which always comes from the same ttym build. docs/embedding.md.
 */
(function () {
  'use strict';
  var SDK_VERSION = 2;
  var EVENTS = ['ready', 'tabs', 'active', 'exit', 'bell', 'auth', 'connected', 'disconnected'];

  /** grant option → Promise<{ grant, access? }> */
  function resolveGrant(option) {
    if (typeof option === 'function') return Promise.resolve(option()).then(normalize);
    return Promise.resolve(normalize(option));
  }
  function normalize(value) {
    if (typeof value === 'string') return { grant: value };
    if (value && typeof value.grant === 'string') return value;
    throw new Error('ttym embed: grant must be a string, { grant }, or a function returning one');
  }

  function mount(el, opts) {
    if (!el || !el.appendChild) throw new Error('ttym embed: mount(el, opts) needs an element');
    opts = opts || {};
    var base = String(opts.base == null ? '' : opts.base).replace(/\/+$/, '');
    var panelUrl = new URL(base + '/embed/v1/', location.href);
    var panelOrigin = panelUrl.origin;
    var listeners = {};
    EVENTS.forEach(function (e) { listeners[e] = []; });
    var iframe = null;
    var destroyed = false;
    var reqSeq = 0;
    var pending = {};
    var readyQueue = [];
    var isReady = false;

    function emit(type, detail) {
      (listeners[type] || []).slice().forEach(function (fn) { try { fn(detail); } catch (e) { setTimeout(function () { throw e; }); } });
    }
    function post(msg) {
      if (!iframe || !iframe.contentWindow) return;
      msg.ttym = 1;
      iframe.contentWindow.postMessage(msg, panelOrigin);
    }
    function whenReady(fn) { if (isReady) fn(); else readyQueue.push(fn); }
    function call(type, payload) {
      return new Promise(function (resolve, reject) {
        whenReady(function () {
          var reqId = ++reqSeq;
          pending[reqId] = { resolve: resolve, reject: reject };
          payload.type = type;
          payload.reqId = reqId;
          post(payload);
        });
      });
    }

    function onMessage(e) {
      if (!iframe || e.source !== iframe.contentWindow || e.origin !== panelOrigin) return;
      var msg = e.data;
      if (!msg || msg.ttym !== 1) return;
      switch (msg.type) {
        case 'grant-request':
          if (typeof opts.grant !== 'function') { post({ type: 'grant', grant: null }); return; }
          resolveGrant(opts.grant).then(function (g) { post({ type: 'grant', grant: g.grant }); },
            function () { post({ type: 'grant', grant: null }); });
          return;
        case 'result': {
          var p = pending[msg.reqId];
          if (!p) return;
          delete pending[msg.reqId];
          if (msg.ok) p.resolve(msg.value); else p.reject(new Error(msg.error));
          return;
        }
        case 'ready':
          isReady = true;
          readyQueue.splice(0).forEach(function (fn) { fn(); });
          emit('ready', { tabs: msg.tabs, active: msg.active, access: msg.access, canWrite: msg.canWrite, canTabs: msg.canTabs });
          return;
        case 'tabs': emit('tabs', { tabs: msg.tabs, active: msg.active }); return;
        case 'active': emit('active', { sid: msg.sid }); return;
        case 'exit': emit('exit', { sid: msg.sid }); return;
        case 'bell': emit('bell', { sid: msg.sid }); return;
        case 'auth': emit('auth', { reason: msg.reason }); return;
        case 'connected': emit('connected', {}); return;
        case 'disconnected': emit('disconnected', {}); return;
      }
    }
    window.addEventListener('message', onMessage);

    resolveGrant(opts.grant).then(function (g) {
      if (destroyed) return;
      var hash = new URLSearchParams();
      hash.set('g', g.grant);
      hash.set('parent', location.origin);
      var first = g.access && g.access[0];
      if (opts.session != null) hash.set('s', String(opts.session));
      else if (opts.workspace) hash.set('ws', opts.workspace);
      else if (first && first.workspace) hash.set('ws', first.workspace);
      else if (first && first.session != null) hash.set('s', String(first.session));
      if (opts.chrome) hash.set('chrome', opts.chrome);
      if (opts.theme) hash.set('theme', opts.theme);
      if (opts.fontSize) hash.set('font', String(opts.fontSize));
      if (opts.initialTab != null) hash.set('tab', String(opts.initialTab));
      iframe = document.createElement('iframe');
      iframe.src = panelUrl.href + '#' + hash.toString();
      iframe.title = opts.title || 'Terminal';
      iframe.setAttribute('allow', 'clipboard-read; clipboard-write');
      iframe.setAttribute('referrerpolicy', 'no-referrer');
      iframe.style.cssText = 'display:block;width:100%;height:100%;border:0;';
      el.appendChild(iframe);
    }, function (err) {
      emit('auth', { reason: err && err.message ? err.message : String(err) });
    });

    return {
      version: SDK_VERSION,
      /** on(event, fn) → unsubscribe. Events: ready tabs active exit bell auth connected disconnected */
      on: function (type, fn) {
        if (!listeners[type]) throw new Error('ttym embed: unknown event ' + type);
        listeners[type].push(fn);
        return function () { listeners[type] = listeners[type].filter(function (f) { return f !== fn; }); };
      },
      focus: function () { whenReady(function () { post({ type: 'focus' }); }); },
      /** Pause the stream while the panel is hidden (minimized, another tab of the app). */
      setVisible: function (visible) { whenReady(function () { post({ type: 'visible', visible: visible !== false }); }); },
      setTheme: function (theme) { whenReady(function () { post({ type: 'theme', theme: theme }); }); },
      selectTab: function (sid) { return call('select', { sid: sid }); },
      createTab: function (name) { return call('create', { name: name }); },
      renameTab: function (sid, name) { return call('rename', { sid: sid, name: name }); },
      closeTab: function (sid) { return call('close', { sid: sid }); },
      /** Put text on the active tab's input line; no Enter. Needs terminal.write. (sdk 2) */
      paste: function (text) { return call('paste', { text: text }); },
      destroy: function () {
        destroyed = true;
        window.removeEventListener('message', onMessage);
        Object.keys(pending).forEach(function (k) { pending[k].reject(new Error('destroyed')); });
        pending = {};
        if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe);
        iframe = null;
      },
    };
  }

  window.TtymEmbed = { version: SDK_VERSION, mount: mount };
})();
