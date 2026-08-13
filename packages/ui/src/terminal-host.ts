import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { WebFontsAddon } from '@xterm/addon-web-fonts';
import type { IDisposable } from '@xterm/xterm';
import { LocalEchoController, type TerminalMux, type ActionHandler } from '@ttym/vt';

/**
 * A TerminalHost owns everything one session's terminal needs — the xterm
 * instance, its wrapper DOM, renderer, write pipeline — and outlives any
 * React component that displays it. Components reparent the wrapper in and
 * out; the instance is destroyed only when the session ends or the host is
 * evicted. This is the vscode terminal model: scrollback and renderer state
 * survive every view change because nothing is ever re-created.
 */

/**
 * One-way GPU latch. If WebGL addon *creation* ever fails — typically the
 * browser's context limit — every later host goes straight to the DOM
 * renderer. Per-instance retry loops are what turn a context limit into an
 * eviction/flicker cascade. A context *loss* does not set the latch: that
 * can be a transient GPU reset, so only the affected host falls back.
 */
let gpuLatched = false;

/** For tests. */
export function resetGpuLatchForTests() { gpuLatched = false; }

const IMMEDIATE_WRITE_BYTES = 512;
/** Disconnected hosts kept around for instant re-display before eviction. */
const MAX_IDLE_HOSTS = 16;

// The host speaks to its shell in actions — one-way, optional to handle.

export interface HostOptions {
  mode: 'readwrite' | 'readonly';
  fontSize: number;
  enableWebgl: boolean;
  localEcho: boolean;
}

const registry = new Map<number, TerminalHost>();

// A refresh mounts every visible pane in the same tick; letting them all
// attach at once stacks N snapshot parses on one main-thread frame. The
// queue spaces attaches 40ms apart — imperceptible per pane, and the page
// stays interactive through a cold reload of a fat workspace.
let activationChain: Promise<void> = Promise.resolve();
function queueActivation(run: () => boolean) {
  activationChain = activationChain.then(() => {
    // A canceled entry (host disconnected or disposed while waiting its
    // turn) reports false and costs the queue nothing — earlier it still
    // burned its 40ms slot and delayed every pane behind it.
    if (!run()) return;
    return new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 40));
  });
}

/** 터미널 배경 = 앱 배경. 토큰 CSS가 없으면 종전 하드코딩 값으로 동작한다. */
function cssVar(name: string, fallback: string): string {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  } catch { return fallback; }
}

function terminalTheme() {
  return {
    background: cssVar('--term-bg', '#1e1e1e'),
    foreground: cssVar('--term-fg', '#d4d4d4'),
    cursor: cssVar('--term-fg', '#d4d4d4'),
  };
}

/** 테마 토글 후 호출: 살아있는 모든 터미널에 새 팔레트를 적용한다. */
export function refreshTerminalThemes() {
  const theme = terminalTheme();
  for (const host of registry.values()) {
    host.term.options.theme = theme;
  }
}

export function getHost(sessionId: number): TerminalHost | undefined {
  return registry.get(sessionId);
}

export function acquireHost(mux: TerminalMux, sessionId: number, opts: HostOptions): TerminalHost {
  let host = registry.get(sessionId);
  if (host) {
    host.applyOptions(opts);
    return host;
  }
  host = new TerminalHost(mux, sessionId, opts);
  registry.set(sessionId, host);
  evictIdleHosts();
  return host;
}

export function destroyHost(sessionId: number) {
  const host = registry.get(sessionId);
  if (host) {
    registry.delete(sessionId);
    host.dispose();
  }
}

export function destroyAllHosts() {
  for (const host of registry.values()) host.dispose();
  registry.clear();
}

function evictIdleHosts() {
  if (registry.size <= MAX_IDLE_HOSTS) return;
  for (const [id, host] of registry) {
    if (registry.size <= MAX_IDLE_HOSTS) break;
    if (!host.isMounted) {
      registry.delete(id);
      host.dispose();
    }
  }
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

// 맥 외 플랫폼에만 D2Coding webfont를 등록한다 — 맥은 Menlo가 현행 경험 그대로이고,
// FontFace를 등록하지 않으면 스택의 D2Coding이 건너뛰어져 다운로드조차 없다.
// 파일은 서버가 same-origin으로 서빙(packages/web/public/fonts, OFL).
if (!IS_MAC && typeof document !== 'undefined' && 'fonts' in document) {
  document.fonts.add(new FontFace('D2Coding', "url(/fonts/D2Coding.woff2) format('woff2')", { weight: '400' }));
  document.fonts.add(new FontFace('D2Coding', "url(/fonts/D2Coding-Bold.woff2) format('woff2')", { weight: '700' }));
}

const TERMINAL_FONTS = IS_MAC
  ? 'Menlo, Monaco, "Courier New", monospace'
  : 'D2Coding, "Cascadia Mono", Consolas, "Courier New", monospace';

export class TerminalHost {
  readonly wrapper: HTMLDivElement;
  readonly term: XTerm;
  private readonly fit: FitAddon;
  private webgl: WebglAddon | undefined;
  private searchAddon: SearchAddon | undefined;
  /** 쉘 통합(OSC 133;A)이 심는 프롬프트 경계 marker — ⌘↑/⌘↓ 점프의 좌표계. */
  private commandMarkers: import('@xterm/xterm').IMarker[] = [];
  /** 찾기바가 구독한다: (activeIndex, total). 인덱스는 0-기준, 결과 없으면 (-1, 0). */
  onSearchResults: ((index: number, count: number) => void) | undefined;
  private opts: HostOptions;
  private disposed = false;
  private opened = false;
  /**
   * The stream's lifecycle, explicit. The boolean pair this replaces had a
   * lethal gap: `connected` was set before ATTACH resolved, and a failed
   * ATTACH left it true forever — activate() early-returned on every later
   * try, so one timeout turned into a permanently blank pane.
   *
   *   idle → queued → attaching → attached ⇄ paused
   */
  private stream: 'idle' | 'queued' | 'attaching' | 'attached' | 'paused' = 'idle';
  private attachRetries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private mounted = false;
  private inputDisposables: IDisposable[] = [];
  private onAction: ActionHandler = () => {};
  private resizeObserver: ResizeObserver | null = null;
  private readonly localEcho: LocalEchoController;

  // rAF write batching. ACK follows the *write callback*, not receipt: the
  // server's backpressure then measures what the client has actually parsed,
  // not what the network delivered.
  private writeRaf: number | null = null;
  private writeChunks: Uint8Array[] = [];
  private writeBytes = 0;
  private pendingAckSeq: number | null = null;

  constructor(private readonly mux: TerminalMux, readonly sessionId: number, opts: HostOptions) {
    this.opts = { ...opts };
    this.wrapper = document.createElement('div');
    this.wrapper.style.width = '100%';
    this.wrapper.style.height = '100%';

    this.term = new XTerm({
      // 검색 하이라이트(decorations)가 proposed API — headless 쪽은 이미 켜져 있다.
      allowProposedApi: true,
      cursorBlink: opts.mode !== 'readonly',
      fontSize: opts.fontSize,
      fontFamily: TERMINAL_FONTS,
      theme: terminalTheme(),
      disableStdin: opts.mode === 'readonly',
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);

    // 서버와 같은 신호를 클라도 직접 읽는다 — 와이어 변경 없이 명령 경계를 안다.
    // A(프롬프트 시작)마다 marker 하나. 스크롤백에서 잘려나가면 xterm이 알아서 폐기.
    this.term.parser.registerOscHandler(133, (data) => {
      if (data === 'A') this.commandMarkers.push(this.term.registerMarker(0));
      return true;
    });

    this.localEcho = new LocalEchoController({
      writeOptimistic: (text) => this.term.write(text),
      writeOptimisticBackspace: () => this.term.write('\b \b'),
      requestSnapshot: () => this.mux.requestSnapshot(this.sessionId),
    });
    this.localEcho.setEnabled(opts.localEcho && opts.mode !== 'readonly');
    this.term.onBell(() => this.onAction({ kind: 'bell', sessionId: this.sessionId }));
  }

  get isMounted(): boolean { return this.mounted; }

  /** Reparent the wrapper into a container. Never re-creates the terminal. */
  mount(container: HTMLElement, onAction: ActionHandler) {
    if (this.disposed) return;
    this.onAction = onAction;
    if (this.wrapper.parentElement !== container) {
      container.appendChild(this.wrapper);
      if (this.opened) {
        // Re-open against its own element: refreshes xterm's document
        // reference when the wrapper moved (vscode does the same for
        // multi-window support), and is a no-op otherwise.
        this.term.open(this.wrapper);
        this.scheduleFit();
      }
    }
    this.mounted = true;
    this.resizeObserver = new ResizeObserver(() => {
      if (!this.disposed && this.wrapper.isConnected) {
        try { this.fit.fit(); } catch {}
      }
    });
    this.resizeObserver.observe(this.wrapper);
  }

  /** Remove from DOM and drop the mux attachment. Instance and buffer stay. */
  unmount() {
    this.mounted = false;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.disconnect();
    this.wrapper.remove();
    this.cancelPendingWrites();
  }

  /**
   * Open the renderer and attach to the session stream. Deferred by the
   * component until the host is actually visible (lazy open): a terminal
   * that has never been seen costs no renderer, no GPU context, no WS
   * subscription.
   */
  activate() {
    if (this.disposed || this.stream !== 'idle') return;
    if (!this.opened) {
      this.opened = true;
      this.wrapper.style.visibility = 'hidden';
      this.term.open(this.wrapper);
      this.maybeEnableWebgl();
      // URL 클릭(web-links)과 OSC 52 클립보드 — 렌더러와 같은 시점에 싣는다.
      // 링크는 에이전트가 뱉는 PR·배포 URL을 바로 여는 용도, OSC 52는 세션
      // 안의 vim·tmux·원격 ssh가 시스템 클립보드로 복사하게 해준다.
      // 로드 전엔 webfont를 스택에서 잠시 빼고 폴백으로 계측, 로드 완료 시 재계측.
    try { this.term.loadAddon(new WebFontsAddon()); } catch {}
    try { this.term.loadAddon(new WebLinksAddon()); } catch {}
      try { this.term.loadAddon(new ClipboardAddon()); } catch {}
      try { this.fit.fit(); } catch {}
      requestAnimationFrame(() => { if (!this.disposed) this.wrapper.style.visibility = 'visible'; });
    }
    this.stream = 'queued';
    queueActivation(() => {
      if (this.disposed || this.stream !== 'queued') return false;
      this.doAttach();
      return true;
    });
  }

  private doAttach() {
    this.stream = 'attaching';
    this.mux.attachSession(this.sessionId, {
      onData: (data, seq) => this.handleData(data, seq),
      onSnapshot: (snap, seq) => this.handleSnapshot(snap, seq),
      onExit: () => {
        this.cancelPendingWrites();
        this.onAction({ kind: 'session-exit', sessionId: this.sessionId });
      },
    }, {
      cols: this.term.cols,
      rows: this.term.rows,
      mode: this.opts.mode,
    }).then(() => {
      if (this.disposed || this.stream !== 'attaching') { this.mux.detachSession(this.sessionId); return; }
      this.stream = 'attached';
      this.attachRetries = 0;
      this.wireInput();
    }).catch(() => {
      if (this.disposed || this.stream !== 'attaching') return;
      // Transient failure (timeout, reconnect race) — back to idle and retry
      // with backoff. idle also means the next syncViewState re-activates
      // naturally, so the pane recovers even after the retries run out.
      this.stream = 'idle';
      if (this.attachRetries < 3) {
        const delay = 500 * 2 ** this.attachRetries;
        this.attachRetries += 1;
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          if (!this.disposed && this.stream === 'idle' && this.mounted) this.activate();
        }, delay);
      } else {
        this.term.write('\r\n\x1b[31m[failed to attach session]\x1b[0m\r\n');
      }
    });
  }

  /** Detach from the stream without touching the terminal or its buffer. */
  disconnect() {
    if (this.stream === 'idle') return;
    const hadServerSideAttach = this.stream === 'attached' || this.stream === 'paused';
    // 'queued' dies in the queue check; 'attaching' dies in its own then().
    this.stream = 'idle';
    if (this.retryTimer !== null) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.attachRetries = 0;
    for (const d of this.inputDisposables) d.dispose();
    this.inputDisposables = [];
    if (hadServerSideAttach) this.mux.detachSession(this.sessionId);
  }

  /** Out of viewport (or tab hidden): stop the stream, keep everything else. */
  pauseView() {
    // Only an attached stream can pause — a PAUSE/RESUME fired before ATTACH
    // made the server resync a viewer that had no callbacks registered yet.
    if (this.stream !== 'attached') return;
    this.stream = 'paused';
    this.mux.pauseView(this.sessionId);
  }

  /** Back in view: resume from the last seq — delta replay, or one snapshot. */
  resumeView() {
    if (this.stream !== 'paused') return;
    this.stream = 'attached';
    // Unparsed queued bytes sit above the acked watermark the resume will
    // replay from — parsing them AND the replay would paint them twice.
    // Drop them; the replay re-delivers the same range.
    this.cancelPendingWrites();
    this.mux.resumeView(this.sessionId);
  }

  applyOptions(opts: HostOptions) {
    const prev = this.opts;
    this.opts = { ...opts };
    this.localEcho.setEnabled(opts.localEcho && opts.mode !== 'readonly');
    if (prev.fontSize !== opts.fontSize) {
      this.term.options.fontSize = opts.fontSize;
      this.scheduleFit();
    }
    if (prev.mode !== opts.mode) {
      this.term.options.disableStdin = opts.mode === 'readonly';
      this.term.options.cursorBlink = opts.mode !== 'readonly';
    }
    if (prev.enableWebgl !== opts.enableWebgl && this.opened) {
      if (opts.enableWebgl) this.maybeEnableWebgl();
      else this.dropWebgl();
    }
  }

  // ── 검색 (vscode 터미널 모델: SearchAddon + 얇은 찾기바) ──

  private ensureSearch(): SearchAddon {
    if (!this.searchAddon) {
      this.searchAddon = new SearchAddon();
      this.term.loadAddon(this.searchAddon);
      this.searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
        this.onSearchResults?.(resultIndex, resultCount);
      });
    }
    return this.searchAddon;
  }

  private searchOptions(incremental: boolean) {
    return {
      incremental,
      decorations: {
        matchBackground: '#3a5a7a',
        matchOverviewRuler: '#3a5a7a',
        activeMatchBackground: '#007acc',
        activeMatchColorOverviewRuler: '#007acc',
      },
    };
  }

  /** incremental: 타이핑 중 재검색(제자리), 아니면 다음 매치로 전진. */
  findNext(query: string, incremental = false): boolean {
    if (!query) { this.clearSearch(); return false; }
    return this.ensureSearch().findNext(query, this.searchOptions(incremental));
  }

  findPrevious(query: string): boolean {
    if (!query) return false;
    return this.ensureSearch().findPrevious(query, this.searchOptions(false));
  }

  clearSearch() {
    this.searchAddon?.clearDecorations();
    this.onSearchResults?.(-1, 0);
  }

  /** ⌘↑/⌘↓: 이전/다음 명령 경계로 스크롤. 경계 = OSC 133;A 프롬프트 줄. */
  jumpCommand(dir: -1 | 1) {
    this.commandMarkers = this.commandMarkers.filter((m) => !m.isDisposed);
    const markers = [...this.commandMarkers].sort((a, b) => a.line - b.line);
    if (markers.length === 0) return;
    const here = this.term.buffer.active.viewportY;
    const target = dir === -1
      ? [...markers].reverse().find((m) => m.line < here)
      : markers.find((m) => m.line > here);
    if (target) {
      this.term.scrollToLine(target.line);
      this.flashLine(target);
    } else if (dir === 1) {
      this.term.scrollToBottom();
      const last = markers[markers.length - 1];
      if (last) this.flashLine(last);
    }
  }

  /** 착지 표시 — 없으면 점프했는지 화면이 말해주지 않는다. 줄 전체를 잠깐 물들이고 페이드아웃. */
  private flashLine(marker: import('@xterm/xterm').IMarker) {
    try {
      const deco = this.term.registerDecoration({ marker, width: this.term.cols, layer: 'top' });
      if (!deco) return;
      deco.onRender((el) => {
        if (el.dataset.flash) return; // onRender는 프레임마다 불린다 — 연출은 1회만
        el.dataset.flash = '1';
        // 앱 전역이 transition:none!important라 인라인으론 못 이긴다 —
        // index.html의 .jump-flash 화이트리스트가 트랜지션의 실소유자.
        el.classList.add('jump-flash');
        el.style.background = 'rgba(0, 122, 204, 0.42)';
        el.style.pointerEvents = 'none';
        el.style.opacity = '0';
        // reflow로 시작점(0)을 먼저 커밋 — 같은 프레임에 0→1을 쓰면
        // 브라우저가 트랜지션 없이 1로 직행한다
        void el.offsetHeight;
        el.style.opacity = '1';
      });
      // in 160ms → hold ~340ms → out 600ms: 펄스 하나로 읽히는 리듬
      setTimeout(() => {
        const el = deco.element;
        if (el) { el.classList.add('jump-flash-out'); el.style.opacity = '0'; }
      }, 500);
      setTimeout(() => { try { deco.dispose(); } catch {} }, 1200);
    } catch {}
  }

  focusTerminal() {
    try { this.term.focus(); } catch {}
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    // The buffer dies here, so the watermark it earned dies with it — a
    // fresh host for this session must snapshot, not resume a ghost ledger.
    this.mux.forgetSeq(this.sessionId);
    this.unmount();
    this.cancelPendingWrites();
    this.webgl?.dispose();
    this.webgl = undefined;
    this.searchAddon?.dispose();
    this.searchAddon = undefined;
    this.fit.dispose();
    this.term.dispose();
    this.localEcho.setEnabled(false);
  }

  // ── renderer ──

  private maybeEnableWebgl() {
    if (!this.opts.enableWebgl || gpuLatched || this.webgl) return;
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        // Transient GPU reset: only this host falls back.
        this.dropWebgl();
      });
      this.term.loadAddon(webgl);
      this.webgl = webgl;
    } catch {
      // Creation failure — usually the browser's context ceiling. Latch so
      // no later host walks into the same wall and flickers on the way down.
      gpuLatched = true;
      this.webgl = undefined;
    }
  }

  private dropWebgl() {
    this.webgl?.dispose();
    this.webgl = undefined;
    // The DOM and WebGL renderers disagree slightly on cell metrics; without
    // a re-fit the grid drifts from the PTY size after a fallback.
    this.scheduleFit();
  }

  private scheduleFit() {
    requestAnimationFrame(() => {
      if (this.disposed) return;
      try {
        this.fit.fit();
        this.term.refresh(0, Math.max(0, this.term.rows - 1));
      } catch {}
    });
  }

  // ── stream ──

  private handleData(data: Uint8Array, seq?: number) {
    const reconciled = this.localEcho.reconcileServerData(data);
    if (seq !== undefined) this.pendingAckSeq = seq;
    if (reconciled.length === 0) {
      this.flushAckIfIdle();
      return;
    }
    this.enqueueWrite(reconciled);
  }

  private enqueueWrite(data: Uint8Array) {
    if (this.disposed) return;
    if (this.writeRaf === null && this.writeBytes === 0 && data.length <= IMMEDIATE_WRITE_BYTES) {
      const seq = this.pendingAckSeq;
      this.pendingAckSeq = null;
      this.term.write(data, () => { if (seq !== null) this.mux.ack(this.sessionId, seq); });
      return;
    }
    this.writeChunks.push(data);
    this.writeBytes += data.length;
    if (this.writeRaf === null) this.writeRaf = requestAnimationFrame(() => this.flushWrites());
  }

  private flushWrites() {
    this.writeRaf = null;
    if (this.writeBytes === 0 || this.disposed) return;
    const merged = new Uint8Array(this.writeBytes);
    let offset = 0;
    for (const chunk of this.writeChunks) { merged.set(chunk, offset); offset += chunk.length; }
    this.writeChunks = [];
    this.writeBytes = 0;
    const seq = this.pendingAckSeq;
    this.pendingAckSeq = null;
    this.term.write(merged, () => { if (seq !== null) this.mux.ack(this.sessionId, seq); });
  }

  private flushAckIfIdle() {
    // Data fully swallowed by local echo still advanced the seq; ack it so
    // the server's unacked window does not grow on predicted keystrokes.
    if (this.pendingAckSeq !== null && this.writeBytes === 0) {
      const seq = this.pendingAckSeq;
      this.pendingAckSeq = null;
      this.mux.ack(this.sessionId, seq);
    }
  }

  private handleSnapshot(snapStr: string, seq?: number) {
    if (this.disposed) return;
    // Queued bytes predate the snapshot — it already contains them.
    this.cancelPendingWrites();
    this.localEcho.handleSnapshot();
    // RIS in-band instead of term.reset(): one write chunk parses atomically
    // in xterm, so clear and repaint land in the same frame, after any bytes
    // already sitting in xterm's own write buffer. The 2026 wrap makes the
    // repaint atomic even if a future xterm splits the chunk (supported
    // since xterm 6; harmless before).
    // The ack after the parse commits the snapshot's watermark — the same
    // parsed-not-received rule DATA follows.
    this.term.write('\x1bc\x1b[?2026h' + snapStr + '\x1b[?2026l', () => {
      if (seq !== undefined && !this.disposed) this.mux.ack(this.sessionId, seq);
    });
  }

  private cancelPendingWrites() {
    if (this.writeRaf !== null) { cancelAnimationFrame(this.writeRaf); this.writeRaf = null; }
    this.writeChunks = [];
    this.writeBytes = 0;
    this.pendingAckSeq = null;
  }

  private wireInput() {
    if (this.opts.mode === 'readonly') return;
    // xterm 6.0은 mac의 Option+←/→ 특례(ESC b / ESC f — Terminal.app·5.5와 동일)를
    // 버리고 CSI 1;3D/C를 보낸다. zsh 기본 keymap은 이 시퀀스를 몰라 C/D가
    // 그대로 찍히므로, 순수 Option+좌우에 한해 5.5의 단어점프 바이트를 복원한다.
    this.term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown' || this.opts.mode === 'readonly') return true;
      if (!IS_MAC || !ev.altKey || ev.metaKey || ev.ctrlKey || ev.shiftKey) return true;
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return true;
      this.mux.send(this.sessionId, ev.key === 'ArrowLeft' ? '\x1bb' : '\x1bf');
      return false;
    });
    this.inputDisposables.push(this.term.onData((data) => {
      this.localEcho.handleLocalInput(data);
      this.mux.send(this.sessionId, data);
    }));
    this.inputDisposables.push(this.term.onBinary((data) => {
      this.localEcho.handleBinaryInput();
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i);
      this.mux.send(this.sessionId, bytes);
    }));
    this.inputDisposables.push(this.term.onResize(({ cols, rows }) => this.mux.resize(this.sessionId, cols, rows)));
  }
}
