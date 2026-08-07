import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import type { IDisposable } from '@xterm/xterm';
import type { TerminalMux, CreateOptions } from './mux';
import { LocalEchoController } from './local-echo';

export interface TerminalProps {
  mux: TerminalMux;
  /** 새 세션 생성 시 사용할 cmd (없으면 기본 쉘) */
  cmd?: string[];
  /** 새 세션 생성 시 시작 cwd (없으면 서버 기본값, 보통 HOME) */
  cwd?: string;
  /** 기존 세션에 재부착할 때의 sessionId */
  attachId?: number;
  /** readwrite (기본) | readonly (입력 차단, 관전 모드) */
  mode?: 'readwrite' | 'readonly';
  /** xterm 폰트 크기 (기본 14) */
  fontSize?: number;
  enableWebgl?: boolean;
  localEcho?: boolean;
  className?: string;
  style?: React.CSSProperties;
  onCreated?: (sessionId: number) => void;
  onExit?: (sessionId: number) => void;
  onBell?: () => void;
}

// flow control 상수
const PAUSE_HIGH = 1024 * 1024; // 1MB pending → PAUSE
const RESUME_LOW = 256 * 1024;  // 256KB remaining → RESUME
const IMMEDIATE_WRITE_BYTES = 512; // small interactive echo should skip the next animation frame

export function Terminal({ mux, cmd, cwd, attachId, mode = 'readwrite', fontSize = 14, enableWebgl = true, localEcho = false, className, style, onCreated, onExit, onBell }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<number | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let disposed = false;
    const disposables: IDisposable[] = [];
    const isReadonly = mode === 'readonly';

    const term = new XTerm({
      cursorBlink: !isReadonly,
      fontSize,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
      disableStdin: isReadonly,
    });

    const fit = new FitAddon();
    let webgl: WebglAddon | undefined;
    termRef.current = term;
    fitRef.current = fit;

    el.style.visibility = 'hidden';
    term.loadAddon(fit);
    term.open(el);
    if (enableWebgl) {
      try {
        webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          // Fallback to canvas renderer on WebGL context loss.
          webgl?.dispose();
          webgl = undefined;
        });
        term.loadAddon(webgl);
      } catch {}
    }
    fit.fit();
    requestAnimationFrame(() => { if (!disposed) el.style.visibility = 'visible'; });

    // --- rAF 기반 write 배치 + flow control ---
    let writeRaf: number | null = null;
    let writeChunks: Uint8Array[] = [];
    let writeBytes = 0;
    let paused = false;
    const localEchoController = new LocalEchoController({
      writeOptimistic: (text) => term.write(text),
      writeOptimisticBackspace: () => term.write('\b \b'),
      requestSnapshot: () => {
        if (sessionRef.current !== null) mux.requestSnapshot(sessionRef.current);
      },
    });
    localEchoController.setEnabled(localEcho && !isReadonly);

    const maybeResumeFlowControl = () => {
      if (paused && writeBytes <= RESUME_LOW && sessionRef.current !== null) {
        mux.resume(sessionRef.current);
        paused = false;
      }
    };

    const flushWrites = () => {
      writeRaf = null;
      if (writeBytes === 0 || disposed) return;

      const merged = new Uint8Array(writeBytes);
      let offset = 0;
      for (const chunk of writeChunks) { merged.set(chunk, offset); offset += chunk.length; }
      writeChunks = [];
      writeBytes = 0;

      term.write(merged, maybeResumeFlowControl);
    };

    const enqueueWrite = (data: Uint8Array) => {
      if (disposed) return;

      if (writeRaf === null && writeBytes === 0 && data.length <= IMMEDIATE_WRITE_BYTES) {
        term.write(data, maybeResumeFlowControl);
        return;
      }

      writeChunks.push(data);
      writeBytes += data.length;

      if (!paused && writeBytes >= PAUSE_HIGH && sessionRef.current !== null) {
        mux.pause(sessionRef.current);
        paused = true;
      }
      if (writeRaf === null) writeRaf = requestAnimationFrame(flushWrites);
    };

    const handleSnapshot = (snapStr: string) => {
      if (disposed) return;
      // Bytes still queued here predate the snapshot — it already contains
      // them, and painting them afterwards would corrupt the fresh screen.
      if (writeRaf !== null) { cancelAnimationFrame(writeRaf); writeRaf = null; }
      writeChunks = [];
      writeBytes = 0;
      // Dropping the queue also drops the write callbacks that would have
      // released flow control — release it here or the stream stays paused.
      if (paused) {
        if (sessionRef.current !== null) mux.resume(sessionRef.current);
        paused = false;
      }
      localEchoController.handleSnapshot();
      // RIS in-band instead of term.reset(): a single write() chunk is parsed
      // atomically in xterm 5.x, so reset and repaint land in one frame — no
      // blank flash between them. reset() would also leave xterm's own
      // pending write buffer unflushed, replaying stale bytes after the clear.
      term.write('\x1bc' + snapStr);
    };

    const wireInput = (id: number) => {
      if (isReadonly) return; // readonly는 입력 안 함
      disposables.push(term.onData((data) => {
        localEchoController.handleLocalInput(data);
        mux.send(id, data);
      }));
      disposables.push(term.onBinary((data) => {
        localEchoController.handleBinaryInput();
        const bytes = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i);
        mux.send(id, bytes);
      }));
      disposables.push(term.onResize(({ cols, rows }) => mux.resize(id, cols, rows)));
    };

    const callbacks = {
      onData: (data: Uint8Array) => {
        const reconciled = localEchoController.reconcileServerData(data);
        if (reconciled.length > 0) enqueueWrite(reconciled);
      },
      onSnapshot: handleSnapshot,
      onExit: () => {
        if (disposed) return;
        if (writeRaf !== null) { cancelAnimationFrame(writeRaf); writeRaf = null; }
        if (sessionRef.current !== null) onExitRef.current?.(sessionRef.current);
      },
    };

    disposables.push(term.onBell(() => onBell?.()));

    if (attachId !== undefined) {
      mux.attachSession(attachId, callbacks, {
        cols: term.cols,
        rows: term.rows,
        mode,
      }).then((info) => {
        if (disposed) { mux.detachSession(attachId); return; }
        sessionRef.current = info.id;
        onCreated?.(info.id);
        wireInput(info.id);
      }).catch(() => {
        if (!disposed) term.write('\r\n\x1b[31m[failed to attach session]\x1b[0m\r\n');
      });
    } else {
      const opts: CreateOptions = { cmd, cwd, cols: term.cols, rows: term.rows };
      mux.createSession(opts, callbacks).then((id) => {
        if (disposed) { mux.detachSession(id); return; }
        sessionRef.current = id;
        onCreated?.(id);
        wireInput(id);
      }).catch(() => {
        if (!disposed) term.write('\r\n\x1b[31m[failed to create session]\x1b[0m\r\n');
      });
    }

    // --- Page Visibility API ---
    const onVisibilityChange = () => {
      if (sessionRef.current === null) return;
      if (document.hidden) {
        mux.pauseView(sessionRef.current);
      } else {
        mux.resumeView(sessionRef.current);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    // auto-fit
    const ro = new ResizeObserver(() => {
      if (!disposed && el.isConnected) {
        try { fit.fit(); } catch {}
      }
    });
    ro.observe(el);

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (writeRaf !== null) cancelAnimationFrame(writeRaf);
      ro.disconnect();
      for (const d of disposables) d.dispose();
      if (sessionRef.current !== null) {
        mux.detachSession(sessionRef.current);
      }
      webgl?.dispose();
      fit.dispose();
      term.dispose();
      fitRef.current = null;
      termRef.current = null;
    };
  }, [mux, cmd, cwd, attachId, mode, enableWebgl, localEcho]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (term.options.fontSize === fontSize) return;

    term.options.fontSize = fontSize;
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
        term.refresh(0, Math.max(0, term.rows - 1));
      } catch {}
    });
  }, [fontSize]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: '100%', height: '100%', ...style }}
    />
  );
}
