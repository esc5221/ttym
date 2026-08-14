import { useEffect, useRef } from 'react';
import type { TerminalMux, CreateOptions } from '@ttym/vt';
import { acquireHost, destroyHost, type TerminalHost, type HostOptions } from './terminal-host.js';

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
  /**
   * GPU 렌더러 사용 여부. 프리뷰·그리드처럼 다수가 동시에 뜨는 자리는 false로 —
   * GPU 컨텍스트는 포커스된 큰 터미널 전용 자원이다.
   */
  enableWebgl?: boolean;
  localEcho?: boolean;
  /** fit(기본) | follow — follow는 서버 기하 추종, resize를 절대 보내지 않는다 (모바일). */
  geometry?: 'fit' | 'follow';
  className?: string;
  style?: React.CSSProperties;
  onCreated?: (sessionId: number) => void;
  onExit?: (sessionId: number) => void;
  onBell?: () => void;
}

/**
 * Thin shell over a TerminalHost. The xterm instance lives in the host
 * registry keyed by session id and survives this component: unmounting
 * reparents the DOM out and drops the stream, nothing is disposed. Scrollback
 * and renderer state are wherever the session is next displayed.
 */
export function Terminal({ mux, cmd, cwd, attachId, mode = 'readwrite', fontSize = 14, enableWebgl = true, localEcho = false, geometry = 'fit', className, style, onCreated, onExit, onBell }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<TerminalHost | null>(null);
  const onExitRef = useRef(onExit);
  const onBellRef = useRef(onBell);
  const onCreatedRef = useRef(onCreated);
  onExitRef.current = onExit;
  onBellRef.current = onBell;
  onCreatedRef.current = onCreated;
  const optsRef = useRef<HostOptions>({ mode, fontSize, enableWebgl, localEcho, geometry });
  optsRef.current = { mode, fontSize, enableWebgl, localEcho, geometry };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let cancelled = false;
    let io: IntersectionObserver | null = null;
    let intersecting = false;

    const syncViewState = () => {
      const host = hostRef.current;
      if (!host) return;
      if (intersecting && !document.hidden) {
        // Lazy open: the renderer, GPU context and stream subscription exist
        // only once the terminal has actually been on screen.
        host.activate();
        host.resumeView();
      } else {
        host.pauseView();
      }
    };

    const onVisibilityChange = () => syncViewState();

    const start = (sessionId: number) => {
      if (cancelled) return;
      const host = acquireHost(mux, sessionId, optsRef.current);
      hostRef.current = host;
      host.mount(el, (action) => {
        switch (action.kind) {
          case 'session-exit':
            destroyHost(action.sessionId);
            hostRef.current = null;
            onExitRef.current?.(action.sessionId);
            break;
          case 'bell':
            onBellRef.current?.();
            break;
        }
      });
      io = new IntersectionObserver((entries) => {
        intersecting = entries.some((entry) => entry.isIntersecting);
        syncViewState();
      });
      io.observe(el);
      document.addEventListener('visibilitychange', onVisibilityChange);
      onCreatedRef.current?.(sessionId);
    };

    if (attachId !== undefined) {
      start(attachId);
    } else {
      const opts: CreateOptions = { cmd, cwd, cols: 80, rows: 24 };
      mux.createSession(opts, { onData: () => {}, onExit: () => {} }).then((id) => {
        mux.detachSession(id);
        start(id);
      }).catch(() => {});
    }

    return () => {
      cancelled = true;
      io?.disconnect();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      hostRef.current?.unmount();
      hostRef.current = null;
    };
  }, [mux, attachId, cmd, cwd]);

  useEffect(() => {
    hostRef.current?.applyOptions({ mode, fontSize, enableWebgl, localEcho, geometry });
  }, [mode, fontSize, enableWebgl, localEcho]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: '100%', height: '100%', ...style }}
    />
  );
}
