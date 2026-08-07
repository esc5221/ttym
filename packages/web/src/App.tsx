import { useCallback, useEffect, useRef, useState } from 'react';
import { TerminalMux, Terminal, LayoutView } from '@ttym/ui';
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

// 에이전트 식별색 — 정체는 이름의 색, 활동은 4px 점. 필 배지는 쓰지 않는다.
const AGENT_COLORS: Record<string, string> = { 'claude-code': '#e8955c', codex: '#7ec8e8' };

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

function DashboardPage({ mux }: { mux: TerminalMux }) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [sessionCwds, setSessionCwds] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [hoveredSessionId, setHoveredSessionId] = useState<number | null>(null);
  const [hoveredScreen, setHoveredScreen] = useState<string>('hover a session to preview');
  const [compactLayout, setCompactLayout] = useState(() => window.innerWidth < 1080);

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

  const membership = sessionWorkspaceMembership(workspaces);

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
    if (hoveredSessionId === null) return;
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
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [hoveredSessionId]);

  // 죽은 세션은 membership만 걷어낸다 — 레이아웃 트리 정리는 서버 몫이라
  // 클라이언트가 트리를 평탄화할 일이 없다.
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
      const id = await mux.createSession({ cols: 80, rows: 24 }, {
        onData: () => {},
        onExit: () => {},
      });
      mux.detachSession(id);
      navigate({ page: 'session', id });
    } catch (e) {
      console.error('Failed to create session:', e);
    }
  }, [mux]);

  const createWorkspace = useCallback(async () => {
    const id = uuid().slice(0, 8);
    const name = `workspace ${workspaces.length + 1}`;
    const layout: LayoutNode = { type: 'pane', sessionId: 0 }; // placeholder
    const ws = await apiCreateWorkspace({ id, name, layout });
    if (ws) {
      setWorkspaces((prev) => [...prev, ws]);
      navigate({ page: 'workspace', id });
    }
  }, [workspaces]);

  const deleteWorkspace = useCallback(async (wsId: string) => {
    const workspace = workspaces.find((w) => w.id === wsId);
    if (!workspace) return;
    for (const sessionId of layoutToSessionIds(workspace.layout).filter((id) => id > 0)) {
      mux.destroySession(sessionId);
    }
    await apiDeleteWorkspace(wsId);
    setWorkspaces((prev) => prev.filter((w) => w.id !== wsId));
  }, [mux, workspaces]);

  return (
    <div style={{ padding: 32, fontFamily: 'monospace', color: '#ccc', width: '100%', maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ marginBottom: 24 }}>
        <button
          onClick={() => navigate({ page: 'overview' })}
          style={{ ...actionBtnStyle, background: '#0d3a58', color: '#4fc3f7', border: '1px solid #007acc' }}
        >
          overview — live preview
        </button>
      </div>

      <div style={{ marginBottom: 32 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
          <h2 style={{ fontSize: 13, margin: 0, color: '#888', textTransform: 'uppercase', letterSpacing: 1 }}>
            workspaces
          </h2>
          <button onClick={createWorkspace} style={actionBtnStyle}>+ new</button>
        </div>
        {workspaces.length === 0 ? (
          <div style={{ color: '#444', fontSize: 12, padding: '8px 0' }}>
            no workspaces.{' '}
            <span onClick={createWorkspace} style={{ color: '#007acc', cursor: 'pointer' }}>create one</span>
            {' '}to group terminals.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {workspaces.map((ws) => (
              <div
                key={ws.id}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', background: '#252525', cursor: 'pointer', minWidth: 0 }}
                onClick={() => navigate({ page: 'workspace', id: ws.id })}
              >
                <span style={{ color: '#eee', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {workspaceDisplayLabel(ws)}
                </span>
                <span style={{ color: '#666', fontSize: 11, flexShrink: 0 }}>
                  {layoutToSessionIds(ws.layout).filter((id) => id > 0).length} session{layoutToSessionIds(ws.layout).filter((id) => id > 0).length !== 1 ? 's' : ''}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteWorkspace(ws.id); }}
                  style={{ ...closeBtnStyle, color: '#555', fontSize: 12 }}
                  title="Terminate workspace"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
          <h2 style={{ fontSize: 13, margin: 0, color: '#888', textTransform: 'uppercase', letterSpacing: 1 }}>
            sessions
          </h2>
          <button onClick={createSession} style={actionBtnStyle}>+ new</button>
          <button onClick={refresh} style={{ ...actionBtnStyle, background: 'transparent' }}>refresh</button>
        </div>
        {loading ? (
          <div style={{ color: '#666', fontSize: 12 }}>loading...</div>
        ) : sessions.length === 0 ? (
          <div style={{ color: '#444', fontSize: 12, padding: '8px 0' }}>
            no active sessions.{' '}
            <span onClick={createSession} style={{ color: '#007acc', cursor: 'pointer' }}>create one</span>
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: compactLayout ? 'minmax(0, 1fr)' : 'minmax(320px, 420px) minmax(0, 1fr)',
            gap: 16,
            alignItems: 'start',
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
              {sessions.map((s) => (
                (() => {
                  const info = membership.get(s.id);
                  const title = info?.memberName ? info.memberName : `#${s.id}`;
                  const meta = info ? workspaceDisplayLabel(info.workspace) : 'standalone';
                  const hovered = hoveredSessionId === s.id;
                  return (
                    <div
                      key={s.id}
                      onClick={() => navigate({ page: 'session', id: s.id })}
                      onMouseEnter={() => setHoveredSessionId(s.id)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '8px 12px',
                        background: hovered ? '#2b2f35' : '#252525',
                        cursor: 'pointer',
                        borderLeft: `3px solid ${s.status === 'attached' ? '#007acc' : '#555'}`,
                        minWidth: 0,
                      }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, width: 72, flexShrink: 0 }}>
                        <span style={{ color: '#eee', fontWeight: 600, width: 36 }}>#{s.id}</span>
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            await copySessionUrl(s.id);
                          }}
                          style={miniLinkBtnStyle}
                          title={`Copy ${getSessionUrl(s.id)}`}
                        >
                          copy
                        </button>
                      </span>
                      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                        <span style={{ color: '#ddd', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
                        <span style={{ color: '#666', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {meta} · {(sessionCwds[s.id] ? `${formatCwd(sessionCwds[s.id])} · ` : '')}{s.cmd.join(' ')}
                        </span>
                      </span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, flexShrink: 0, marginLeft: 'auto', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        <span style={{
                          fontSize: 11, padding: '1px 6px', borderRadius: 3,
                          background: s.status === 'attached' ? '#0d3a58' : '#333',
                          color: s.status === 'attached' ? '#4fc3f7' : '#888',
                          flexShrink: 0,
                        }}>
                          {s.status}
                        </span>
                        <span style={{ color: '#555', fontSize: 11, flexShrink: 0, width: 74, textAlign: 'right' }}>pid {s.pid}</span>
                        <button
                          onClick={(e) => { e.stopPropagation(); navigate({ page: 'viewer', id: s.id }); }}
                          style={{ ...actionBtnStyle, padding: '1px 6px', fontSize: 10, background: '#2a2a2a', flexShrink: 0 }}
                          title="View readonly"
                        >
                          view
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); mux.destroySession(s.id); refresh(); }}
                          style={{ ...closeBtnStyle, color: '#555', fontSize: 12, flexShrink: 0, marginLeft: 0 }}
                          title="Kill session"
                        >
                          ×
                        </button>
                      </span>
                    </div>
                  );
                })()
              ))}
            </div>
            <div
              style={{
                position: compactLayout ? 'relative' : 'sticky',
                top: compactLayout ? 0 : 24,
                background: '#1b1f24',
                border: '1px solid #2d3440',
                borderRadius: 4,
                overflow: 'hidden',
                minHeight: 320,
                minWidth: 0,
              }}
            >
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 10px',
                background: '#171b20',
                borderBottom: '1px solid #2d3440',
                fontSize: 11,
              }}>
                <span style={{ color: '#9fb3c8' }}>preview</span>
                <span style={{ color: '#566373', marginLeft: 'auto' }}>
                  {hoveredSessionId !== null ? `#${hoveredSessionId}` : 'no session'}
                </span>
              </div>
              <div
                className="preview-scroll"
                style={{
                  minHeight: 280,
                  height: compactLayout ? 320 : 'min(58vh, 620px)',
                  overflow: 'auto',
                  padding: '12px 14px',
                  background: '#0f141a',
                  color: '#d4d4d4',
                  fontFamily: 'monospace',
                  fontSize: 12,
                  lineHeight: 1.45,
                  whiteSpace: 'pre-wrap',
                }}
                dangerouslySetInnerHTML={{ __html: ansiToHtml(hoveredScreen) }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ───── 단일 세션 페이지 ─────

function SessionPage({ mux, sessionId, localEchoEnabled }: { mux: TerminalMux; sessionId: number; localEchoEnabled: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={toolbarStyle}>
        <button onClick={() => navigate({ page: 'dashboard' })} style={btnStyle}>&larr; dashboard</button>
        <span style={{ color: '#aaa', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={toolbarStyle}>
        <button onClick={() => navigate({ page: 'dashboard' })} style={btnStyle}>&larr; dashboard</button>
        <span style={{ color: '#aaa', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span>session #{sessionId}</span>
          <button
            onClick={async () => copySessionUrl(sessionId)}
            style={miniLinkBtnStyle}
            title={`Copy ${getSessionUrl(sessionId)}`}
          >
            copy
          </button>
        </span>
        <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 3, background: '#3a2a00', color: '#f0b040' }}>
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

function WorkspacePage({ mux, workspaceId, localEchoEnabled }: { mux: TerminalMux; workspaceId: string; localEchoEnabled: boolean }) {
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
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [dragSid, setDragSid] = useState<number | null>(null);
  const [agentStates, setAgentStates] = useState<Record<number, AgentState>>({});
  const [lastAgentIds, setLastAgentIds] = useState<Record<number, { claude?: string; codex?: string }>>({});
  const [turns, setTurns] = useState<AgentTurn[]>([]);
  const [awaitBusy, setAwaitBusy] = useState(false);
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

  useEffect(() => {
    if (sessionIds.length === 0) return;
    let cancelled = false;
    const tick = async () => {
      const entries = await Promise.all(sessionIds.map(async (id) => {
        try {
          const runtime = await api.getSessionRuntime(API_BASE, id);
          return [id, { kind: runtime.agent.kind, active: runtime.agent.active }] as const;
        } catch { return [id, { kind: null, active: false }] as const; }
      }));
      if (!cancelled) setAgentStates(Object.fromEntries(entries));
    };
    void tick();
    const timer = window.setInterval(() => { void tick(); }, 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [sessionIds.join(',')]);

  const submitAwait = useCallback(async () => {
    const prompt = awaitInput.trim();
    const sid = focusedSid;
    if (!prompt || sid === null || awaitBusy) return;
    setAwaitInput('');
    setAwaitBusy(true);
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

  // ── 이름 편집 ──

  const beginEditName = useCallback(() => { setDraftName(ws?.name ?? ''); setEditingName(true); }, [ws?.name]);
  const commitEditName = useCallback(async () => {
    const next = draftName.trim();
    setEditingName(false);
    if (!next || next === ws?.name) return;
    setWs((prev) => prev ? { ...prev, name: next } : prev);
    await apiUpdateWorkspace(workspaceId, { name: next });
  }, [draftName, ws?.name, workspaceId]);

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
        onMouseDown={() => setFocusedSid(sid)}
        style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, background: '#1e1e1e' }}
      >
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 8, height: 30, padding: '0 8px',
            background: isFocused ? '#1e1e1e' : '#181818',
            borderTop: dead ? '2px solid #a55' : isFocused ? '2px solid #007acc' : '2px solid transparent',
            borderBottom: '1px solid #333', flexShrink: 0, userSelect: 'none',
          }}
          draggable
          onDragStart={() => setDragSid(sid)}
          onDragEnd={() => setDragSid(null)}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
          onDrop={(e) => { e.preventDefault(); if (dragSid !== null && dragSid !== sid) commitSwap(dragSid, sid); setDragSid(null); }}
          onDoubleClick={() => setZoomedSid((z) => (z === sid ? null : sid))}
          title="double-click: zoom · drag: swap"
        >
          {agentColor ? (
            <span
              className={agent?.active ? 'agent-dot-run' : undefined}
              style={{ width: 5, height: 5, borderRadius: '50%', background: agentColor, opacity: agent?.active ? 1 : 0.4, flexShrink: 0 }}
              title={agent?.active ? `${agent.kind} · running` : `${agent?.kind} · idle`}
            />
          ) : null}
          <span style={{ color: agentColor ?? (isFocused ? '#ccc' : '#666'), fontSize: 11, fontFamily: 'monospace', fontWeight: 700 }}>
            {name || `#${sid}`}
          </span>
          {name ? <span style={{ color: '#555', fontSize: 10, fontFamily: 'monospace' }}>#{sid}</span> : null}
          {cwd ? (
            <span style={{ color: isFocused ? '#6b90b1' : '#4d6175', fontSize: 10, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={cwd}>
              {formatCwd(cwd)}
            </span>
          ) : null}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto', flexShrink: 0 }}>
            {zoomedSid === sid ? <span style={{ color: '#f0b040', fontSize: 10, fontFamily: 'monospace' }}>zoom</span> : null}
            {canRestore ? (
              <button onClick={(e) => { e.stopPropagation(); restoreAgent(sid); }} style={miniLinkBtnStyle} title="이전 에이전트 세션 복원">restore</button>
            ) : null}
            <button onClick={(e) => { e.stopPropagation(); void doSplit('right', sid); }} style={miniLinkBtnStyle} title="split right">│</button>
            <button onClick={(e) => { e.stopPropagation(); void doSplit('down', sid); }} style={miniLinkBtnStyle} title="split down">─</button>
            <button onClick={(e) => { e.stopPropagation(); void detachMember(sid); }} style={miniLinkBtnStyle} title="detach (세션 유지)">detach</button>
            <button onClick={(e) => { e.stopPropagation(); void copySessionUrl(sid); }} style={miniLinkBtnStyle}>copy</button>
            <button onClick={(e) => { e.stopPropagation(); void terminateMember(sid); }} style={closeBtnStyle} title="terminate">×</button>
          </span>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          {!dead ? (
            <Terminal
              mux={mux}
              attachId={sid}
              localEcho={localEchoEnabled}
              onExit={() => setDeadSessions((prev) => new Set(prev).add(sid))}
            />
          ) : (
            <div style={emptyPaneStyle}>
              <span style={{ color: '#a55', fontSize: 11 }}>session ended</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => void restartAt(sid)} style={actionBtnStyle}>restart</button>
                <button onClick={() => void detachMember(sid)} style={{ ...actionBtnStyle, background: '#333', color: '#888' }}>close</button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }, [deadSessions, focusedSid, memberNames, sessionCwds, zoomedSid, dragSid, mux, localEchoEnabled, agentStates, lastAgentIds, doSplit, detachMember, terminateMember, commitSwap, restartAt, restoreAgent]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={toolbarStyle}>
        <button onClick={() => navigate({ page: 'dashboard' })} style={btnStyle} title="dashboard">&larr;</button>
        {ws && ws.project !== 'default' ? <span style={{ color: '#666', fontSize: 13 }}>{ws.project}/</span> : null}
        {editingName ? (
          <input
            autoFocus
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={() => { void commitEditName(); }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); void commitEditName(); }
              else if (event.key === 'Escape') { event.preventDefault(); setEditingName(false); }
            }}
            style={workspaceNameInputStyle}
          />
        ) : (
          <span onClick={beginEditName} style={workspaceNameStyle} title="click to rename">{ws?.name ?? workspaceId}</span>
        )}
        <button onClick={() => void doSplit('right')} style={btnStyle}>+ split</button>
        <span style={{ position: 'relative', display: 'inline-block' }}>
          <button onClick={() => setLayoutMenuOpen((v) => !v)} style={btnStyle}>layout ▾</button>
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
          <button onClick={toggleAttach} style={btnStyle}>+ attach</button>
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
                    <span style={{ color: '#eaf0f6' }}>#{s.id}</span>
                    {s.cwd ? <span style={{ color: '#8892a0', marginLeft: 8, fontSize: 10 }}>{s.cwd}</span> : null}
                  </button>
                ))
              )}
            </div>
          ) : null}
        </span>
        <span style={{ color: '#444', fontSize: 11, marginLeft: 'auto' }}>
          {'\u2318\\ split \u2003 \u2318\u21e7\\ down \u2003 drag divider resize \u2003 dbl-click zoom'}
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, background: '#1e1e1e' }}>
        {ws ? (
          <LayoutView
            layout={ws.layout}
            renderPane={renderPane}
            onResize={commitResize}
            zoomedSessionId={zoomedSid}
          />
        ) : (
          <div style={{ color: '#666', padding: 40, fontFamily: 'monospace' }}>loading…</div>
        )}
      </div>

      {focusedSid !== null && agentStates[focusedSid]?.kind ? (
        <div style={{ borderTop: '1px solid #3a4656', background: '#161b22', flexShrink: 0, fontFamily: 'monospace' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 14px', fontSize: 11, color: '#aab4c0', borderBottom: '1px solid #262d38' }}>
            <span style={{ color: AGENT_COLORS[agentStates[focusedSid]!.kind!], fontWeight: 700 }}>await</span>
            <span>→ {memberNames[focusedSid] || `#${focusedSid}`}</span>
            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {awaitBusy ? (
                <>
                  <span className="agent-dot-run" style={{ width: 5, height: 5, borderRadius: '50%', background: AGENT_COLORS[agentStates[focusedSid]!.kind!] }} />
                  <span style={{ color: '#6f7987', fontSize: 10.5 }}>turn 진행중</span>
                </>
              ) : null}
            </span>
          </div>
          {turns.filter((t) => t.sid === focusedSid).slice(-3).map((t, i) => (
            <div key={i} style={{ padding: '8px 14px 2px', fontSize: 11.5, lineHeight: 1.6 }}>
              <div style={{ color: '#4fa3f7', marginBottom: 3 }}>❯ {t.prompt}</div>
              <div style={{ color: t.status === 'failed' ? '#f26d6d' : '#aab4c0', whiteSpace: 'pre-wrap', maxHeight: 180, overflowY: 'auto' }}>
                {t.transcript ?? (t.status === 'pending' ? '…' : `(${t.status})`)}
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '8px 14px 12px', background: '#0f141a', border: '1px solid #3a4656', borderRadius: 8, padding: '7px 12px' }}>
            <input
              value={awaitInput}
              onChange={(e) => setAwaitInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submitAwait(); }}
              placeholder="프롬프트 입력 — Stop hook이 완료를 알리면 이번 턴 transcript만 표시"
              style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: '#e6edf5', fontFamily: 'monospace', fontSize: 12 }}
              disabled={awaitBusy}
            />
            <span style={{ fontSize: 10, border: '1px solid #3a4656', borderRadius: 4, padding: '1px 6px', color: '#6f7987' }}>⏎ send</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const emptyPaneStyle: React.CSSProperties = {
  height: '100%', width: '100%',
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
  background: '#151515', color: '#666', fontFamily: 'monospace', fontSize: 12, gap: 8,
};

function SettingsOverlay({
  localEchoEnabled,
  onLocalEchoChange,
}: {
  localEchoEnabled: boolean;
  onLocalEchoChange: (value: boolean) => void;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 100 }}>
      <button onClick={() => setOpen((value) => !value)} style={settingsButtonStyle}>
        settings
      </button>
      {open ? (
        <div style={settingsPopoverStyle}>
          <div style={settingsTitleStyle}>workspace settings</div>
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
      <div style={{ color: '#666', padding: 40, fontFamily: 'monospace' }}>loading...</div>
    );
  }

  const noSessions = sessions.length === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#111' }}>
      <div style={toolbarStyle}>
        <button onClick={() => navigate({ page: 'dashboard' })} style={btnStyle}>&larr; dashboard</button>
        <span style={{ color: '#aaa', fontSize: 12 }}>overview</span>
        <span style={{ color: '#555', fontSize: 11, marginLeft: 'auto' }}>
          {sessions.length} session{sessions.length !== 1 ? 's' : ''}
        </span>
      </div>

      {noSessions ? (
        <div style={{ color: '#444', fontSize: 13, fontFamily: 'monospace', padding: 40 }}>
          no active sessions. go to{' '}
          <span onClick={() => navigate({ page: 'dashboard' })} style={{ color: '#007acc', cursor: 'pointer' }}>
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
                  padding: '6px 12px', background: '#1a1a1a', borderRadius: 4,
                  cursor: 'pointer',
                }}
                onClick={() => navigate({ page: 'workspace', id: ws.id })}
              >
                <span style={{ color: '#ccc', fontSize: 13, fontFamily: 'monospace', fontWeight: 600 }}>
                  {workspaceDisplayLabel(ws)}
                </span>
                <span style={{ color: '#555', fontSize: 11, fontFamily: 'monospace' }}>
                  {ws.liveSessions.length} session{ws.liveSessions.length !== 1 ? 's' : ''}
                </span>
                <span style={{ color: '#444', fontSize: 11, fontFamily: 'monospace', marginLeft: 'auto' }}>
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
                padding: '6px 12px', background: '#1a1a1a', borderRadius: 4,
              }}>
                <span style={{ color: '#888', fontSize: 13, fontFamily: 'monospace', fontWeight: 600 }}>
                  standalone
                </span>
                <span style={{ color: '#555', fontSize: 11, fontFamily: 'monospace' }}>
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
        background: '#1e1e1e', borderRadius: 4, overflow: 'hidden',
        border: '1px solid #2a2a2a',
        cursor: 'pointer',
        transition: 'border-color 0.15s',
      }}
      onClick={() => navigate({ page: 'session', id: sessionId })}
      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = '#007acc'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = '#2a2a2a'; }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '4px 10px', background: '#181818',
        borderBottom: '1px solid #2a2a2a',
        fontFamily: 'monospace', fontSize: 11, userSelect: 'none',
      }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: status === 'attached' ? '#4fc3f7' : '#555',
          flexShrink: 0,
        }} />
        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span style={{ color: '#ddd', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
          {sublabel ? (
            <span style={{ color: '#666', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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

  const handleLocalEchoChange = useCallback((value: boolean) => {
    writeLocalEchoEnabled(value);
    setLocalEchoEnabled(value);
  }, []);

  if (!connected || !muxRef.current) {
    return (
      <div style={{ color: '#888', padding: 40, fontFamily: 'monospace' }}>
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
      page = <WorkspacePage key={route.id} mux={mux} workspaceId={route.id} localEchoEnabled={localEchoEnabled} />;
      break;
    default:
      page = <DashboardPage mux={mux} />;
      break;
  }

  return (
    <>
      {page}
      <SettingsOverlay
        localEchoEnabled={localEchoEnabled}
        onLocalEchoChange={handleLocalEchoChange}
      />
    </>
  );
}

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
  background: '#2d2d2d',
  color: '#ccc',
  border: '1px solid #444',
  padding: '3px 10px',
  cursor: 'pointer',
  fontFamily: 'monospace',
  fontSize: 12,
  borderRadius: 3,
};

const actionBtnStyle: React.CSSProperties = {
  background: '#2d2d2d',
  color: '#ccc',
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
  color: '#555',
  cursor: 'pointer',
  fontSize: 14,
  fontFamily: 'monospace',
  lineHeight: 1,
  padding: '0 4px',
  borderRadius: 3,
};

const miniLinkBtnStyle: React.CSSProperties = {
  background: '#1c2631',
  color: '#8ab4d8',
  border: '1px solid #314253',
  padding: '1px 5px',
  cursor: 'pointer',
  fontFamily: 'monospace',
  fontSize: 10,
  borderRadius: 3,
  lineHeight: 1.4,
};

const settingsButtonStyle: React.CSSProperties = {
  background: 'rgba(18, 23, 31, 0.96)',
  color: '#c7d1dd',
  border: '1px solid rgba(79, 93, 113, 0.58)',
  padding: '6px 10px',
  cursor: 'pointer',
  fontFamily: 'monospace',
  fontSize: 11,
  borderRadius: 7,
};

const workspaceNameStyle: React.CSSProperties = {
  color: '#eaf0f6',
  fontSize: 15,
  fontWeight: 600,
  cursor: 'pointer',
  padding: '2px 6px',
  borderRadius: 4,
  marginLeft: -4,
};

const workspaceNameInputStyle: React.CSSProperties = {
  background: 'rgba(21, 28, 37, 0.98)',
  color: '#eaf0f6',
  border: '1px solid rgba(79, 93, 113, 0.62)',
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
  left: 0,
  minWidth: 240,
  maxHeight: 320,
  overflowY: 'auto',
  padding: 6,
  borderRadius: 8,
  border: '1px solid rgba(79, 93, 113, 0.56)',
  background: 'rgba(12, 17, 24, 0.98)',
  boxShadow: '0 12px 30px rgba(0, 0, 0, 0.45)',
  backdropFilter: 'blur(14px)',
  fontFamily: 'monospace',
  zIndex: 50,
};

const attachDropdownTitleStyle: React.CSSProperties = {
  color: '#aab4c0',
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
  color: '#c7d1dd',
  fontFamily: 'monospace',
  fontSize: 12,
  textAlign: 'left',
  cursor: 'pointer',
  borderRadius: 4,
};

const attachDropdownEmptyStyle: React.CSSProperties = {
  padding: '8px',
  color: '#666',
  fontSize: 11,
};

const settingsPopoverStyle: React.CSSProperties = {
  marginTop: 8,
  width: 220,
  padding: 12,
  borderRadius: 10,
  border: '1px solid rgba(79, 93, 113, 0.56)',
  background: 'rgba(12, 17, 24, 0.98)',
  boxShadow: '0 18px 42px rgba(0, 0, 0, 0.42)',
  backdropFilter: 'blur(14px)',
  fontFamily: 'monospace',
};

const settingsTitleStyle: React.CSSProperties = {
  color: '#eaf0f6',
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
  color: '#aab4c0',
  fontSize: 11,
};

const settingsInputStyle: React.CSSProperties = {
  width: '100%',
  border: '1px solid rgba(79, 93, 113, 0.62)',
  background: 'rgba(21, 28, 37, 0.98)',
  color: '#eaf0f6',
  borderRadius: 7,
  padding: '7px 9px',
  outline: 'none',
  fontFamily: 'monospace',
};

const settingsHintStyle: React.CSSProperties = {
  color: '#6f7987',
  fontSize: 10,
  marginTop: 8,
};

export default App;
