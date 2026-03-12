import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import type { IDisposable } from '@xterm/xterm';
import type { TerminalMux, CreateOptions } from './mux';

export interface TerminalProps {
  mux: TerminalMux;
  cmd?: string[];
  className?: string;
  style?: React.CSSProperties;
  onCreated?: (sessionId: number) => void;
  onExit?: (sessionId: number) => void;
}

// flow control 상수
const PAUSE_HIGH = 1024 * 1024; // 1MB pending → PAUSE
const RESUME_LOW = 256 * 1024;  // 256KB remaining → RESUME

export function Terminal({ mux, cmd, className, style, onCreated, onExit }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<number | null>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let disposed = false;
    const disposables: IDisposable[] = [];

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
    });

    const fit = new FitAddon();
    let webgl: WebglAddon | undefined;

    el.style.visibility = 'hidden';
    term.loadAddon(fit);
    term.open(el);
    try { webgl = new WebglAddon(); term.loadAddon(webgl); } catch {}
    fit.fit();
    // 초기화 완료 후 한 프레임 뒤에 표시 — 슬라이드 방지
    requestAnimationFrame(() => { if (!disposed) el.style.visibility = 'visible'; });

    // --- rAF 기반 write 배치 + flow control ---
    let writeRaf: number | null = null;
    let writeChunks: Uint8Array[] = [];
    let writeBytes = 0;
    let paused = false;

    const flushWrites = () => {
      writeRaf = null;
      if (writeBytes === 0 || disposed) return;

      const merged = new Uint8Array(writeBytes);
      let offset = 0;
      for (const chunk of writeChunks) { merged.set(chunk, offset); offset += chunk.length; }
      writeChunks = [];
      writeBytes = 0;

      term.write(merged, () => {
        if (paused && writeBytes <= RESUME_LOW && sessionRef.current !== null) {
          mux.resume(sessionRef.current);
          paused = false;
        }
      });
    };

    const enqueueWrite = (data: Uint8Array) => {
      if (disposed) return;
      writeChunks.push(data);
      writeBytes += data.length;

      if (!paused && writeBytes >= PAUSE_HIGH && sessionRef.current !== null) {
        mux.pause(sessionRef.current);
        paused = true;
      }
      if (writeRaf === null) writeRaf = requestAnimationFrame(flushWrites);
    };

    // create session
    const opts: CreateOptions = { cmd, cols: term.cols, rows: term.rows };
    mux.createSession(opts, {
      onData: enqueueWrite,
      onExit: () => {
        console.log(`[term] onExit called disposed=${disposed} session=${sessionRef.current} hasOnExitRef=${!!onExitRef.current}`);
        if (disposed) return;
        if (writeRaf !== null) { cancelAnimationFrame(writeRaf); writeRaf = null; }
        if (sessionRef.current !== null) onExitRef.current?.(sessionRef.current);
        console.log(`[term] onExitRef called done`);
      },
    }).then((id) => {
      if (disposed) { mux.destroySession(id); return; }

      sessionRef.current = id;
      console.log(`[term] session created id=${id}`);
      onCreated?.(id);

      disposables.push(term.onData((data) => mux.send(id, data)));
      disposables.push(term.onBinary((data) => {
        const bytes = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i);
        mux.send(id, bytes);
      }));
      disposables.push(term.onResize(({ cols, rows }) => mux.resize(id, cols, rows)));
    }).catch(() => {
      if (!disposed) term.write('\r\n\x1b[31m[failed to create session]\x1b[0m\r\n');
    });

    // auto-fit
    const ro = new ResizeObserver(() => {
      if (!disposed && el.isConnected) {
        try { fit.fit(); } catch {}
      }
    });
    ro.observe(el);

    return () => {
      disposed = true;
      if (writeRaf !== null) cancelAnimationFrame(writeRaf);
      ro.disconnect();
      for (const d of disposables) d.dispose();
      if (sessionRef.current !== null) mux.destroySession(sessionRef.current);
      webgl?.dispose();
      fit.dispose();
      term.dispose();
    };
  }, [mux]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: '100%', height: '100%', ...style }}
    />
  );
}
