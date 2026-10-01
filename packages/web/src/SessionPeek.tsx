import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as api from '@ttym/api';
import type { ScreenRun, ScreenTail } from '@ttym/api';
import { setSessionLinkHandler } from '@ttym/ui';
import { xterm256Color } from '@ttym/vt';
import { API_BASE, sessionWorkspaceMembership, type AgentState, type Workspace } from './app-shared.js';
import { routeToHash } from './route.js';

/**
 * 터미널 글자 속 `%1297`에 마우스를 올리면 그 세션 화면의 아래 몇 줄을 띄운다. 누르면 새 탭에서
 * 그 세션이 속한 workspace의 zen으로 연다.
 *
 * 터미널을 붙이지 않고 서버가 들고 있는 화면을 읽기만 한다(`/screen?format=tail`). 붙이면
 * 그 세션의 크기를 이 창이 바꾸거나, 같은 탭에 이미 떠 있는 pane과 터미널 객체를 다툰다.
 * 대신 떠 있는 동안 1초마다 다시 읽는다.
 */

const ROWS = 12;
const WIDTH = 640;
const SHOW_DELAY_MS = 300;
const HIDE_DELAY_MS = 200;
const REFRESH_MS = 1000;

interface Anchor { sid: number; x: number; y: number }

export function SessionPeek({ workspaces, agentStates }: { workspaces: Workspace[]; agentStates: Record<number, AgentState> }) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [tail, setTail] = useState<(ScreenTail & { sleep?: unknown }) | null>(null);
  const [missing, setMissing] = useState(false);
  const showTimer = useRef<number | undefined>(undefined);
  const hideTimer = useRef<number | undefined>(undefined);
  const overPopover = useRef(false);
  // 핸들러는 한 번만 건다. 누른 순간의 workspace 목록은 ref로 읽는다.
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;

  useEffect(() => {
    const clear = () => { window.clearTimeout(showTimer.current); window.clearTimeout(hideTimer.current); };
    setSessionLinkHandler({
      open: (sid) => {
        clear();
        setAnchor(null);
        // workspace에 속한 세션이면 그 workspace의 zen으로 연다 — Esc 한 번에 workspace 전체로
        // 나갈 수 있고, zen은 폭을 빌렸다가 떠날 때 돌려준다. 속한 곳이 없으면 세션 단독 화면.
        // 주소는 지금 것 그대로 쓴다 — getSessionUrl은 공유용이라 http에서 lan 주소로 바꿔 버린다.
        const ws = sessionWorkspaceMembership(workspacesRef.current).get(sid)?.workspace;
        const hash = ws ? routeToHash({ page: 'workspace', id: ws.id, zen: sid }) : routeToHash({ page: 'session', id: sid });
        window.open(`${location.origin}${location.pathname}#${hash}`, '_blank', 'noopener');
      },
      hover: (sid, event) => {
        clear();
        const next = { sid, x: event.clientX, y: event.clientY };
        showTimer.current = window.setTimeout(() => setAnchor(next), SHOW_DELAY_MS);
      },
      leave: () => {
        clear();
        hideTimer.current = window.setTimeout(() => { if (!overPopover.current) setAnchor(null); }, HIDE_DELAY_MS);
      },
    });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setAnchor(null); };
    window.addEventListener('keydown', onKey);
    return () => { clear(); setSessionLinkHandler(null); window.removeEventListener('keydown', onKey); };
  }, []);

  const sid = anchor?.sid ?? null;
  useEffect(() => {
    setTail(null);
    setMissing(false);
    if (sid === null) return;
    let alive = true;
    const load = async () => {
      try {
        const next = await api.getSessionScreenTail(API_BASE, sid, ROWS);
        if (alive) { setTail(next); setMissing(false); }
      } catch {
        if (alive) setMissing(true);
      }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, REFRESH_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, [sid]);

  if (!anchor) return null;

  const where = sessionWorkspaceMembership(workspaces).get(anchor.sid);
  const state = agentStates[anchor.sid];
  const status = tail?.sleep || state?.sleep ? 'asleep'
    : state?.waiting ? `waiting: ${state.waiting}`
    : state?.active ? 'working'
    : state?.kind ? 'idle' : null;

  // 서버 폭(cols)이 한 줄에 들어가게 글자를 줄인다. 고정폭 글자 하나 ≈ 0.6em.
  const cols = tail?.cols ?? 120;
  const fontSize = Math.max(7, Math.min(12, (WIDTH - 20) / (cols * 0.6)));
  const height = ROWS * fontSize * 1.25 + 44;

  // 커서 오른쪽 아래, 화면 밖으로 나가면 반대편으로.
  const left = Math.max(8, Math.min(anchor.x + 12, window.innerWidth - WIDTH - 8));
  const below = anchor.y + 18;
  const top = below + height < window.innerHeight - 8 ? below : Math.max(8, anchor.y - 12 - height);

  return createPortal(
    <div
      onMouseEnter={() => { overPopover.current = true; window.clearTimeout(hideTimer.current); }}
      onMouseLeave={() => { overPopover.current = false; setAnchor(null); }}
      style={{
        position: 'fixed', left, top, width: WIDTH, zIndex: 1000,
        background: 'var(--bg1)', border: '1px solid var(--line-strong)', borderRadius: 8,
        boxShadow: '0 8px 28px rgba(0,0,0,.35)', overflow: 'hidden', fontFamily: 'var(--mono)',
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px', fontSize: 11, color: 'var(--text-soft)', borderBottom: '1px solid var(--line)' }}>
        <span style={{ color: 'var(--text)', fontWeight: 700 }}>%{anchor.sid}</span>
        {where ? <span>{where.workspace.name}:{where.memberName ?? '?'}</span> : null}
        {status ? <span style={{ color: status === 'working' ? 'var(--ok)' : status.startsWith('waiting') ? 'var(--warn)' : 'var(--text-dim)' }}>{status}</span> : null}
        <span style={{ marginLeft: 'auto', color: 'var(--text-dim)' }}>click: new tab</span>
      </div>
      <div style={{ background: 'var(--term-bg)', padding: '6px 10px', fontSize, lineHeight: 1.25, minHeight: ROWS * fontSize * 1.25, whiteSpace: 'pre', overflow: 'hidden', color: 'var(--term-fg)' }}>
        {missing ? <span style={{ color: 'var(--text-dim)' }}>no such session</span>
          : !tail ? <span style={{ color: 'var(--text-dim)' }}>…</span>
          : tail.rows.map((row, i) => <div key={i}>{row.length ? row.map((run, j) => <Run key={j} run={run} />) : ' '}</div>)}
      </div>
    </div>,
    document.body,
  );
}

function Run({ run }: { run: ScreenRun }) {
  const style: React.CSSProperties = {};
  if (run.fg) style.color = css(run.fg);
  if (run.bg) style.background = css(run.bg);
  if (run.b) style.fontWeight = 700;
  if (run.i) style.fontStyle = 'italic';
  if (run.u) style.textDecoration = 'underline';
  if (run.d) style.opacity = 0.6;
  return <span style={style}>{run.t}</span>;
}

function css(color: string): string {
  if (color === 'inv-fg') return 'var(--term-fg)';
  if (color === 'inv-bg') return 'var(--term-bg)';
  if (color.startsWith('p')) return xterm256Color(parseInt(color.slice(1), 10));
  return color;
}
