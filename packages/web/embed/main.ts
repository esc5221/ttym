// The embed panel — /embed/v1/, framed by another app (docs/embedding.md).
//
// Everything it needs comes in the URL fragment, which no server or proxy sees:
//   g       the grant (required)
//   ws | s  the workspace (tabs) or the one session to show; without either, the grant's first entry
//   theme   system | dark | light          chrome  tabs | none
//   font    font size in px                tab     the session to open first
//   parent  the framing page's origin — set by sdk.js; without it the panel talks to no one
//
// With sdk.js in the parent the two talk over postMessage; that message format is
// private to this pair (the SDK is the contract). Without it, the panel still works
// on the fragment alone until its grant expires.

import './asset-base';
import '@xterm/xterm/css/xterm.css';
import './panel.css';
import { checkPaste } from './paste';
import { TerminalMux } from '@ttym/vt';
import {
  acquireHost, destroyAllHosts, destroyHost, reactivateHosts, resetAllHosts, refreshTerminalThemes,
  type HostOptions, type TerminalHost,
} from '@ttym/ui/src/terminal-host';

// Same shapes as @ttym/protocol embed.ts (the web package does not depend on it).
type EmbedAccess = { workspace: string; caps: string[]; profile?: string } | { session: number; caps: string[] };
interface EmbedTab { sid: number; name: string; status: 'running' | 'exited' | 'gone'; createdAt: number }

// ── fragment ──

const params = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, '', location.pathname + location.search);

let grant = params.get('g') ?? '';
let grantExpiresAt = 0;
const parentOrigin = params.get('parent');
const chrome = params.get('chrome') === 'none' ? 'none' : 'tabs';
let theme = params.get('theme') ?? 'system';
const fontSize = Math.min(32, Math.max(8, parseInt(params.get('font') ?? '', 10) || 13));

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const mount = el('term');
const bar = el('bar');
const tabsEl = el('tabs');
const addBtn = el<HTMLButtonElement>('add');
const statusEl = el('status');
const notice = el('notice');
const noticeMsg = el('notice-msg');

// ── parent ──

type Out = { type: string; [k: string]: unknown };
function emit(msg: Out) {
  if (!parentOrigin || parent === window) return;
  parent.postMessage({ ttym: 1, ...msg }, parentOrigin);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let grantWaiter: ((g: string | null) => void) | null = null;
/** Ask the SDK for a fresh grant. null when there is no SDK or it did not answer. */
function requestGrant(): Promise<string | null> {
  if (!parentOrigin || parent === window) return Promise.resolve(null);
  return new Promise((resolve) => {
    grantWaiter?.(null);
    grantWaiter = resolve;
    emit({ type: 'grant-request' });
    setTimeout(() => { if (grantWaiter === resolve) { grantWaiter = null; resolve(null); } }, 15_000);
  });
}

// ── theme ──

function applyTheme(next: string) {
  theme = next === 'dark' || next === 'light' ? next : 'system';
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  refreshTerminalThemes();
}
applyTheme(theme);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (theme === 'system') refreshTerminalThemes(); });

// ── api ──

class AuthError extends Error {}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(new URL(`../../api/embed/v1/${path}`, location.href), {
    method,
    headers: { authorization: `Bearer ${grant}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) throw new AuthError((data as { error?: string }).error ?? 'grant refused');
  if (!r.ok) throw new Error((data as { error?: string }).error ?? `${method} ${path} ${r.status}`);
  return data as T;
}

// ── what this panel shows ──

let access: EmbedAccess[] = [];
let workspace: string | null = params.get('ws');
const singleSession = params.get('s') ? parseInt(params.get('s')!, 10) : null;
let canWrite = false;
let canTabs = false;

function readCaps() {
  const caps = new Set<string>();
  for (const a of access) {
    const hit = singleSession !== null ? ('session' in a && a.session === singleSession) || 'workspace' in a : 'workspace' in a && a.workspace === workspace;
    if (hit) for (const c of a.caps) caps.add(c);
  }
  canWrite = caps.has('terminal.write');
  canTabs = workspace !== null && caps.has('tabs.write');
}

async function introspect() {
  const info = await api<{ expiresAt: number; access: EmbedAccess[] }>('GET', 'grant');
  access = info.access;
  grantExpiresAt = info.expiresAt;
  if (workspace === null && singleSession === null) {
    const first = access[0];
    if (first && 'workspace' in first) workspace = first.workspace;
  }
  readCaps();
  scheduleRenewal();
}

// ── terminals ──

const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = new URL('ws', location.href);
wsUrl.protocol = proto;
const mux = new TerminalMux(wsUrl.toString(), { hello: () => ({ grant }) });

const hostOpts = (): HostOptions => ({ mode: canWrite ? 'readwrite' : 'readonly', fontSize, enableWebgl: true, localEcho: false, geometry: canWrite ? 'fit' : 'follow' });

let tabs: EmbedTab[] = [];
let host = null as TerminalHost | null;
const acquired = new Set<number>();
let visible = true;
let editing = false;
const ACTIVE_KEY = 'ttym-embed-active';

const wantStream = () => visible && !document.hidden;
function syncView() {
  if (!host) return;
  if (wantStream()) { host.activate(); host.resumeView(); } else host.pauseView();
}

function show(sid: number) {
  if (host?.sessionId === sid) return;
  host?.unmount();
  host = acquireHost(mux, sid, hostOpts());
  acquired.add(sid);
  host.mount(mount, (action) => {
    if (action.kind === 'bell') emit({ type: 'bell', sid: action.sessionId });
    if (action.kind !== 'session-exit') return;
    emit({ type: 'exit', sid: action.sessionId });
    destroyHost(action.sessionId);
    acquired.delete(action.sessionId);
    if (host?.sessionId === action.sessionId) host = null;
    void refresh();
  });
  try { localStorage.setItem(`${ACTIVE_KEY}:${workspace ?? ''}`, String(sid)); } catch {}
  syncView();
  render();
  emit({ type: 'active', sid });
}

function storedActive(): number | null {
  const fromUrl = parseInt(params.get('tab') ?? '', 10);
  if (Number.isInteger(fromUrl) && fromUrl > 0) { params.delete('tab'); return fromUrl; }
  try { const v = Number(localStorage.getItem(`${ACTIVE_KEY}:${workspace ?? ''}`)); return Number.isInteger(v) && v > 0 ? v : null; } catch { return null; }
}

function applyTabs(next: EmbedTab[], prefer?: number) {
  const prevIndex = tabs.findIndex((t) => t.sid === host?.sessionId);
  tabs = next.filter((t) => t.status === 'running');
  for (const id of acquired) {
    if (!tabs.some((t) => t.sid === id)) {
      destroyHost(id);
      acquired.delete(id);
      if (host?.sessionId === id) host = null;
    }
  }
  const want = prefer ?? host?.sessionId ?? storedActive();
  const pick = tabs.find((t) => t.sid === want) ?? tabs[Math.min(Math.max(prevIndex, 0), tabs.length - 1)];
  if (pick) show(pick.sid);
  render();
  emit({ type: 'tabs', tabs, active: host?.sessionId ?? null });
}

let refreshing: Promise<void> | null = null;
function refresh(): Promise<void> {
  if (singleSession !== null) return Promise.resolve();
  refreshing ??= (async () => {
    try {
      const r = await api<{ tabs: EmbedTab[] }>('GET', `workspaces/${encodeURIComponent(workspace!)}/tabs`);
      applyTabs(r.tabs);
      status('');
    } catch (e) {
      if (e instanceof AuthError) void reauth();
      else status(e instanceof Error ? e.message : String(e));
    } finally { refreshing = null; }
  })();
  return refreshing;
}

// ── tab operations (tab bar and SDK share these) ──

const tabsPath = (sid?: number) => `workspaces/${encodeURIComponent(workspace!)}/tabs${sid === undefined ? '' : `/${sid}`}`;

async function createTab(name?: string): Promise<EmbedTab> {
  if (!canTabs) throw new Error('this grant cannot open tabs');
  const r = await api<{ tab: EmbedTab; tabs: EmbedTab[] }>('POST', tabsPath(), name ? { name } : {});
  applyTabs(r.tabs, r.tab.sid);
  return r.tab;
}
async function renameTab(sid: number, name: string) {
  if (!canTabs) throw new Error('this grant cannot rename tabs');
  applyTabs((await api<{ tabs: EmbedTab[] }>('PATCH', tabsPath(sid), { name })).tabs);
}
async function closeTab(sid: number) {
  if (!canTabs) throw new Error('this grant cannot close tabs');
  applyTabs((await api<{ tabs: EmbedTab[] }>('DELETE', tabsPath(sid))).tabs);
}

function status(text: string) { statusEl.textContent = text; }

const act = async (fn: () => Promise<unknown>) => {
  try { await fn(); } catch (e) {
    if (e instanceof AuthError) void reauth();
    else status(e instanceof Error ? e.message : String(e));
  }
  host?.focusTerminal();
};

function startRename(tab: EmbedTab, label: HTMLElement) {
  editing = true;
  const input = document.createElement('input');
  input.className = 'tab-rename';
  input.value = tab.name;
  input.maxLength = 32;
  input.size = Math.max(tab.name.length, 6);
  label.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    editing = false;
    const name = input.value.trim();
    if (!save || !name || name === tab.name) { render(); host?.focusTerminal(); return; }
    void act(() => renameTab(tab.sid, name)).then(render);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

function render() {
  bar.hidden = chrome === 'none' || singleSession !== null;
  addBtn.hidden = !canTabs;
  if (editing || bar.hidden) return;
  tabsEl.replaceChildren();
  for (const tab of tabs) {
    const item = document.createElement('div');
    item.className = 'tab' + (tab.sid === host?.sessionId ? ' active' : '');
    item.setAttribute('role', 'tab');
    const label = document.createElement('span');
    label.className = 'tab-name';
    label.textContent = tab.name;
    item.append(label);
    if (canTabs) {
      item.title = `${tab.name} — double-click to rename, middle-click to close`;
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'tab-close';
      close.title = 'Close tab (ends its shell)';
      close.textContent = '×';
      close.addEventListener('click', (e) => { e.stopPropagation(); void act(() => closeTab(tab.sid)); });
      item.append(close);
      item.addEventListener('auxclick', (e) => { if (e.button === 1) void act(() => closeTab(tab.sid)); });
      label.addEventListener('dblclick', () => startRename(tab, label));
    }
    item.addEventListener('click', () => { show(tab.sid); host?.focusTerminal(); });
    tabsEl.append(item);
  }
}
addBtn.addEventListener('click', () => void act(() => createTab()));

// ── connection ──

let authFailed = false;
function showNotice(text: string | null) {
  notice.hidden = text === null;
  noticeMsg.textContent = text ?? '';
}

/** The grant was refused or ran out: get a new one from the SDK, or stop and say so. */
let reauthing: Promise<boolean> | null = null;
function reauth(): Promise<boolean> {
  reauthing ??= (async () => {
    emit({ type: 'auth', reason: 'grant refused or expired' });
    const next = await requestGrant();
    if (!next) {
      authFailed = true;
      showNotice('This terminal session has ended. Reload the page to open it again.');
      mux.disconnect();
      return false;
    }
    grant = next;
    authFailed = false;
    showNotice(null);
    await introspect().catch(() => {});
    return true;
  })().finally(() => { reauthing = null; });
  return reauthing;
}

let renewTimer: ReturnType<typeof setTimeout> | null = null;
/** With an SDK in the parent, swap to a fresh grant a minute before this one ends. */
function scheduleRenewal() {
  if (renewTimer) clearTimeout(renewTimer);
  if (!parentOrigin || !grantExpiresAt) return;
  // A minute early for an ordinary grant; a fifth of the lifetime early for a short one.
  const remaining = grantExpiresAt - Date.now();
  const wait = Math.max(5_000, remaining - Math.min(60_000, remaining * 0.2));
  renewTimer = setTimeout(() => {
    void requestGrant().then(async (next) => {
      if (!next) return;
      grant = next;
      await introspect().catch(() => {});
      // The open socket was authorized by the old grant; re-dial on the new one.
      resetAllHosts();
      await connect();
      reactivateHosts();
    });
  }, wait);
}

let connecting: Promise<void> | null = null;
function connect(): Promise<void> {
  connecting ??= (async () => {
    let delay = 500;
    while (!authFailed) {
      try {
        await mux.connect();
        emit({ type: 'connected' });
        return;
      } catch {
        status(`reconnecting in ${Math.ceil(delay / 1000)}s`);
        await sleep(delay);
        delay = Math.min(delay * 2, 5000);
      }
    }
  })().finally(() => { connecting = null; });
  return connecting;
}

mux.onDisconnect(() => {
  resetAllHosts();
  emit({ type: 'disconnected' });
  void (async () => {
    if (mux.lastCloseCode === 4401 && !(await reauth())) return;
    status('reconnecting…');
    await connect();
    reactivateHosts();
    status('');
    await refresh();
  })();
});

let pushTimer: ReturnType<typeof setTimeout> | null = null;
mux.onWorkspace((ev) => {
  if (ev.workspace?.id !== workspace && ev.deletedId !== workspace) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { pushTimer = null; void refresh(); }, 150);
});

document.addEventListener('visibilitychange', syncView);

// ── paste (sdk handle.paste) ──

/**
 * Put text on the active tab's input line without submitting it. Goes through
 * xterm's own paste, so it is bracketed when the program asked for bracketed
 * paste (Claude Code, zsh, bash) and travels the normal input path — a
 * read-only attach drops it server-side as it drops typing.
 */
function pasteText(raw: unknown): Promise<null> {
  if (!canWrite) return Promise.reject(new Error('terminal.write required'));
  if (!host) return Promise.reject(new Error('no active tab'));
  const checked = checkPaste(raw, host.term.modes.bracketedPasteMode);
  if ('error' in checked) return Promise.reject(new Error(checked.error));
  host.term.paste(checked.text);
  return Promise.resolve(null);
}

// ── messages from sdk.js ──

window.addEventListener('message', (e) => {
  if (!parentOrigin || e.origin !== parentOrigin || e.source !== parent) return;
  const msg = e.data as { ttym?: number; type?: string; reqId?: number; [k: string]: unknown };
  if (!msg || msg.ttym !== 1) return;
  const reply = (p: Promise<unknown>) => {
    p.then((value) => emit({ type: 'result', reqId: msg.reqId, ok: true, value }),
      (err) => emit({ type: 'result', reqId: msg.reqId, ok: false, error: err instanceof Error ? err.message : String(err) }));
  };
  switch (msg.type) {
    case 'grant': {
      const g = typeof msg.grant === 'string' ? msg.grant : null;
      if (grantWaiter) { const w = grantWaiter; grantWaiter = null; w(g); }
      break;
    }
    case 'focus': host?.focusTerminal(); break;
    case 'visible': visible = msg.visible !== false; syncView(); break;
    case 'theme': applyTheme(String(msg.theme ?? 'system')); break;
    case 'select': {
      const sid = Number(msg.sid);
      reply(tabs.some((t) => t.sid === sid) ? Promise.resolve(show(sid)) : Promise.reject(new Error(`no tab ${sid}`)));
      break;
    }
    case 'create': reply(createTab(typeof msg.name === 'string' ? msg.name : undefined)); break;
    case 'rename': reply(renameTab(Number(msg.sid), String(msg.name ?? ''))); break;
    case 'close': reply(closeTab(Number(msg.sid))); break;
    case 'paste': reply(pasteText(msg.text)); break;
  }
});

// ── start ──

void (async () => {
  if (!grant) { showNotice('No grant in the URL. Open this panel through the app that embeds it.'); return; }
  status('connecting…');
  try { await introspect(); } catch (e) {
    if (!(e instanceof AuthError) || !(await reauth())) {
      if (!(e instanceof AuthError)) showNotice(e instanceof Error ? e.message : String(e));
      return;
    }
  }
  render();
  await connect();
  status('');
  if (singleSession !== null) {
    tabs = [{ sid: singleSession, name: String(singleSession), status: 'running', createdAt: 0 }];
    show(singleSession);
  } else if (workspace) {
    let delay = 1000;
    while (tabs.length === 0 && !authFailed) {
      await refresh();
      if (tabs.length || !canTabs) break;
      await sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }
  } else {
    showNotice('This grant names no workspace or session to show.');
  }
  emit({ type: 'ready', tabs, active: host?.sessionId ?? null, access, canWrite, canTabs });
})();

window.addEventListener('pagehide', () => {
  host?.unmount();
  destroyAllHosts();
  mux.disconnect();
});
