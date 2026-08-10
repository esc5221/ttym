import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
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
function queueActivation(run: () => void) {
  activationChain = activationChain.then(() => {
    run();
    return new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
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

export class TerminalHost {
  readonly wrapper: HTMLDivElement;
  readonly term: XTerm;
  private readonly fit: FitAddon;
  private webgl: WebglAddon | undefined;
  private opts: HostOptions;
  private disposed = false;
  private opened = false;
  private connected = false;
  private viewPaused = false;
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
      cursorBlink: opts.mode !== 'readonly',
      fontSize: opts.fontSize,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: terminalTheme(),
      disableStdin: opts.mode === 'readonly',
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);

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
    if (this.disposed || this.connected) return;
    if (!this.opened) {
      this.opened = true;
      this.wrapper.style.visibility = 'hidden';
      this.term.open(this.wrapper);
      this.maybeEnableWebgl();
      try { this.fit.fit(); } catch {}
      requestAnimationFrame(() => { if (!this.disposed) this.wrapper.style.visibility = 'visible'; });
    }
    this.connected = true;
    queueActivation(() => {
      if (this.disposed || !this.connected) return;
      this.doAttach();
    });
  }

  private doAttach() {
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
      if (this.disposed || !this.connected) { this.mux.detachSession(this.sessionId); return; }
      this.wireInput();
    }).catch(() => {
      if (!this.disposed) this.term.write('\r\n\x1b[31m[failed to attach session]\x1b[0m\r\n');
    });
  }

  /** Detach from the stream without touching the terminal or its buffer. */
  disconnect() {
    if (!this.connected) return;
    this.connected = false;
    this.viewPaused = false;
    for (const d of this.inputDisposables) d.dispose();
    this.inputDisposables = [];
    this.mux.detachSession(this.sessionId);
  }

  /** Out of viewport (or tab hidden): stop the stream, keep everything else. */
  pauseView() {
    if (!this.connected || this.viewPaused) return;
    this.viewPaused = true;
    this.mux.pauseView(this.sessionId);
  }

  /** Back in view: resume from the last seq — delta replay, or one snapshot. */
  resumeView() {
    if (!this.connected || !this.viewPaused) return;
    this.viewPaused = false;
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
