import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TerminalMux, Terminal, LayoutView, refreshTerminalThemes } from '@ttym/ui';
import { ansiToHtml } from '@ttym/vt';
import * as api from '@ttym/api';
import type { SessionInfo } from '@ttym/ui';
import '@xterm/xterm/css/xterm.css';
import {
  MutationBarrier,
  formatCwd,
  layoutToSessionIds,
  memberNameBySession,
  removePane,
  resizeSplit,
  swapPanes,
  workspaceLabel,
  type LayoutNode,
} from '@ttym/shared';

/** crypto.randomUUID fallback for non-secure contexts (HTTP over LAN) */
function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ───── Workspace 타입 + Server API ─────

interface WorkspaceMember {
  sessionId: number;
  name: string;
  role?: string;
  tags?: string[];
  createdAt?: number;
  updatedAt?: number;
}

interface SessionMeta {
  cwd?: string | null;
  [key: string]: unknown;
}

interface PanelState {
  key: string;
  sessionId?: number;
  memberName?: string;
  cwd?: string;
  dead?: boolean;
}

interface Workspace {
  id: string;
  project: string;
  name: string;
  layout: LayoutNode;
  members: WorkspaceMember[];
  createdAt: number;
  updatedAt: number;
}

const LOCAL_ECHO_STORAGE_KEY = 'ttym-demo-local-echo';

// UI 스타일: frame(기본) = bg0 들판 + 라운드 프레임 + dim 포커스,
// classic = bg2 크롬 바 + 좌측 포커스 바. 차이는 전부 이 테이블 한 곳에 산다.
type UiStyle = 'frame' | 'classic';

// 데스크톱 셸(Tauri)이 주입하는 마커 — 순수 데이터, IPC 없음.
// 감지되면 트래픽라이트 자리를 비우고 스트립을 창 드래그 영역으로 쓴다.
const IS_NATIVE = typeof (window as unknown as { __TTYM_NATIVE__?: unknown }).__TTYM_NATIVE__ !== 'undefined';
const UI_STYLE_STORAGE_KEY = 'ttym-ui-style';

const UI_STYLES = {
  frame: {
    stripBg: 'var(--bg0)',
    stripLine: 'none',
    tabActiveBg: 'var(--bg2)',
    wrapPad: 5,
    splitterPx: 6,
    splitterColor: 'transparent',
    paneRadius: 6,
    termPad: '0 6px 6px',
    frameBorder: true,
    headerBar: false,
  },
  classic: {
    stripBg: 'var(--bg2)',
    stripLine: '1px solid var(--line)',
    tabActiveBg: 'var(--bg0)',
    wrapPad: 0,
    splitterPx: 5,
    splitterColor: 'var(--line)',
    paneRadius: 0,
    termPad: '0',
    frameBorder: false,
    headerBar: true,
  },
} as const;

function readUiStyle(): UiStyle {
  try { return localStorage.getItem(UI_STYLE_STORAGE_KEY) === 'classic' ? 'classic' : 'frame'; } catch { return 'frame'; }
}

// 에이전트 식별색 — 정체는 이름의 색, 활동은 4px 점. 필 배지는 쓰지 않는다.
const AGENT_COLORS: Record<string, string> = { 'claude-code': 'var(--agent-claude)', codex: 'var(--agent-codex)' };

interface AgentState { kind: 'claude-code' | 'codex' | null; active: boolean }
interface AgentTurn { sid: number; prompt: string; transcript: string | null; status: string }

function readLocalEchoEnabled(): boolean {
  try {
    return window.localStorage.getItem(LOCAL_ECHO_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeLocalEchoEnabled(value: boolean) {
  try {
    window.localStorage.setItem(LOCAL_ECHO_STORAGE_KEY, value ? '1' : '0');
  } catch {}
}

/** Derive ttym server host from current page URL */
function getTtymHost(): string {
  const h = window.location.hostname;
  // ttym-ui.lullu.lan → ttym.lullu.lan (Caddy proxy, port 80)
  if (h.startsWith('ttym-ui.')) return `ttym.${h.slice(8)}`;
  // tunnel or same-origin proxy → use current host (Vite proxies /api and /ws)
  if (h.startsWith('ttym.') || h === 'localhost' || h === '127.0.0.1') return window.location.host;
  // fallback: same host, port 7690
  return `${h}:7690`;
}
const TTYM_HOST = getTtymHost();
const isSecure = window.location.protocol === 'https:';
const API_BASE = `${isSecure ? 'https' : 'http'}://${TTYM_HOST}`;

function getTtymUiBase(): string {
  const { protocol, hostname } = window.location;
  if (hostname.startsWith('ttym-ui.')) return `${protocol}//${hostname}`;
  if (hostname.startsWith('ttym.')) return `${protocol}//ttym-ui.${hostname.slice(5)}`;
  return 'http://ttym-ui.lullu.lan';
}

function getSessionUrl(sessionId: number): string {
  return `${getTtymUiBase()}/#s/${sessionId}`;
}

async function copySessionUrl(sessionId: number) {
  const url = getSessionUrl(sessionId);
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(url);
    return;
  }

  const input = document.createElement('input');
  input.value = url;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  document.execCommand('copy');
  document.body.removeChild(input);
}

async function fetchSessionMeta(sessionId: number): Promise<SessionMeta> {
  return api.getSessionMeta(API_BASE, sessionId);
}

async function fetchSessionScreen(sessionId: number): Promise<string> {
  return api.getSessionScreen(API_BASE, sessionId);
}

async function fetchWorkspaces(): Promise<Workspace[]> {
  try {
    return await api.listWorkspaces(API_BASE) as Workspace[];
  } catch { return []; }
}

async function apiCreateWorkspace(ws: { id: string; name: string; layout: LayoutNode }): Promise<Workspace | null> {
  try {
    return await api.createWorkspace(API_BASE, { id: ws.id, name: ws.name, layout: ws.layout }) as Workspace;
  } catch { return null; }
}

function workspaceDisplayLabel(workspace: Workspace): string {
  return workspaceLabel(workspace.project, workspace.name);
}

function memberLabel(name: string | undefined, sessionId: number): string {
  return name ? `${name} · #${sessionId}` : `#${sessionId}`;
}

function sessionWorkspaceMembership(workspaces: Workspace[]): Map<number, { workspace: Workspace; memberName?: string }> {
  const membership = new Map<number, { workspace: Workspace; memberName?: string }>();
  for (const workspace of workspaces) {
    const names = memberNameBySession(workspace.members);
    for (const sessionId of layoutToSessionIds(workspace.layout).filter((id) => id > 0)) {
      membership.set(sessionId, { workspace, memberName: names.get(sessionId) });
    }
  }
  return membership;
}

async function apiUpdateWorkspace(id: string, patch: { name?: string; layout?: LayoutNode }): Promise<void> {
  try {
    await api.updateWorkspace(API_BASE, id, patch);
  } catch {}
}

async function apiDeleteWorkspace(id: string): Promise<void> {
  try {
    await api.deleteWorkspace(API_BASE, id);
  } catch {}
}

async function apiRemoveMember(wsId: string, sessionId: number): Promise<void> {
  try {
    await api.removeWorkspaceMember(API_BASE, wsId, sessionId);
  } catch {}
}

async function apiAddMember(
  wsId: string,
  sessionId: number,
  name: string,
): Promise<Workspace | null> {
  try {
    return await api.addWorkspaceMember(API_BASE, wsId, { sessionId, name }) as Workspace;
  } catch { return null; }
}

async function apiSplitWorkspace(
  id: string,
  options: { targetSessionId?: number; cwd?: string; cols?: number; rows?: number; name?: string; role?: string; cmd?: string[]; direction?: 'right' | 'left' | 'down' | 'up' } = {},
): Promise<Workspace | null> {
  try {
    const data = await api.splitWorkspace(API_BASE, id, options);
    return (data?.workspace as Workspace) ?? null;
  } catch { return null; }
}

// ───── 해시 라우팅 ─────

type Route =
  | { page: 'dashboard' }
  | { page: 'overview' }
  | { page: 'session'; id: number }
  | { page: 'viewer'; id: number }
  | { page: 'workspace'; id: string };

function parseHash(): Route {
  const hash = window.location.hash;
  if (hash === '#overview') return { page: 'overview' };
  const sessionMatch = hash.match(/^#s\/(\d+)$/);
  if (sessionMatch) return { page: 'session', id: parseInt(sessionMatch[1], 10) };
  const viewerMatch = hash.match(/^#v\/(\d+)$/);
  if (viewerMatch) return { page: 'viewer', id: parseInt(viewerMatch[1], 10) };
  const wsMatch = hash.match(/^#w\/(.+)$/);
  if (wsMatch) return { page: 'workspace', id: wsMatch[1] };
  return { page: 'dashboard' };
}

function navigate(route: Route) {
  switch (route.page) {
    case 'dashboard': window.location.hash = ''; break;
    case 'overview': window.location.hash = 'overview'; break;
    case 'session': window.location.hash = `s/${route.id}`; break;
    case 'viewer': window.location.hash = `v/${route.id}`; break;
    case 'workspace': window.location.hash = `w/${route.id}`; break;
  }
}

// ───── 대시보드 ─────

type DashPanel = { kind: 'hover' } | { kind: 'live'; sid: number } | { kind: 'ws'; wsId: string };

function DashboardPage({ mux, agentStates, localEchoEnabled, actionsSlot }: { mux: TerminalMux; agentStates: Record<number, AgentState>; localEchoEnabled: boolean; actionsSlot: HTMLElement | null }) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [sessionCwds, setSessionCwds] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [hoveredSessionId, setHoveredSessionId] = useState<number | null>(null);
  const [hoveredScreen, setHoveredScreen] = useState<string>('hover a session to preview');
  const [compactLayout, setCompactLayout] = useState(() => window.innerWidth < 1080);
  // 우측 패널: hover 미리보기 ↔ live 터미널(행 클릭) ↔ workspace 분할 미니뷰(제목 클릭)
  const [panel, setPanel] = useState<DashPanel>({ kind: 'hover' });
  const [hoveredWsId, setHoveredWsId] = useState<string | null>(null);
  // 모핑 하이라이트: 행별 배경 대신 리스트에 단 하나 떠 있는 박스가
  // hover 대상의 rect로 미끄러진다. variant가 곧 "무엇을 보고 있나"다.
  const listRef = useRef<HTMLDivElement | null>(null);
  const [hl, setHl] = useState<{ top: number; left: number; width: number; height: number; variant: 'row' | 'ws'; visible: boolean }>(
    { top: 0, left: 0, width: 0, height: 0, variant: 'row', visible: false },
  );

  const moveHl = useCallback((el: HTMLElement, variant: 'row' | 'ws') => {
    const container = listRef.current;
    if (!container) return;
    const cRect = container.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    setHl({
      top: rect.top - cRect.top + container.scrollTop,
      left: rect.left - cRect.left,
      width: rect.width,
      height: rect.height,
      variant,
      visible: true,
    });
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [list, wsList] = await Promise.all([mux.listSessions(), fetchWorkspaces()]);
      const live = list.filter((s) => s.status !== 'dead');
      setSessions(live);
      setWorkspaces(wsList);
      const cwdEntries = await Promise.all(live.map(async (session) => {
        try {
          const meta = await fetchSessionMeta(session.id);
          return [session.id, typeof meta.cwd === 'string' ? meta.cwd : ''] as const;
        } catch {
          return [session.id, ''] as const;
        }
      }));
      setSessionCwds(Object.fromEntries(cwdEntries.filter(([, cwd]) => cwd)));
    } catch {}
    setLoading(false);
  }, [mux]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    return mux.onWorkspace((event) => {
      setWorkspaces((prev) => {
        if (event.deletedId) return prev.filter((w) => w.id !== event.deletedId);
        const next = event.workspace as unknown as Workspace | undefined;
        if (!next) return prev;
        const at = prev.findIndex((w) => w.id === next.id);
        if (at === -1) return [...prev, next];
        const copy = prev.slice(); copy[at] = next; return copy;
      });
    });
  }, [mux]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 1080px)');
    const sync = () => setCompactLayout(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (sessions.length === 0) {
      setHoveredSessionId(null);
      setHoveredScreen('hover a session to preview');
      return;
    }
    if (hoveredSessionId === null || !sessions.some((session) => session.id === hoveredSessionId)) {
      setHoveredSessionId(sessions[0]!.id);
    }
  }, [sessions, hoveredSessionId]);

  useEffect(() => {
    if (hoveredSessionId === null || panel.kind !== 'hover') return;
    let cancelled = false;
    const tick = async () => {
      try {
        const screen = await fetchSessionScreen(hoveredSessionId);
        if (!cancelled) setHoveredScreen(screen || 'no output yet');
      } catch {
        if (!cancelled) setHoveredScreen('preview unavailable');
      }
    };
    void tick();
    const timer = window.setInterval(() => { void tick(); }, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [hoveredSessionId, panel.kind]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPanel({ kind: 'hover' });
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // 죽은 세션은 membership만 걷어낸다 — 트리 정리는 서버 몫.
  useEffect(() => {
    if (loading || sessions.length === 0) return;
    const aliveIds = new Set(sessions.map((s) => s.id));
    let changed = false;
    for (const ws of workspaces) {
      for (const id of layoutToSessionIds(ws.layout)) {
        if (id > 0 && !aliveIds.has(id)) {
          void apiRemoveMember(ws.id, id);
          ws.layout = removePane(ws.layout, id);
          changed = true;
        }
      }
    }
    if (changed) setWorkspaces([...workspaces]);
  }, [sessions, loading]);

  const createSession = useCallback(async () => {
    try {
      const id = await mux.createSession({ cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });
      mux.detachSession(id);
      navigate({ page: 'session', id });
    } catch (e) {
      console.error('Failed to create session:', e);
    }
  }, [mux]);

  const terminateSession = useCallback(async (sid: number, wsId?: string) => {
    mux.destroySession(sid);
    if (wsId) await apiRemoveMember(wsId, sid);
    await refresh();
  }, [mux, refresh]);

  const deleteWorkspaceCascade = useCallback(async (ws: Workspace) => {
    for (const sid of layoutToSessionIds(ws.layout).filter((id) => id > 0)) mux.destroySession(sid);
    await apiDeleteWorkspace(ws.id);
    await refresh();
  }, [mux, refresh]);

  const aliveIds = new Set(sessions.map((s) => s.id));
  const assigned = new Set(workspaces.flatMap((w) => layoutToSessionIds(w.layout).filter((id) => id > 0)));
  const standalone = sessions.filter((s) => !assigned.has(s.id));
  const infoBySession = new Map(sessions.map((s) => [s.id, s] as const));

  const sessionRow = (sid: number, name?: string, wsId?: string) => {
    const info = infoBySession.get(sid);
    const agent = agentStates[sid];
    const color = agent?.kind ? AGENT_COLORS[agent.kind] : undefined;
    const selected = panel.kind === 'live' && panel.sid === sid;
    return (
      <div
        key={sid}
        className="reveal-parent"
        onClick={() => setPanel({ kind: 'live', sid })}
        onMouseEnter={(e) => { setHoveredSessionId(sid); setHoveredWsId(null); moveHl(e.currentTarget, 'row'); }}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px',
          borderRadius: 8, cursor: 'pointer', minWidth: 0,
          borderLeft: selected ? '2px solid var(--accent)' : '2px solid transparent',
          background: selected ? 'var(--hl)' : undefined,
        }}
      >
        <span
          className={agent?.active ? 'agent-dot-run' : undefined}
          style={{ width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
                   background: color ?? 'transparent', opacity: agent?.active ? 1 : 0.4 }}
        />
        <span style={{ color: 'var(--text-dim)', fontSize: 11, minWidth: 24, flexShrink: 0 }}>#{sid}</span>
        <span style={{ color: color ?? 'var(--text)', fontWeight: 600, fontSize: 12, flexShrink: 0 }}>
          {name ?? '—'}
        </span>
        <span style={{ color: 'var(--text-dim)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {(sessionCwds[sid] ? `${formatCwd(sessionCwds[sid])} · ` : '') + (info ? info.cmd.join(' ') : '')}
        </span>
        <button
          className="reveal"
          onClick={(e) => { e.stopPropagation(); void terminateSession(sid, wsId); }}
          style={{ ...closeBtnStyle, marginLeft: 0, flexShrink: 0 }}
          title="세션 종료"
        >×</button>
      </div>
    );
  };

  // workspace 분할 미니뷰 — 고정(ws)과 hover 양쪽에서 쓴다.
  const renderWsMini = (wsId: string) => {
    const target = workspaces.find((x) => x.id === wsId);
    if (!target) return <div style={{ color: 'var(--text-dim)', padding: 20, fontSize: 12 }}>workspace가 사라졌다</div>;
    const names = memberNameBySession(target.members);
    return (
      <div style={{ flex: 1, minHeight: 0 }}>
        <LayoutView
          layout={target.layout}
          splitterColor="var(--line)"
          splitterActiveColor="var(--accent)"
          renderPane={(sid) => sid <= 0 ? (
            <div key="empty" style={{ ...emptyPaneStyle, fontSize: 11 }}>empty</div>
          ) : (
            <div key={sid} style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
              <div
                onClick={() => setPanel({ kind: 'live', sid })}
                title="클릭: live로 전환"
                style={{ display: 'flex', alignItems: 'center', gap: 6, height: 22, padding: '0 8px', background: 'var(--bg2)', borderBottom: '1px solid var(--line)', fontSize: 10, cursor: 'pointer', flexShrink: 0 }}
              >
                <span style={{ color: agentStates[sid]?.kind ? AGENT_COLORS[agentStates[sid]!.kind!] : 'var(--text-soft)', fontWeight: 700 }}>
                  {names.get(sid) || `#${sid}`}
                </span>
                <span style={{ color: 'var(--text-dim)' }}>#{sid}</span>
              </div>
              <div style={{ flex: 1, minHeight: 0, pointerEvents: 'none' }}>
                <Terminal mux={mux} attachId={sid} mode="readonly" fontSize={10} enableWebgl={false} />
              </div>
            </div>
          )}
        />
      </div>
    );
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: compactLayout ? 'minmax(0, 1fr)' : 'minmax(360px, 460px) minmax(0, 1fr)', fontFamily: 'monospace' }}>
      <div
        ref={listRef}
        onMouseLeave={() => setHl((prev) => ({ ...prev, visible: false }))}
        onScroll={() => setHl((prev) => (prev.visible ? { ...prev, visible: false } : prev))}
        style={{ borderRight: compactLayout ? 'none' : '1px solid var(--line)', background: 'var(--bg1)', padding: 14, overflowY: 'auto', minHeight: 0, position: 'relative' }}
      >
        <div
          className="morph-hl"
          style={{
            position: 'absolute',
            top: hl.top,
            left: hl.left,
            width: hl.width,
            height: hl.height,
            borderRadius: hl.variant === 'ws' ? 10 : 8,
            // 콘텐츠 위에 얹는 베일 — 카드가 불투명해도 항상 보인다.
            background: 'var(--hl)',
            border: hl.variant === 'ws' ? '1px solid var(--accent-dim)' : '1px solid transparent',
            opacity: hl.visible ? 1 : 0,
            zIndex: 1,
            pointerEvents: 'none',
          }}
        />
        {actionsSlot ? createPortal(
          <>
            <button onClick={createSession} style={stripBtnStyle}>+ session</button>
            <button onClick={refresh} style={stripBtnStyle} title="refresh">↻</button>
          </>, actionsSlot) : null}

        {loading && workspaces.length === 0 ? (
          <div style={{ color: 'var(--text-dim)', fontSize: 12, padding: 8 }}>loading…</div>
        ) : null}

        {workspaces.map((ws) => {
          const ids = layoutToSessionIds(ws.layout).filter((id) => id > 0 && aliveIds.has(id));
          const names = memberNameBySession(ws.members);
          const running = ids.filter((id) => agentStates[id]?.active).length;
          return (
            <div key={ws.id} style={{
              border: '1px solid var(--line)', borderRadius: 10, padding: 6, marginBottom: 10, background: 'var(--bg0)',
              borderLeft: panel.kind === 'ws' && panel.wsId === ws.id ? '2px solid var(--accent)' : '1px solid var(--line)',
            }}>
              <div
                className="reveal-parent"
                onClick={() => setPanel({ kind: 'ws', wsId: ws.id })}
                onMouseEnter={(e) => { setHoveredWsId(ws.id); moveHl(e.currentTarget.parentElement as HTMLElement, 'ws'); }}
                title="hover: 분할 미리보기 · 클릭: 고정 · 탭: 전체 열기"
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', fontSize: 12, fontWeight: 700, color: 'var(--text-soft)', cursor: 'pointer' }}
              >
                {workspaceDisplayLabel(ws)}
                <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  {running > 0 ? (
                    <>
                      <span className="agent-dot-run" style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--agent-claude)' }} />
                      <span style={{ color: 'var(--text-dim)', fontSize: 10.5 }}>{running}</span>
                    </>
                  ) : null}
                  <button
                    className="reveal"
                    onClick={(e) => { e.stopPropagation(); void deleteWorkspaceCascade(ws); }}
                    style={closeBtnStyle}
                    title="workspace 삭제 (세션 종료)"
                  >×</button>
                </span>
              </div>
              {ids.map((sid) => sessionRow(sid, names.get(sid), ws.id))}
            </div>
          );
        })}

        {standalone.length > 0 ? (
          <>
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-dim)', margin: '14px 4px 8px' }}>
              standalone
            </div>
            {standalone.map((s) => sessionRow(s.id))}
          </>
        ) : null}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, background: 'var(--bg0)' }}>
        <div style={{ height: 34, display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px', borderBottom: '1px solid var(--line)', background: 'var(--bg1)', fontSize: 11.5, color: 'var(--text-dim)', flexShrink: 0 }}>
          {panel.kind === 'live' ? (
            <>
              <span style={{ color: 'var(--text-soft)', fontWeight: 700 }}>live</span>
              <span>#{panel.sid}</span>
              <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
                <button onClick={() => navigate({ page: 'session', id: panel.sid })} style={miniLinkBtnStyle}>open</button>
                <button onClick={() => void copySessionUrl(panel.sid)} style={miniLinkBtnStyle}>copy</button>
                <button onClick={() => setPanel({ kind: 'hover' })} style={miniLinkBtnStyle} title="미리보기로 (esc)">×</button>
              </span>
            </>
          ) : panel.kind === 'ws' ? (
            <>
              <span style={{ color: 'var(--text-soft)', fontWeight: 700 }}>workspace</span>
              <span>{(() => { const w = workspaces.find((x) => x.id === panel.wsId); return w ? workspaceDisplayLabel(w) : panel.wsId; })()}</span>
              <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
                <button onClick={() => navigate({ page: 'workspace', id: panel.wsId })} style={miniLinkBtnStyle}>open</button>
                <button onClick={() => setPanel({ kind: 'hover' })} style={miniLinkBtnStyle} title="미리보기로 (esc)">×</button>
              </span>
            </>
          ) : (
            <>
              <span style={{ color: 'var(--text-soft)' }}>preview</span>
              <span>{hoveredWsId !== null
                ? (() => { const w = workspaces.find((x) => x.id === hoveredWsId); return w ? workspaceDisplayLabel(w) : hoveredWsId; })()
                : hoveredSessionId !== null ? `#${hoveredSessionId}` : 'no session'}</span>
              <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
                {hoveredSessionId !== null ? (
                  <>
                    <button onClick={() => setPanel({ kind: 'live', sid: hoveredSessionId })} style={miniLinkBtnStyle}>live</button>
                    <button onClick={() => navigate({ page: 'session', id: hoveredSessionId })} style={miniLinkBtnStyle}>open</button>
                    <button onClick={() => void copySessionUrl(hoveredSessionId)} style={miniLinkBtnStyle}>copy</button>
                  </>
                ) : null}
              </span>
            </>
          )}
        </div>
        {panel.kind === 'live' ? (
          // 행 클릭 = 그 자리에서 바로 쓰는 터미널. 단일 대형 뷰라 GPU 허용.
          <div style={{ flex: 1, minHeight: 0 }}>
            <Terminal mux={mux} attachId={panel.sid} localEcho={localEchoEnabled} onExit={() => setPanel({ kind: 'hover' })} />
          </div>
        ) : panel.kind === 'ws' ? (
          renderWsMini(panel.wsId)
        ) : hoveredWsId !== null ? (
          renderWsMini(hoveredWsId)
        ) : (
          <div
            className="preview-scroll"
            style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 14px', color: 'var(--term-fg)', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.45, whiteSpace: 'pre-wrap' }}
            dangerouslySetInnerHTML={{ __html: ansiToHtml(hoveredScreen) }}
          />
        )}
      </div>
    </div>
  );
}

// ───── 단일 세션 페이지 ─────

function SessionPage({ mux, sessionId, localEchoEnabled }: { mux: TerminalMux; sessionId: number; localEchoEnabled: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={toolbarStyle}>
        <span style={{ color: 'var(--text-soft)', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span>session #{sessionId}</span>
          <button
            onClick={async () => copySessionUrl(sessionId)}
            style={miniLinkBtnStyle}
            title={`Copy ${getSessionUrl(sessionId)}`}
          >
            copy
          </button>
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Terminal mux={mux} attachId={sessionId} localEcho={localEchoEnabled} onExit={() => navigate({ page: 'dashboard' })} />
      </div>
    </div>
  );
}

// ───── Readonly Viewer 페이지 ─────

function ViewerPage({ mux, sessionId }: { mux: TerminalMux; sessionId: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={toolbarStyle}>
        <span style={{ color: 'var(--text-soft)', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span>session #{sessionId}</span>
          <button
            onClick={async () => copySessionUrl(sessionId)}
            style={miniLinkBtnStyle}
            title={`Copy ${getSessionUrl(sessionId)}`}
          >
            copy
          </button>
        </span>
        <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 3, background: 'var(--accent-bg)', color: 'var(--warn)' }}>
          readonly
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Terminal mux={mux} attachId={sessionId} mode="readonly" onExit={() => navigate({ page: 'dashboard' })} />
      </div>
    </div>
  );
}

// ───── 워크스페이스 페이지 (트리 레이아웃) ─────

function WorkspacePage({ mux, workspaceId, localEchoEnabled, agentStates, actionsSlot, uiStyle, fontSize }: { mux: TerminalMux; workspaceId: string; localEchoEnabled: boolean; agentStates: Record<number, AgentState>; actionsSlot: HTMLElement | null; uiStyle: UiStyle; fontSize: number }) {
  const U = UI_STYLES[uiStyle];
  const [ws, setWs] = useState<Workspace | null>(null);
  const [memberNames, setMemberNames] = useState<Record<number, string>>({});
  const [sessionCwds, setSessionCwds] = useState<Record<number, string>>({});
  const [deadSessions, setDeadSessions] = useState<Set<number>>(new Set());
  const [focusedSid, setFocusedSid] = useState<number | null>(null);
  const [zoomedSid, setZoomedSid] = useState<number | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const [standaloneSessions, setStandaloneSessions] = useState<Array<{ id: number; cwd?: string }>>([]);
  const [attachLoading, setAttachLoading] = useState(false);
  const [dragSid, setDragSid] = useState<number | null>(null);
  const [bells, setBells] = useState<Set<number>>(new Set());
  const [lastAgentIds, setLastAgentIds] = useState<Record<number, { claude?: string; codex?: string }>>({});
  const [turns, setTurns] = useState<AgentTurn[]>([]);
  const [awaitBusy, setAwaitBusy] = useState(false);
  const [awaitSeconds, setAwaitSeconds] = useState(0);
  const [awaitInput, setAwaitInput] = useState('');
  const barrier = useRef(new MutationBarrier());
  const wsRef = useRef<Workspace | null>(null);
  wsRef.current = ws;

  const applyWorkspace = useCallback(async (workspace: Workspace) => {
    setWs(workspace);
    setMemberNames(Object.fromEntries(memberNameBySession(workspace.members)));
    const ids = layoutToSessionIds(workspace.layout).filter((id) => id > 0);
    const cwdEntries = await Promise.all(ids.map(async (id) => {
      try {
        const meta = await fetchSessionMeta(id);
        return [id, typeof meta.cwd === 'string' ? meta.cwd : ''] as const;
      } catch { return [id, ''] as const; }
    }));
    setSessionCwds((prev) => ({ ...prev, ...Object.fromEntries(cwdEntries.filter(([, cwd]) => cwd)) }));
    const lastEntries = await Promise.all(ids.map(async (id) => {
      try {
        const meta = await fetchSessionMeta(id);
        return [id, {
          claude: typeof meta.claudeLastSessionId === 'string' ? meta.claudeLastSessionId : undefined,
          codex: typeof meta.codexLastSessionId === 'string' ? meta.codexLastSessionId : undefined,
        }] as const;
      } catch { return [id, {}] as const; }
    }));
    setLastAgentIds(Object.fromEntries(lastEntries));
  }, []);

  const refresh = useCallback(async () => {
    if (barrier.current.isLocked()) return;
    try {
      const workspace = await api.getWorkspace(API_BASE, workspaceId) as Workspace;
      await applyWorkspace(workspace);
    } catch {}
  }, [workspaceId, applyWorkspace]);

  useEffect(() => {
    setWs(null);
    setDeadSessions(new Set());
    setZoomedSid(null);
    void refresh();
    // 정상 경로는 서버 push. 폴링은 이벤트를 놓친 경우의 안전망일 뿐이다.
    const unsubscribe = mux.onWorkspace((event) => {
      if (barrier.current.isLocked()) return;
      if (event.deletedId === workspaceId) { navigate({ page: 'dashboard' }); return; }
      if (event.workspace?.id === workspaceId) void applyWorkspace(event.workspace as unknown as Workspace);
    });
    const fallback = window.setInterval(() => { void refresh(); }, 30_000);
    return () => { unsubscribe(); window.clearInterval(fallback); };
  }, [workspaceId, refresh, applyWorkspace, mux]);

  const sessionIds = ws ? layoutToSessionIds(ws.layout).filter((id) => id > 0) : [];

  const submitAwait = useCallback(async () => {
    const prompt = awaitInput.trim();
    const sid = focusedSid;
    if (!prompt || sid === null || awaitBusy) return;
    setAwaitInput('');
    setAwaitBusy(true);
    setAwaitSeconds(0);
    setTurns((prev) => [...prev, { sid, prompt, transcript: null, status: 'pending' }]);
    try {
      const { interaction } = await api.submitInteraction(API_BASE, sid, { prompt, timeoutMs: 120_000 });
      setTurns((prev) => prev.map((t) => (t.sid === sid && t.prompt === prompt && t.status === 'pending')
        ? { ...t, transcript: interaction.transcript, status: interaction.status } : t));
    } catch {
      setTurns((prev) => prev.map((t) => (t.sid === sid && t.prompt === prompt && t.status === 'pending')
        ? { ...t, status: 'failed' } : t));
    } finally { setAwaitBusy(false); }
  }, [awaitInput, focusedSid, awaitBusy]);

  useEffect(() => {
    if (!awaitBusy) return;
    const timer = window.setInterval(() => setAwaitSeconds((v) => v + 1), 1000);
    return () => window.clearInterval(timer);
  }, [awaitBusy]);

  const restoreAgent = useCallback((sid: number) => {
    const last = lastAgentIds[sid];
    if (!last) return;
    const cmd = last.claude ? `claude --resume ${last.claude}` : last.codex ? `codex resume ${last.codex}` : null;
    if (!cmd) return;
    void api.sendToSession(API_BASE, sid, cmd + '\r');
  }, [lastAgentIds]);

  useEffect(() => {
    if (sessionIds.length === 0) { setFocusedSid(null); return; }
    if (focusedSid === null || !sessionIds.includes(focusedSid)) setFocusedSid(sessionIds[0]!);
  }, [sessionIds.join(','), focusedSid]);

  // ── 변경 연산: 서버가 트리를 소유하고, 클라이언트는 트리 연산 결과를 커밋한다 ──

  const doSplit = useCallback(async (direction: 'right' | 'down', targetSid?: number) => {
    const end = barrier.current.begin();
    try {
      const target = targetSid ?? focusedSid ?? undefined;
      const data = await apiSplitWorkspace(workspaceId, {
        targetSessionId: target,
        cwd: target !== undefined ? sessionCwds[target] : undefined,
        cols: 80, rows: 24, direction,
      });
      if (!data) return;
      await applyWorkspace(data);
      // apiSplitWorkspace returns workspace; new session id = 최신 member
      const ids = layoutToSessionIds(data.layout).filter((id) => id > 0);
      const fresh = ids.find((id) => !sessionIds.includes(id));
      if (fresh !== undefined) setFocusedSid(fresh);
    } finally { end(); }
  }, [workspaceId, focusedSid, sessionCwds, sessionIds.join(','), applyWorkspace]);

  const detachMember = useCallback(async (sid: number) => {
    barrier.current.blockFor();
    setWs((prev) => prev ? { ...prev, layout: removePane(prev.layout, sid), members: prev.members.filter((m) => m.sessionId !== sid) } : prev);
    await apiRemoveMember(workspaceId, sid);
  }, [workspaceId]);

  const terminateMember = useCallback(async (sid: number) => {
    barrier.current.blockFor();
    mux.destroySession(sid);
    setWs((prev) => prev ? { ...prev, layout: removePane(prev.layout, sid), members: prev.members.filter((m) => m.sessionId !== sid) } : prev);
    await apiRemoveMember(workspaceId, sid);
  }, [mux, workspaceId]);

  const commitResize = useCallback((path: number[], sizes: number[]) => {
    barrier.current.blockFor();
    setWs((prev) => {
      if (!prev) return prev;
      const layout = resizeSplit(prev.layout, path, sizes);
      apiUpdateWorkspace(workspaceId, { layout });
      return { ...prev, layout };
    });
  }, [workspaceId]);

  const applyPreset = useCallback(async (preset: 'even-h' | 'even-v' | 'main-v' | 'tiled' | 'auto') => {
    setLayoutMenuOpen(false);
    const end = barrier.current.begin();
    try {
      const next = await api.updateWorkspace(API_BASE, workspaceId, { preset }) as Workspace;
      await applyWorkspace(next);
    } catch {} finally { end(); }
  }, [workspaceId, applyWorkspace]);

  const commitSwap = useCallback((a: number, b: number) => {
    barrier.current.blockFor();
    setWs((prev) => {
      if (!prev) return prev;
      const layout = swapPanes(prev.layout, a, b);
      apiUpdateWorkspace(workspaceId, { layout });
      return { ...prev, layout };
    });
  }, [workspaceId]);

  const restartAt = useCallback(async (sid: number) => {
    const neighbor = sessionIds.find((id) => id !== sid && !deadSessions.has(id));
    const cwd = sessionCwds[sid];
    await detachMember(sid);
    setDeadSessions((prev) => { const next = new Set(prev); next.delete(sid); return next; });
    const end = barrier.current.begin();
    try {
      const data = await apiSplitWorkspace(workspaceId, { targetSessionId: neighbor, cwd, cols: 80, rows: 24, direction: 'right' });
      if (data) await applyWorkspace(data);
    } finally { end(); }
  }, [sessionIds.join(','), deadSessions, sessionCwds, detachMember, workspaceId, applyWorkspace]);

  // ── attach 드롭다운 (고아 세션 편입) ──

  const loadStandaloneSessions = useCallback(async () => {
    setAttachLoading(true);
    try {
      const [list, wsList] = await Promise.all([mux.listSessions(), fetchWorkspaces()]);
      const taken = new Set<number>();
      for (const w of wsList) for (const m of w.members) taken.add(m.sessionId);
      const live = list.filter((s) => s.status !== 'dead' && !taken.has(s.id));
      const enriched = await Promise.all(live.map(async (s) => {
        try {
          const meta = await fetchSessionMeta(s.id);
          return { id: s.id, cwd: typeof meta.cwd === 'string' ? meta.cwd : undefined };
        } catch { return { id: s.id }; }
      }));
      setStandaloneSessions(enriched);
    } finally { setAttachLoading(false); }
  }, [mux]);

  const toggleAttach = useCallback(() => {
    setAttachOpen((prev) => {
      const next = !prev;
      if (next) void loadStandaloneSessions();
      return next;
    });
  }, [loadStandaloneSessions]);

  const attachSession = useCallback(async (sid: number) => {
    const end = barrier.current.begin();
    try {
      const used = new Set(Object.values(memberNames));
      let name = '';
      for (let i = 1; i < 1000; i++) {
        const candidate = `term-${i}`;
        if (!used.has(candidate)) { name = candidate; break; }
      }
      if (!name) name = `term-${sid}`;
      const workspace = await apiAddMember(workspaceId, sid, name);
      if (!workspace) return;
      await applyWorkspace(workspace);
      setFocusedSid(sid);
      setAttachOpen(false);
    } finally { end(); }
  }, [memberNames, workspaceId, applyWorkspace]);

  useEffect(() => {
    if (!attachOpen) return;
    const handler = (event: KeyboardEvent) => { if (event.key === 'Escape') setAttachOpen(false); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [attachOpen]);

  // ── 키바인딩: ⌘\ 우분할 · ⌘⇧\ 하분할 · ⌘←→ 포커스 순환 ──

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === '\\') { e.preventDefault(); void doSplit(e.shiftKey ? 'down' : 'right'); return; }
      if (meta && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
        e.preventDefault();
        if (sessionIds.length === 0) return;
        const at = focusedSid === null ? 0 : sessionIds.indexOf(focusedSid);
        const next = e.code === 'ArrowLeft'
          ? (at - 1 + sessionIds.length) % sessionIds.length
          : (at + 1) % sessionIds.length;
        setFocusedSid(sessionIds[next]!);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [doSplit, sessionIds.join(','), focusedSid]);

  // 탭 제목
  useEffect(() => {
    if (!ws) return;
    const label = ws.project !== 'default' ? `${ws.project}/${ws.name}` : ws.name;
    document.title = sessionIds.length > 0 ? `${label} (${sessionIds.length})` : label;
    return () => { document.title = 'ttym'; };
  }, [ws?.name, ws?.project, sessionIds.length]);

  const renderPane = useCallback((sid: number, _path: number[]) => {
    if (sid <= 0) {
      return (
        <div key="empty" style={emptyPaneStyle}>
          <button onClick={() => void doSplit('right')} style={actionBtnStyle}>start terminal</button>
        </div>
      );
    }
    const dead = deadSessions.has(sid);
    const isFocused = focusedSid === sid;
    const name = memberNames[sid];
    const cwd = sessionCwds[sid];
    const agent = agentStates[sid];
    const agentColor = agent?.kind ? AGENT_COLORS[agent.kind] : undefined;
    const canRestore = !agent?.active && (lastAgentIds[sid]?.claude || lastAgentIds[sid]?.codex);
    return (
      <div
        key={sid}
        onMouseDown={() => { setFocusedSid(sid); setBells((prev) => { if (!prev.has(sid)) return prev; const next = new Set(prev); next.delete(sid); return next; }); }}
        style={{
          display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, background: 'var(--bg0)',
          border: U.frameBorder ? (dead ? '1px solid var(--err)' : '1px solid var(--line)') : 'none',
          borderRadius: U.paneRadius,
          overflow: 'hidden',
        }}
      >
        <div
          className="reveal-parent"
          style={{
            display: 'flex', alignItems: 'center', height: 30, padding: 0,
            flexShrink: 0, userSelect: 'none', position: 'relative',
            ...(U.headerBar ? {
              background: isFocused ? 'var(--bg0)' : 'var(--bg2)',
              borderLeft: dead ? '2px solid var(--err)' : isFocused ? '2px solid var(--accent)' : '2px solid transparent',
              borderBottom: '1px solid var(--line)',
            } : null),
          }}
          draggable
          onDragStart={() => setDragSid(sid)}
          onDragEnd={() => setDragSid(null)}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
          onDrop={(e) => { e.preventDefault(); if (dragSid !== null && dragSid !== sid) commitSwap(dragSid, sid); setDragSid(null); }}
          onDoubleClick={() => setZoomedSid((z) => (z === sid ? null : sid))}
          title="double-click: zoom · drag: swap"
        >
          <span
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 10px',
              // frame: 포커스 신호는 텍스트 밝기 하나. classic: 바 배경이 말한다.
              flexGrow: 1, flexShrink: 1, minWidth: 0, overflow: 'hidden',
              height: '100%',
              opacity: U.headerBar ? 1 : isFocused ? 1 : 0.45,
            }}
          >
            {agentColor ? (
              <span
                className={agent?.active ? 'agent-dot-run' : undefined}
                style={{ width: 5, height: 5, borderRadius: '50%', background: agentColor, opacity: agent?.active ? 1 : 0.4, flexShrink: 0 }}
                title={agent?.active ? `${agent.kind} · running` : `${agent?.kind} · idle`}
              />
            ) : null}
            <span style={{ color: agentColor ?? (isFocused ? 'var(--text)' : 'var(--text-soft)'), fontSize: 11, fontFamily: 'monospace', fontWeight: 700, flexShrink: 0 }}>
              {name || `#${sid}`}
            </span>
            {name ? <span style={{ color: 'var(--text-dim)', fontSize: 10, fontFamily: 'monospace', flexShrink: 0 }}>#{sid}</span> : null}
            {cwd ? (
              <span style={{ color: 'var(--cwd)', fontSize: 10, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }} title={cwd}>
                {formatCwd(cwd)}
              </span>
            ) : null}
          </span>
          <span style={{
            position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
            display: 'inline-flex', alignItems: 'center', gap: 6, zIndex: 2,
          }}>
            {bells.has(sid) ? (
              <span title="bell" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--warn)', boxShadow: '0 0 6px var(--warn)', flexShrink: 0 }} />
            ) : null}
            {zoomedSid === sid ? <span style={{ color: 'var(--warn)', fontSize: 10, fontFamily: 'monospace' }}>zoom</span> : null}
            {canRestore ? (
              <button className="reveal" onClick={(e) => { e.stopPropagation(); restoreAgent(sid); }} style={miniLinkBtnStyle} title="이전 에이전트 세션 복원">restore</button>
            ) : null}
            <button className="reveal" onClick={(e) => { e.stopPropagation(); void doSplit('right', sid); }} style={miniLinkBtnStyle} title="split right">│</button>
            <button className="reveal" onClick={(e) => { e.stopPropagation(); void doSplit('down', sid); }} style={miniLinkBtnStyle} title="split down">─</button>
            <button className="reveal" onClick={(e) => { e.stopPropagation(); void detachMember(sid); }} style={miniLinkBtnStyle} title="detach (세션 유지)">detach</button>
            <button className="reveal" onClick={(e) => { e.stopPropagation(); void copySessionUrl(sid); }} style={miniLinkBtnStyle}>copy</button>
            <button className="reveal" onClick={(e) => { e.stopPropagation(); void terminateMember(sid); }} style={closeBtnStyle} title="terminate">×</button>
          </span>
        </div>
        <div style={{ flex: 1, minHeight: 0, padding: U.termPad }}>
          {!dead ? (
            <Terminal
              mux={mux}
              attachId={sid}
              fontSize={fontSize}
              localEcho={localEchoEnabled}
              onExit={() => setDeadSessions((prev) => new Set(prev).add(sid))}
              onBell={() => setBells((prev) => (focusedSid === sid ? prev : new Set(prev).add(sid)))}
            />
          ) : (
            <div style={emptyPaneStyle}>
              <span style={{ color: 'var(--err)', fontSize: 11 }}>session ended</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => void restartAt(sid)} style={actionBtnStyle}>restart</button>
                <button onClick={() => void detachMember(sid)} style={{ ...actionBtnStyle, background: 'var(--line)', color: 'var(--text-soft)' }}>close</button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }, [deadSessions, focusedSid, memberNames, sessionCwds, zoomedSid, dragSid, bells, mux, localEchoEnabled, fontSize, agentStates, lastAgentIds, doSplit, detachMember, terminateMember, commitSwap, restartAt, restoreAgent]);

  // 툴바 줄을 없앴다 — split/layout/attach는 탭 스트립 우측 슬롯에 포털로 산다.
  const stripActions = (
    <>
      <button onClick={() => void doSplit('right')} style={stripBtnStyle} title="split right of focused · ⌘\\">+ split</button>
      <span style={{ position: 'relative', display: 'inline-block' }}>
        <button onClick={() => setLayoutMenuOpen((v) => !v)} style={stripBtnStyle}>layout ▾</button>
        {layoutMenuOpen ? (
          <div style={attachDropdownStyle}>
            <div style={attachDropdownTitleStyle}>preset — 멤버는 그대로, 배치만 바뀐다</div>
            {(['auto', 'even-h', 'even-v', 'main-v', 'tiled'] as const).map((preset) => (
              <button key={preset} onClick={() => void applyPreset(preset)} style={attachDropdownItemStyle}>
                {preset}
              </button>
            ))}
          </div>
        ) : null}
      </span>
      <span style={{ position: 'relative', display: 'inline-block' }}>
        <button onClick={toggleAttach} style={stripBtnStyle}>+ attach</button>
        {attachOpen ? (
          <div style={attachDropdownStyle}>
            <div style={attachDropdownTitleStyle}>detached sessions</div>
            {attachLoading ? (
              <div style={attachDropdownEmptyStyle}>loading…</div>
            ) : standaloneSessions.length === 0 ? (
              <div style={attachDropdownEmptyStyle}>no detached sessions</div>
            ) : (
              standaloneSessions.map((s) => (
                <button key={s.id} onClick={() => void attachSession(s.id)} style={attachDropdownItemStyle} title={s.cwd ?? ''}>
                  <span style={{ color: 'var(--text)' }}>#{s.id}</span>
                  {s.cwd ? <span style={{ color: 'var(--text-soft)', marginLeft: 8, fontSize: 10 }}>{s.cwd}</span> : null}
                </button>
              ))
            )}
          </div>
        ) : null}
      </span>
    </>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {actionsSlot ? createPortal(stripActions, actionsSlot) : null}
      <div style={{ flex: 1, minHeight: 0, background: 'var(--bg0)', padding: U.wrapPad }}>
        {ws ? (
          <LayoutView
            layout={ws.layout}
            renderPane={renderPane}
            onResize={commitResize}
            zoomedSessionId={zoomedSid}
            splitterPx={U.splitterPx}
            splitterColor={U.splitterColor}
            splitterActiveColor="var(--accent)"
          />
        ) : (
          <div style={{ color: 'var(--text-dim)', padding: 40, fontFamily: 'monospace' }}>loading…</div>
        )}
      </div>

      {focusedSid !== null && agentStates[focusedSid]?.kind ? (
        <div style={{ borderTop: '1px solid #3a4656', background: 'var(--bg1)', flexShrink: 0, fontFamily: 'monospace' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 14px', fontSize: 11, color: 'var(--text-soft)', borderBottom: '1px solid #262d38' }}>
            <span style={{ color: AGENT_COLORS[agentStates[focusedSid]!.kind!], fontWeight: 700 }}>await</span>
            <span>→ {memberNames[focusedSid] || `#${focusedSid}`}</span>
            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {awaitBusy ? (
                <>
                  <span className="agent-dot-run" style={{ width: 5, height: 5, borderRadius: '50%', background: AGENT_COLORS[agentStates[focusedSid]!.kind!] }} />
                  <span style={{ color: 'var(--text-dim)', fontSize: 10.5 }}>turn 진행중 · {awaitSeconds}s</span>
                </>
              ) : null}
            </span>
          </div>
          {turns.filter((t) => t.sid === focusedSid).slice(-3).map((t, i) => (
            <div key={i} style={{ padding: '8px 14px 2px', fontSize: 11.5, lineHeight: 1.6 }}>
              <div style={{ color: 'var(--accent)', marginBottom: 3 }}>❯ {t.prompt}</div>
              <div style={{ color: t.status === 'failed' ? 'var(--err)' : 'var(--text-soft)', whiteSpace: 'pre-wrap', maxHeight: 180, overflowY: 'auto' }}>
                {t.transcript ?? (t.status === 'pending' ? '…' : `(${t.status})`)}
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '8px 14px 12px', background: 'var(--bg0)', border: '1px solid #3a4656', borderRadius: 8, padding: '7px 12px' }}>
            <input
              value={awaitInput}
              onChange={(e) => setAwaitInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submitAwait(); }}
              placeholder="프롬프트 입력 — Stop hook이 완료를 알리면 이번 턴 transcript만 표시"
              style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'monospace', fontSize: 12 }}
              disabled={awaitBusy}
            />
            <span style={{ fontSize: 10, border: '1px solid #3a4656', borderRadius: 4, padding: '1px 6px', color: 'var(--text-dim)' }}>⏎ send</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const emptyPaneStyle: React.CSSProperties = {
  height: '100%', width: '100%',
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
  background: 'var(--bg1)', color: 'var(--text-dim)', fontFamily: 'monospace', fontSize: 12, gap: 8,
};

function SettingsOverlay({
  localEchoEnabled,
  onLocalEchoChange,
  uiStyle,
  onUiStyleChange,
  fontSize,
  onFontSizeChange,
  onThemeChange,
}: {
  localEchoEnabled: boolean;
  onLocalEchoChange: (value: boolean) => void;
  uiStyle: UiStyle;
  onUiStyleChange: (value: UiStyle) => void;
  fontSize: number;
  onFontSizeChange: (value: number) => void;
  onThemeChange: (value: 'dark' | 'light') => void;
}) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'),
  );

  const applyTheme = useCallback((next: 'dark' | 'light') => {
    setTheme(next);
    if (next === 'light') document.documentElement.dataset.theme = 'light';
    else delete document.documentElement.dataset.theme;
    try { localStorage.setItem('ttym-theme', next); } catch {}
    // 터미널 배경 = 앱 배경 원칙: 살아있는 xterm들도 같은 프레임에 갈아입는다.
    refreshTerminalThemes();
    onThemeChange(next);
  }, [onThemeChange]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <div style={{ position: 'relative', zIndex: 100 }}>
      <button onClick={() => setOpen((value) => !value)} style={settingsButtonStyle}>
        settings
      </button>
      {open ? (
        <div style={settingsPopoverStyle}>
          <div style={settingsTitleStyle}>settings</div>
          <label style={{ ...settingsFieldStyle, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <span style={settingsLabelStyle}>ui style</span>
            <span style={{ display: 'inline-flex', gap: 6 }}>
              {(['frame', 'classic'] as const).map((option) => (
                <button
                  key={option}
                  onClick={() => onUiStyleChange(option)}
                  style={{
                    ...actionBtnStyle,
                    padding: '2px 10px',
                    fontSize: 11,
                    background: uiStyle === option ? 'var(--accent-bg)' : 'var(--bg2)',
                    color: uiStyle === option ? 'var(--accent)' : 'var(--text-soft)',
                    borderColor: uiStyle === option ? 'var(--accent-dim)' : 'var(--line)',
                  }}
                >
                  {option}
                </button>
              ))}
            </span>
          </label>
          <label style={{ ...settingsFieldStyle, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <span style={settingsLabelStyle}>theme</span>
            <span style={{ display: 'inline-flex', gap: 6 }}>
              {(['dark', 'light'] as const).map((option) => (
                <button
                  key={option}
                  onClick={() => applyTheme(option)}
                  style={{
                    ...actionBtnStyle,
                    padding: '2px 10px',
                    fontSize: 11,
                    background: theme === option ? 'var(--accent-bg)' : 'var(--bg2)',
                    color: theme === option ? 'var(--accent)' : 'var(--text-soft)',
                    borderColor: theme === option ? 'var(--accent-dim)' : 'var(--line)',
                  }}
                >
                  {option}
                </button>
              ))}
            </span>
          </label>
          <label style={{ ...settingsFieldStyle, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <span style={settingsLabelStyle}>font size</span>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <button onClick={() => onFontSizeChange(Math.max(8, fontSize - 1))} style={{ ...actionBtnStyle, padding: '2px 8px', fontSize: 11 }}>−</button>
              <span style={{ color: 'var(--text)', fontSize: 12, fontFamily: 'monospace', width: 20, textAlign: 'center' }}>{fontSize}</span>
              <button onClick={() => onFontSizeChange(Math.min(32, fontSize + 1))} style={{ ...actionBtnStyle, padding: '2px 8px', fontSize: 11 }}>+</button>
            </span>
          </label>
          <label style={{ ...settingsFieldStyle, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <span style={settingsLabelStyle}>optimistic local echo</span>
            <input
              type="checkbox"
              checked={localEchoEnabled}
              onChange={(event) => onLocalEchoChange(event.target.checked)}
            />
          </label>
          <div style={settingsHintStyle}>experimental: predicts printable shell echo before server confirmation</div>
        </div>
      ) : null}
    </div>
  );
}

// ───── Overview 페이지 (실시간 미리보기) ─────

function OverviewPage({ mux }: { mux: TerminalMux }) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const membership = sessionWorkspaceMembership(workspaces);

  useEffect(() => {
    let cancelled = false;
    Promise.all([mux.listSessions(), fetchWorkspaces()]).then(([list, wsList]) => {
      if (cancelled) return;
      setSessions(list.filter((s) => s.status !== 'dead'));
      setWorkspaces(wsList);
      setLoading(false);
    }).catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [mux]);

  // 워크스페이스에 속한 세션 ID 집합
  const assignedIds = new Set(workspaces.flatMap((w) => layoutToSessionIds(w.layout)));
  const aliveIds = new Set(sessions.map((s) => s.id));
  const standalone = sessions.filter((s) => !assignedIds.has(s.id));

  // 워크스페이스별 살아있는 세션만 필터
  const workspacesWithSessions = workspaces
    .map((ws) => ({
      ...ws,
      liveSessions: layoutToSessionIds(ws.layout).filter((id) => aliveIds.has(id)),
    }))
    .filter((ws) => ws.liveSessions.length > 0);

  if (loading) {
    return (
      <div style={{ color: 'var(--text-dim)', padding: 40, fontFamily: 'monospace' }}>loading...</div>
    );
  }

  const noSessions = sessions.length === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg0)' }}>
      <div style={toolbarStyle}>
        <span style={{ color: 'var(--text-soft)', fontSize: 12 }}>overview</span>
        <span style={{ color: 'var(--text-dim)', fontSize: 11, marginLeft: 'auto' }}>
          {sessions.length} session{sessions.length !== 1 ? 's' : ''}
        </span>
      </div>

      {noSessions ? (
        <div style={{ color: 'var(--text-dim)', fontSize: 13, fontFamily: 'monospace', padding: 40 }}>
          no active sessions. go to{' '}
          <span onClick={() => navigate({ page: 'dashboard' })} style={{ color: 'var(--accent)', cursor: 'pointer' }}>
            dashboard
          </span>
          {' '}to create one.
        </div>
      ) : (
        <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
          {workspacesWithSessions.map((ws) => (
            <div key={ws.id} style={{ marginBottom: 28 }}>
              <div
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10,
                  padding: '6px 12px', background: 'var(--bg1)', borderRadius: 4,
                  cursor: 'pointer',
                }}
                onClick={() => navigate({ page: 'workspace', id: ws.id })}
              >
                <span style={{ color: 'var(--text)', fontSize: 13, fontFamily: 'monospace', fontWeight: 600 }}>
                  {workspaceDisplayLabel(ws)}
                </span>
                <span style={{ color: 'var(--text-dim)', fontSize: 11, fontFamily: 'monospace' }}>
                  {ws.liveSessions.length} session{ws.liveSessions.length !== 1 ? 's' : ''}
                </span>
                <span style={{ color: 'var(--text-dim)', fontSize: 11, fontFamily: 'monospace', marginLeft: 'auto' }}>
                  click to open &rarr;
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(560px, 1fr))', gap: 8 }}>
                {ws.liveSessions.map((sid) => {
                  const info = sessions.find((s) => s.id === sid);
                  return (
                    <PreviewCard
                      key={sid}
                      mux={mux}
                      sessionId={sid}
                      label={memberLabel((membership.get(sid)?.memberName), sid)}
                      sublabel={info ? info.cmd.join(' ') : undefined}
                      status={info?.status}
                    />
                  );
                })}
              </div>
            </div>
          ))}

          {standalone.length > 0 && (
            <div>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10,
                padding: '6px 12px', background: 'var(--bg1)', borderRadius: 4,
              }}>
                <span style={{ color: 'var(--text-soft)', fontSize: 13, fontFamily: 'monospace', fontWeight: 600 }}>
                  standalone
                </span>
                <span style={{ color: 'var(--text-dim)', fontSize: 11, fontFamily: 'monospace' }}>
                  {standalone.length} session{standalone.length !== 1 ? 's' : ''}
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(560px, 1fr))', gap: 8 }}>
                {standalone.map((s) => (
                  <PreviewCard
                    key={s.id}
                    mux={mux}
                    sessionId={s.id}
                    label={memberLabel(undefined, s.id)}
                    sublabel={s.cmd.join(' ')}
                    status={s.status}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PreviewCard({ mux, sessionId, label, sublabel, status }: {
  mux: TerminalMux;
  sessionId: number;
  label: string;
  sublabel?: string;
  status?: string;
}) {
  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column',
        background: 'var(--bg0)', borderRadius: 4, overflow: 'hidden',
        border: '1px solid #2a2a2a',
        cursor: 'pointer',
        transition: 'border-color 0.15s',
      }}
      onClick={() => navigate({ page: 'session', id: sessionId })}
      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--accent)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--bg2)'; }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '4px 10px', background: 'var(--bg2)',
        borderBottom: '1px solid #2a2a2a',
        fontFamily: 'monospace', fontSize: 11, userSelect: 'none',
      }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: status === 'attached' ? 'var(--accent)' : 'var(--text-dim)',
          flexShrink: 0,
        }} />
        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span style={{ color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
          {sublabel ? (
            <span style={{ color: 'var(--text-dim)', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {sublabel}
            </span>
          ) : null}
        </span>
      </div>
      <div style={{ height: 220, pointerEvents: 'none' }}>
        <Terminal mux={mux} attachId={sessionId} mode="readonly" fontSize={9} enableWebgl={false} />
      </div>
    </div>
  );
}

// ───── App (라우터) ─────

function App() {
  const muxRef = useRef<TerminalMux | null>(null);
  const [connected, setConnected] = useState(false);
  const [route, setRoute] = useState<Route>(parseHash);
  const [localEchoEnabled, setLocalEchoEnabled] = useState(readLocalEchoEnabled);
  const [uiStyle, setUiStyle] = useState<UiStyle>(readUiStyle);
  const [fontSize, setFontSize] = useState(14);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [agentStates, setAgentStates] = useState<Record<number, AgentState>>({});
  const [stripSlot, setStripSlot] = useState<HTMLSpanElement | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const commitRename = useCallback(async () => {
    const id = renamingId;
    const name = renameDraft.trim();
    setRenamingId(null);
    if (!id || !name) return;
    try { await api.updateWorkspace(API_BASE, id, { name }); } catch {}
  }, [renamingId, renameDraft]);

  useEffect(() => {
    const wsUrl = `${isSecure ? 'wss' : 'ws'}://${TTYM_HOST}/ws`;
    console.log('[ttym] TTYM_HOST:', TTYM_HOST);
    console.log('[ttym] API_BASE:', API_BASE);
    console.log('[ttym] WS URL:', wsUrl);
    const mux = new TerminalMux(wsUrl);
    muxRef.current = mux;
    mux.connect()
      .then(() => { console.log('[ttym] connected'); setConnected(true); })
      .catch((err) => console.error('[ttym] connect failed:', err));
    return () => mux.disconnect();
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // 탭 스트립의 데이터: workspace 목록은 push 구동, 초기 1회만 fetch.
  useEffect(() => {
    if (!connected) return;
    void fetchWorkspaces().then(setWorkspaces);
    const mux = muxRef.current;
    if (!mux) return;
    return mux.onWorkspace((event) => {
      setWorkspaces((prev) => {
        if (event.deletedId) return prev.filter((w) => w.id !== event.deletedId);
        const next = event.workspace as unknown as Workspace | undefined;
        if (!next) return prev;
        const at = prev.findIndex((w) => w.id === next.id);
        if (at === -1) return [...prev, next];
        const copy = prev.slice(); copy[at] = next; return copy;
      });
    });
  }, [connected]);

  // 에이전트 상태: 정상 경로는 서버 push(CMD.AGENT — 훅이 쓰는 순간 도착).
  // 초기 1회 일괄 조회 + 60초 안전망만 남는다. 이게 마지막 폴링이었다.
  useEffect(() => {
    if (!connected) return;
    const memberIds = [...new Set(workspaces.flatMap((w) => layoutToSessionIds(w.layout).filter((id) => id > 0)))];
    if (memberIds.length === 0) { setAgentStates({}); return; }
    let cancelled = false;
    const sweep = async () => {
      const entries = await Promise.all(memberIds.map(async (id) => {
        try {
          const runtime = await api.getSessionRuntime(API_BASE, id);
          return [id, { kind: runtime.agent.kind, active: runtime.agent.active }] as const;
        } catch { return [id, { kind: null, active: false }] as const; }
      }));
      if (!cancelled) setAgentStates(Object.fromEntries(entries));
    };
    void sweep();
    const fallback = window.setInterval(() => { void sweep(); }, 60_000);
    const mux = muxRef.current;
    const unsubscribe = mux ? mux.onAgent((event) => {
      setAgentStates((prev) => ({ ...prev, [event.sessionId]: { kind: event.kind, active: event.active } }));
    }) : undefined;
    return () => { cancelled = true; window.clearInterval(fallback); unsubscribe?.(); };
  }, [connected, workspaces.map((w) => w.id + ':' + layoutToSessionIds(w.layout).join('.')).join('|')]);

  const createWorkspaceTab = useCallback(async () => {
    const id = uuid().slice(0, 8);
    const ws = await apiCreateWorkspace({ id, name: `workspace ${workspaces.length + 1}`, layout: { type: 'pane', sessionId: 0 } });
    if (ws) navigate({ page: 'workspace', id: ws.id });
  }, [workspaces.length]);

  // 창별 세밀 줌 (데스크톱 셸에서만): ⌘+/− 5% 스텝, ⌘0 리셋. 50~200% 클램프.
  // 브라우저 줌은 오리진 단위로 전 창이 동기화되지만 webview 줌은 창의 것이다.
  const zoomRef = useRef(1);
  useEffect(() => {
    if (!IS_NATIVE) return;
    const tauri = (window as unknown as { __TAURI__?: { webview?: { getCurrentWebview?: () => { setZoom: (f: number) => Promise<void> } } } }).__TAURI__;
    const webview = tauri?.webview?.getCurrentWebview?.();
    if (!webview) return;
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      let next: number | null = null;
      if (e.key === '=' || e.key === '+') next = zoomRef.current + 0.05;
      else if (e.key === '-') next = zoomRef.current - 0.05;
      else if (e.key === '0') next = 1;
      if (next === null) return;
      e.preventDefault();
      zoomRef.current = Math.min(2, Math.max(0.5, Math.round(next * 100) / 100));
      void webview.setZoom(zoomRef.current);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  // ⌘1 = 홈, ⌘2.. = workspace 탭
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !/^[1-9]$/.test(e.key)) return;
      const at = Number(e.key) - 1;
      e.preventDefault();
      if (at === 0) { navigate({ page: 'dashboard' }); return; }
      const ws = workspaces[at - 1];
      if (ws) navigate({ page: 'workspace', id: ws.id });
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [workspaces]);

  const handleLocalEchoChange = useCallback((value: boolean) => {
    writeLocalEchoEnabled(value);
    setLocalEchoEnabled(value);
  }, []);

  const handleUiStyleChange = useCallback((value: UiStyle) => {
    try { localStorage.setItem(UI_STYLE_STORAGE_KEY, value); } catch {}
    setUiStyle(value);
  }, []);

  // ── config: 서버 소유의 ~/.ttym/config가 모든 표면·창의 진실이다.
  // localStorage는 첫 페인트 플래시를 막는 캐시로만 남는다.
  const applyConfig = useCallback((values: Record<string, string>) => {
    if (values.theme === 'light' || values.theme === 'dark') {
      if (values.theme === 'light') document.documentElement.dataset.theme = 'light';
      else delete document.documentElement.dataset.theme;
      try { localStorage.setItem('ttym-theme', values.theme); } catch {}
      refreshTerminalThemes();
    }
    if (values['ui-style'] === 'frame' || values['ui-style'] === 'classic') {
      setUiStyle(values['ui-style']);
      try { localStorage.setItem(UI_STYLE_STORAGE_KEY, values['ui-style']); } catch {}
    }
    if (values['local-echo'] !== undefined) setLocalEchoEnabled(values['local-echo'] === 'true');
    if (values['font-size'] !== undefined) {
      const size = Number(values['font-size']);
      if (Number.isFinite(size) && size >= 8 && size <= 32) setFontSize(size);
    }
  }, []);

  useEffect(() => {
    if (!connected) return;
    void api.getConfig(API_BASE).then(({ values }) => applyConfig(values)).catch(() => {});
    const mux = muxRef.current;
    return mux ? mux.onConfig(({ values }) => applyConfig(values)) : undefined;
  }, [connected, applyConfig]);

  const patchConfig = useCallback((patch: Record<string, string | null>) => {
    void api.patchConfig(API_BASE, patch).catch(() => {});
  }, []);

  if (!connected || !muxRef.current) {
    return (
      <div style={{ color: 'var(--text-soft)', padding: 40, fontFamily: 'monospace' }}>
        connecting to ttym server...
      </div>
    );
  }

  const mux = muxRef.current;

  let page: React.ReactNode;

  switch (route.page) {
    case 'overview':
      page = <OverviewPage mux={mux} />;
      break;
    case 'session':
      page = <SessionPage mux={mux} sessionId={route.id} localEchoEnabled={localEchoEnabled} />;
      break;
    case 'viewer':
      page = <ViewerPage mux={mux} sessionId={route.id} />;
      break;
    case 'workspace':
      page = <WorkspacePage key={route.id} mux={mux} workspaceId={route.id} localEchoEnabled={localEchoEnabled} agentStates={agentStates} actionsSlot={stripSlot} uiStyle={uiStyle} fontSize={fontSize} />;
      break;
    default:
      page = <DashboardPage mux={mux} agentStates={agentStates} localEchoEnabled={localEchoEnabled} actionsSlot={stripSlot} />;
      break;
  }

  const homeActive = route.page === 'dashboard' || route.page === 'overview';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div
        {...(IS_NATIVE ? { 'data-tauri-drag-region': true } : {})}
        style={{ ...tabStripStyle, background: UI_STYLES[uiStyle].stripBg, borderBottom: UI_STYLES[uiStyle].stripLine, paddingLeft: IS_NATIVE ? 84 : 10 }}
      >
        <button
          onClick={() => navigate({ page: 'dashboard' })}
          style={{ ...tabStyle, ...(homeActive ? { ...tabActiveStyle, background: UI_STYLES[uiStyle].tabActiveBg } : null) }}
          title="home · ⌘1"
        >⌂</button>
        {workspaces.map((ws, i) => {
          const ids = layoutToSessionIds(ws.layout).filter((id) => id > 0);
          const running = ids.map((id) => agentStates[id]).find((a) => a?.active && a.kind);
          const anyAgent = ids.map((id) => agentStates[id]).find((a) => a?.kind);
          const active = route.page === 'workspace' && route.id === ws.id;
          const dotColor = (running ?? anyAgent)?.kind ? AGENT_COLORS[(running ?? anyAgent)!.kind!] : undefined;
          return (
            <button
              key={ws.id}
              onClick={() => navigate({ page: 'workspace', id: ws.id })}
              style={{ ...tabStyle, ...(active ? { ...tabActiveStyle, background: UI_STYLES[uiStyle].tabActiveBg } : null) }}
              title={`${workspaceDisplayLabel(ws)} · ⌘${i + 2} · 더블클릭: 이름 변경`}
              onDoubleClick={() => { setRenamingId(ws.id); setRenameDraft(ws.name); }}
            >
              {dotColor ? (
                <span
                  className={running ? 'agent-dot-run' : undefined}
                  style={{ width: 5, height: 5, borderRadius: '50%', background: dotColor, opacity: running ? 1 : 0.4, flexShrink: 0 }}
                />
              ) : null}
              {renamingId === ws.id ? (
                <input
                  autoFocus
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onBlur={() => { void commitRename(); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); void commitRename(); }
                    else if (e.key === 'Escape') { e.preventDefault(); setRenamingId(null); }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  style={{ background: 'var(--bg0)', color: 'var(--text)', border: '1px solid var(--line-strong)', borderRadius: 4, padding: '1px 5px', fontFamily: 'monospace', fontSize: 12, width: 110, outline: 'none' }}
                />
              ) : (
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>
                  {workspaceDisplayLabel(ws)}
                </span>
              )}
              <span style={{ color: 'var(--text-dim)' }}>{ids.length}</span>
            </button>
          );
        })}
        <button onClick={() => void createWorkspaceTab()} style={tabAddStyle} title="new workspace">+</button>
        <span style={{ marginLeft: 'auto' }} />
        <span ref={setStripSlot} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} />
        <SettingsOverlay
          localEchoEnabled={localEchoEnabled}
          onLocalEchoChange={(value) => { handleLocalEchoChange(value); patchConfig({ 'local-echo': String(value) }); }}
          uiStyle={uiStyle}
          onUiStyleChange={(value) => { handleUiStyleChange(value); patchConfig({ 'ui-style': value }); }}
          fontSize={fontSize}
          onFontSizeChange={(value) => { setFontSize(value); patchConfig({ 'font-size': String(value) }); }}
          onThemeChange={(value) => patchConfig({ theme: value })}
        />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {page}
      </div>
    </div>
  );
}

const tabStripStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  height: 42,
  padding: '0 10px',
  // 면은 bg0 하나 — 스트립도 workspace와 같은 들판이다. 슬래브 은퇴.
  // 구분선도 없다: 같은 면이라 경계가 필요 없어졌다.
  background: 'var(--bg0)',
  fontFamily: 'monospace',
  flexShrink: 0,
  userSelect: 'none',
};

const tabStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  height: 29,
  padding: '0 13px',
  borderRadius: 7,
  fontSize: 12,
  fontFamily: 'monospace',
  color: 'var(--text-dim)',
  background: 'transparent',
  border: '1px solid transparent',
  cursor: 'pointer',
};

const tabActiveStyle: React.CSSProperties = {
  // 화면에서 유일하게 채워진 크롬 = 현재 워크스페이스.
  background: 'var(--bg2)',
  color: 'var(--text)',
  border: '1px solid var(--line)',
};

const tabAddStyle: React.CSSProperties = {
  ...tabStyle,
  fontSize: 15,
  padding: '0 9px',
};

/* 탭 스트립 우측의 workspace 액션 — 탭과 같은 조용한 문법. */
const stripBtnStyle: React.CSSProperties = {
  ...tabStyle,
  height: 26,
  padding: '0 10px',
  fontSize: 11,
  color: 'var(--text-soft)',
  border: '1px solid var(--line)',
  borderRadius: 6,
};

// ───── 스타일 ─────

const toolbarStyle: React.CSSProperties = {
  padding: '6px 16px',
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  borderBottom: '1px solid #333',
  fontFamily: 'monospace',
};

const btnStyle: React.CSSProperties = {
  background: 'var(--bg2)',
  color: 'var(--text)',
  border: '1px solid #444',
  padding: '3px 10px',
  cursor: 'pointer',
  fontFamily: 'monospace',
  fontSize: 12,
  borderRadius: 3,
};

const actionBtnStyle: React.CSSProperties = {
  background: 'var(--bg2)',
  color: 'var(--text)',
  border: '1px solid #444',
  padding: '4px 12px',
  cursor: 'pointer',
  fontFamily: 'monospace',
  fontSize: 12,
  borderRadius: 3,
};

const closeBtnStyle: React.CSSProperties = {
  marginLeft: 'auto',
  background: 'none',
  border: 'none',
  color: 'var(--text-dim)',
  cursor: 'pointer',
  fontSize: 14,
  fontFamily: 'monospace',
  lineHeight: 1,
  padding: '0 4px',
  borderRadius: 3,
};

/* pane 헤더의 상시 노출 버튼 — 파랑은 포커스·상태 몫, 이 버튼들은 조용해야 한다. */
const miniLinkBtnStyle: React.CSSProperties = {
  background: 'transparent',
  color: 'var(--text-dim)',
  border: '1px solid transparent',
  padding: '1px 5px',
  cursor: 'pointer',
  fontFamily: 'monospace',
  fontSize: 10,
  borderRadius: 3,
  lineHeight: 1.4,
};

const settingsButtonStyle: React.CSSProperties = {
  background: 'var(--bg2)',
  color: 'var(--text-soft)',
  border: '1px solid var(--line-strong)',
  padding: '6px 10px',
  cursor: 'pointer',
  fontFamily: 'monospace',
  fontSize: 11,
  borderRadius: 7,
};

const workspaceNameStyle: React.CSSProperties = {
  color: 'var(--text)',
  fontSize: 15,
  fontWeight: 600,
  cursor: 'pointer',
  padding: '2px 6px',
  borderRadius: 4,
  marginLeft: -4,
};

const workspaceNameInputStyle: React.CSSProperties = {
  background: 'var(--bg2)',
  color: 'var(--text)',
  border: '1px solid var(--line-strong)',
  borderRadius: 4,
  padding: '2px 6px',
  fontFamily: 'monospace',
  fontSize: 15,
  fontWeight: 600,
  outline: 'none',
  minWidth: 160,
};

const attachDropdownStyle: React.CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 6px)',
  right: 0,
  minWidth: 240,
  maxHeight: 320,
  overflowY: 'auto',
  padding: 6,
  borderRadius: 8,
  border: '1px solid var(--line-strong)',
  background: 'var(--bg1)',
  boxShadow: '0 12px 30px rgba(0, 0, 0, 0.45)',
  backdropFilter: 'blur(14px)',
  fontFamily: 'monospace',
  zIndex: 50,
};

const attachDropdownTitleStyle: React.CSSProperties = {
  color: 'var(--text-soft)',
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  padding: '4px 8px 6px',
};

const attachDropdownItemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  width: '100%',
  padding: '6px 8px',
  background: 'transparent',
  border: 'none',
  color: 'var(--text-soft)',
  fontFamily: 'monospace',
  fontSize: 12,
  textAlign: 'left',
  cursor: 'pointer',
  borderRadius: 4,
};

const attachDropdownEmptyStyle: React.CSSProperties = {
  padding: '8px',
  color: 'var(--text-dim)',
  fontSize: 11,
};

const settingsPopoverStyle: React.CSSProperties = {
  position: 'absolute',
  right: 0,
  marginTop: 8,
  width: 220,
  padding: 12,
  borderRadius: 10,
  border: '1px solid var(--line-strong)',
  background: 'var(--bg1)',
  boxShadow: '0 18px 42px rgba(0, 0, 0, 0.42)',
  backdropFilter: 'blur(14px)',
  fontFamily: 'monospace',
};

const settingsTitleStyle: React.CSSProperties = {
  color: 'var(--text)',
  fontSize: 12,
  fontWeight: 600,
  marginBottom: 10,
};

const settingsFieldStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 7,
};

const settingsLabelStyle: React.CSSProperties = {
  color: 'var(--text-soft)',
  fontSize: 11,
};

const settingsInputStyle: React.CSSProperties = {
  width: '100%',
  border: '1px solid var(--line-strong)',
  background: 'var(--bg2)',
  color: 'var(--text)',
  borderRadius: 7,
  padding: '7px 9px',
  outline: 'none',
  fontFamily: 'monospace',
};

const settingsHintStyle: React.CSSProperties = {
  color: 'var(--text-dim)',
  fontSize: 10,
  marginTop: 8,
};

export default App;
