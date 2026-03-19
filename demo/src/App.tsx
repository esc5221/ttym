import { useCallback, useEffect, useRef, useState } from 'react';
import { TerminalMux, Terminal } from '@ttym/client';
import type { SessionInfo } from '@ttym/client';
import '@xterm/xterm/css/xterm.css';

/** crypto.randomUUID fallback for non-secure contexts (HTTP over LAN) */
function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ───── Workspace 타입 + Server API ─────

interface PaneNode { type: 'pane'; sessionId: number; }
interface SplitNode { type: 'split'; axis: 'row' | 'col'; sizes: number[]; children: LayoutNode[]; }
type LayoutNode = PaneNode | SplitNode;

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

const DEFAULT_MAX_PANELS = 3;
const MIN_MAX_PANELS = 1;
const MAX_MAX_PANELS = 8;

function clampMaxPanels(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_PANELS;
  return Math.max(MIN_MAX_PANELS, Math.min(MAX_MAX_PANELS, Math.trunc(value)));
}

function readMaxPanels(): number {
  const raw = new URLSearchParams(window.location.search).get('maxPanels');
  if (!raw) return DEFAULT_MAX_PANELS;
  return clampMaxPanels(Number(raw));
}

function writeMaxPanels(value: number) {
  const next = clampMaxPanels(value);
  const url = new URL(window.location.href);
  url.searchParams.set('maxPanels', String(next));
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

/** Derive ttym server host from current page URL */
function getTtymHost(): string {
  const h = window.location.hostname;
  // ttym-ui.lullu.lan → ttym.lullu.lan (Caddy proxy, port 80)
  if (h.startsWith('ttym-ui.')) return `ttym.${h.slice(8)}`;
  // localhost / IP dev mode → same host, port 7690
  return `${h}:7690`;
}
const TTYM_HOST = getTtymHost();
const API_BASE = `http://${TTYM_HOST}`;

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

/** Extract flat sessionId list from layout tree */
function layoutToSessionIds(node: LayoutNode): number[] {
  if (node.type === 'pane') return [node.sessionId];
  return node.children.flatMap(layoutToSessionIds);
}

/** Build flat row layout from sessionId list */
function sessionIdsToLayout(ids: number[]): LayoutNode {
  if (ids.length === 0) return { type: 'pane', sessionId: 0 };
  if (ids.length === 1) return { type: 'pane', sessionId: ids[0] };
  return {
    type: 'split', axis: 'row',
    sizes: ids.map(() => 1 / ids.length),
    children: ids.map((id) => ({ type: 'pane' as const, sessionId: id })),
  };
}

function reconcileWorkspacePanels(
  prevPanels: PanelState[],
  sessionIds: number[],
  memberNames: Map<number, string>,
  sessionCwds?: Map<number, string>,
): PanelState[] {
  const unusedPrev = [...prevPanels];
  const nextPanels = (sessionIds.length > 0 ? sessionIds : [undefined]).map((sessionId) => {
    if (sessionId !== undefined) {
      const matchedIndex = unusedPrev.findIndex((panel) => panel.sessionId === sessionId);
      if (matchedIndex >= 0) {
        const [matched] = unusedPrev.splice(matchedIndex, 1);
        return { ...matched, sessionId, memberName: memberNames.get(sessionId), cwd: sessionCwds?.get(sessionId) ?? matched.cwd };
      }
    }

    const fallback = unusedPrev.shift();
    if (fallback) {
      return {
        ...fallback,
        sessionId,
        memberName: sessionId !== undefined ? memberNames.get(sessionId) : fallback.memberName,
        cwd: sessionId !== undefined ? sessionCwds?.get(sessionId) ?? fallback.cwd : fallback.cwd,
      };
    }

    return sessionId === undefined
      ? { key: uuid() }
      : { key: uuid(), sessionId, memberName: memberNames.get(sessionId), cwd: sessionCwds?.get(sessionId) };
  });

  const pendingPanels = unusedPrev.filter((panel) => panel.sessionId === undefined);
  if (pendingPanels.length > 0 && nextPanels.every((panel) => panel.sessionId !== undefined)) {
    return [...nextPanels, ...pendingPanels];
  }
  return nextPanels;
}

function insertPanelRight(panels: PanelState[], focused: number, panel: PanelState): { panels: PanelState[]; focus: number } {
  const insertAt = Math.min(Math.max(0, focused + 1), panels.length);
  const nextPanels = [...panels];
  nextPanels.splice(insertAt, 0, panel);
  return { panels: nextPanels, focus: insertAt };
}

function movePanel(panels: PanelState[], fromIndex: number, toIndex: number): PanelState[] {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= panels.length || toIndex >= panels.length) {
    return panels;
  }
  const next = [...panels];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

function formatCwd(cwd?: string): string | null {
  if (!cwd) return null;
  return cwd.replace(/^\/Users\/[^/]+\b/, '~');
}

async function fetchSessionMeta(sessionId: number): Promise<SessionMeta> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/meta`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchWorkspaces(): Promise<Workspace[]> {
  try {
    const res = await fetch(`${API_BASE}/api/workspaces`);
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

async function apiCreateWorkspace(ws: { id: string; name: string; layout: LayoutNode }): Promise<Workspace | null> {
  try {
    const res = await fetch(`${API_BASE}/api/workspaces`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ws),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function workspaceLabel(workspace: Workspace): string {
  return workspace.project && workspace.project !== 'default'
    ? `${workspace.project}/${workspace.name}`
    : workspace.name;
}

function memberNameBySession(workspace: Workspace): Map<number, string> {
  return new Map((workspace.members || []).map((member) => [member.sessionId, member.name]));
}

function memberLabel(name: string | undefined, sessionId: number): string {
  return name ? `${name} · #${sessionId}` : `#${sessionId}`;
}

function sessionWorkspaceMembership(workspaces: Workspace[]): Map<number, { workspace: Workspace; memberName?: string }> {
  const membership = new Map<number, { workspace: Workspace; memberName?: string }>();
  for (const workspace of workspaces) {
    const names = memberNameBySession(workspace);
    for (const sessionId of layoutToSessionIds(workspace.layout).filter((id) => id > 0)) {
      membership.set(sessionId, { workspace, memberName: names.get(sessionId) });
    }
  }
  return membership;
}

async function apiUpdateWorkspace(id: string, patch: { name?: string; layout?: LayoutNode }): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/workspaces/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  } catch {}
}

async function apiDeleteWorkspace(id: string): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch {}
}

async function apiSplitWorkspace(
  id: string,
  options: { targetSessionId?: number; cwd?: string; cols?: number; rows?: number; name?: string; role?: string; cmd?: string[] } = {},
): Promise<Workspace | null> {
  try {
    const res = await fetch(`${API_BASE}/api/workspaces/${encodeURIComponent(id)}/split`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.workspace ?? null;
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
  const membership = sessionWorkspaceMembership(workspaces);

  // 세션이 죽은 것을 워크스페이스에서 정리 (로딩 완료 후에만)
  useEffect(() => {
    if (loading || sessions.length === 0) return;
    const aliveIds = new Set(sessions.map((s) => s.id));
    let changed = false;
    for (const ws of workspaces) {
      const ids = layoutToSessionIds(ws.layout);
      const liveIds = ids.filter((id) => aliveIds.has(id));
      if (liveIds.length !== ids.length) {
        const newLayout = sessionIdsToLayout(liveIds);
        apiUpdateWorkspace(ws.id, { layout: newLayout });
        ws.layout = newLayout;
        changed = true;
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
    <div style={{ padding: 32, fontFamily: 'monospace', color: '#ccc', maxWidth: 700 }}>
      {/* OVERVIEW LINK */}
      <div style={{ marginBottom: 24 }}>
        <button
          onClick={() => navigate({ page: 'overview' })}
          style={{ ...actionBtnStyle, background: '#0d3a58', color: '#4fc3f7', border: '1px solid #007acc' }}
        >
          overview — live preview
        </button>
      </div>

      {/* WORKSPACES */}
      <div style={{ marginBottom: 32 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
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
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', background: '#252525', cursor: 'pointer' }}
                onClick={() => navigate({ page: 'workspace', id: ws.id })}
              >
                <span style={{ color: '#eee', flex: 1 }}>{workspaceLabel(ws)}</span>
                <span style={{ color: '#666', fontSize: 11 }}>
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

      {/* SESSIONS */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {sessions.map((s) => (
              (() => {
                const info = membership.get(s.id);
                const title = info?.memberName ? info.memberName : `#${s.id}`;
                const meta = info ? workspaceLabel(info.workspace) : 'standalone';
                return (
              <div
                key={s.id}
                onClick={() => navigate({ page: 'session', id: s.id })}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px',
                  background: '#252525', cursor: 'pointer',
                  borderLeft: `3px solid ${s.status === 'attached' ? '#007acc' : '#555'}`,
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, width: 72 }}>
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
                <span style={{
                  fontSize: 11, padding: '1px 6px', borderRadius: 3,
                  background: s.status === 'attached' ? '#0d3a58' : '#333',
                  color: s.status === 'attached' ? '#4fc3f7' : '#888',
                }}>
                  {s.status}
                </span>
                <span style={{ color: '#555', fontSize: 11 }}>pid {s.pid}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); navigate({ page: 'viewer', id: s.id }); }}
                  style={{ ...actionBtnStyle, padding: '1px 6px', fontSize: 10, background: '#2a2a2a' }}
                  title="View readonly"
                >
                  view
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); mux.destroySession(s.id); refresh(); }}
                  style={{ ...closeBtnStyle, color: '#555', fontSize: 12 }}
                  title="Kill session"
                >
                  ×
                </button>
              </div>
                );
              })()
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ───── 단일 세션 페이지 ─────

function SessionPage({ mux, sessionId }: { mux: TerminalMux; sessionId: number }) {
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
        <Terminal mux={mux} attachId={sessionId} onExit={() => navigate({ page: 'dashboard' })} />
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

// ───── 워크스페이스 페이지 (분할 터미널) ─────

function WorkspacePage({ mux, workspaceId, maxPanels }: { mux: TerminalMux; workspaceId: string; maxPanels: number }) {
  const [wsName, setWsName] = useState(workspaceId);
  const [wsProject, setWsProject] = useState('default');
  const [memberNames, setMemberNames] = useState<Record<number, string>>({});
  const [sessionCwds, setSessionCwds] = useState<Record<number, string>>({});
  const [panels, setPanels] = useState<PanelState[]>([{ key: uuid() }]);
  const [focused, setFocused] = useState(0);
  const [draggedPanelKey, setDraggedPanelKey] = useState<string | null>(null);
  const panelRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const initialized = useRef(false);
  const panelsRef = useRef(panels);

  useEffect(() => {
    panelsRef.current = panels;
  }, [panels]);

  const refreshWorkspaceMeta = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/workspaces/${encodeURIComponent(workspaceId)}`);
      if (!res.ok) return;
      const ws: Workspace = await res.json();
      setWsName(ws.name);
      setWsProject(ws.project || 'default');
      const names = memberNameBySession(ws);
      const ids = layoutToSessionIds(ws.layout).filter((id) => id > 0);
      const cwdEntries = await Promise.all(ids.map(async (id) => {
        try {
          const meta = await fetchSessionMeta(id);
          return [id, typeof meta.cwd === 'string' ? meta.cwd : ''] as const;
        } catch {
          return [id, ''] as const;
        }
      }));
      const cwdMap = new Map(cwdEntries.filter(([, cwd]) => cwd).map(([id, cwd]) => [id, cwd]));
      setMemberNames(Object.fromEntries(names));
      setSessionCwds(Object.fromEntries(cwdMap));
      setPanels((prev) => prev.map((panel) => (
        panel.sessionId !== undefined ? { ...panel, memberName: names.get(panel.sessionId), cwd: cwdMap.get(panel.sessionId) ?? panel.cwd } : panel
      )));
    } catch {}
  }, [workspaceId]);

  // 서버에서 workspace 로드
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    fetch(`${API_BASE}/api/workspaces/${encodeURIComponent(workspaceId)}`)
      .then((res) => res.ok ? res.json() : null)
      .then(async (ws: Workspace | null) => {
        if (!ws) return;
        setWsName(ws.name);
        setWsProject(ws.project || 'default');
        setMemberNames(Object.fromEntries((ws.members || []).map((member) => [member.sessionId, member.name])));
        const ids = layoutToSessionIds(ws.layout).filter((id) => id > 0);
        if (ids.length > 0) {
          const names = memberNameBySession(ws);
          const cwdEntries = await Promise.all(ids.map(async (id) => {
            try {
              const meta = await fetchSessionMeta(id);
              return [id, typeof meta.cwd === 'string' ? meta.cwd : ''] as const;
            } catch {
              return [id, ''] as const;
            }
          }));
          const cwdMap = new Map(cwdEntries.filter(([, cwd]) => cwd).map(([id, cwd]) => [id, cwd]));
          setSessionCwds(Object.fromEntries(cwdMap));
          setPanels(ids.map((id) => ({ key: uuid(), sessionId: id, memberName: names.get(id), cwd: cwdMap.get(id) })));
        }
      })
      .catch(() => {});
  }, [workspaceId]);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      const hasPendingLocalPane = panelsRef.current.some((panel) => panel.sessionId === undefined);
      if (hasPendingLocalPane) return;

      try {
        const res = await fetch(`${API_BASE}/api/workspaces/${encodeURIComponent(workspaceId)}`);
        if (!res.ok) return;
        const ws: Workspace = await res.json();
        if (cancelled) return;

        const names = memberNameBySession(ws);
        const ids = layoutToSessionIds(ws.layout).filter((id) => id > 0);
        const cwdEntries = await Promise.all(ids.map(async (id) => {
          try {
            const meta = await fetchSessionMeta(id);
            return [id, typeof meta.cwd === 'string' ? meta.cwd : ''] as const;
          } catch {
            return [id, ''] as const;
          }
        }));
        const cwdMap = new Map(cwdEntries.filter(([, cwd]) => cwd).map(([id, cwd]) => [id, cwd]));
        setWsName(ws.name);
        setWsProject(ws.project || 'default');
        setMemberNames(Object.fromEntries(names));
        setSessionCwds((prev) => ({ ...prev, ...Object.fromEntries(cwdMap) }));
        setPanels((prev) => reconcileWorkspacePanels(prev, ids, names, cwdMap));
        setFocused((current) => Math.min(current, Math.max(0, Math.max(ids.length, 1) - 1)));
      } catch {}
    };

    const interval = window.setInterval(() => { void tick(); }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [workspaceId]);

  // 워크스페이스에 세션 ID 동기화 (서버)
  const syncWorkspace = useCallback((nextPanels: PanelState[]) => {
    const sessionIds = nextPanels.map((p) => p.sessionId).filter((id): id is number => id !== undefined);
    const layout = sessionIdsToLayout(sessionIds);
    apiUpdateWorkspace(workspaceId, { layout });
  }, [workspaceId]);

  const add = useCallback(async () => {
    const source = panelsRef.current[focused];
    const ws = await apiSplitWorkspace(workspaceId, {
      targetSessionId: source?.sessionId,
      cwd: source?.cwd,
      cols: 80,
      rows: 24,
    });
    if (!ws) return;
    setWsName(ws.name);
    setWsProject(ws.project || 'default');
    const names = memberNameBySession(ws);
    const ids = layoutToSessionIds(ws.layout).filter((id) => id > 0);
    const cwdEntries = await Promise.all(ids.map(async (id) => {
      try {
        const meta = await fetchSessionMeta(id);
        return [id, typeof meta.cwd === 'string' ? meta.cwd : ''] as const;
      } catch {
        return [id, ''] as const;
      }
    }));
    const cwdMap = new Map(cwdEntries.filter(([, cwd]) => cwd).map(([id, cwd]) => [id, cwd]));
    setMemberNames(Object.fromEntries(names));
    setSessionCwds((prev) => ({ ...prev, ...Object.fromEntries(cwdMap) }));
    setPanels((prev) => reconcileWorkspacePanels(prev, ids, names, cwdMap));
    if (source?.sessionId !== undefined) {
      const targetIndex = ids.indexOf(source.sessionId);
      if (targetIndex >= 0) setFocused(Math.min(targetIndex + 1, ids.length - 1));
    } else {
      setFocused(Math.max(0, ids.length - 1));
    }
  }, [focused, workspaceId]);

  const updatePanelsAfterRemoval = useCallback((prev: PanelState[], index: number) => {
    const next = prev.filter((_, i) => i !== index);
    setFocused((f) => {
      if (next.length === 0) return 0;
      if (f >= next.length) return next.length - 1;
      if (f > index) return f - 1;
      if (f === index) return Math.min(f, next.length - 1);
      return f;
    });
    syncWorkspace(next);
    return next.length === 0 ? [{ key: uuid() }] : next;
  }, [syncWorkspace]);

  const detachAt = useCallback((index: number) => {
    setPanels((prev) => {
      const panel = prev[index];
      if (panel?.sessionId !== undefined) mux.detachSession(panel.sessionId);
      return updatePanelsAfterRemoval(prev, index);
    });
  }, [mux, updatePanelsAfterRemoval]);

  const terminateAt = useCallback((index: number) => {
    setPanels((prev) => {
      const panel = prev[index];
      if (panel?.sessionId !== undefined) mux.destroySession(panel.sessionId);
      return updatePanelsAfterRemoval(prev, index);
    });
  }, [mux, updatePanelsAfterRemoval]);

  const detachWorkspace = useCallback(() => {
    setPanels((prev) => {
      for (const panel of prev) {
        if (panel.sessionId !== undefined) mux.detachSession(panel.sessionId);
      }
      syncWorkspace([]);
      return [{ key: uuid() }];
    });
  }, [mux, syncWorkspace]);

  const removeAt = useCallback((index: number) => {
    setPanels((prev) => updatePanelsAfterRemoval(prev, index));
  }, [updatePanelsAfterRemoval]);

  const startAt = useCallback(async (index: number) => {
    const source = panelsRef.current[index] ?? panelsRef.current[Math.max(0, index - 1)];
    const ws = await apiSplitWorkspace(workspaceId, {
      targetSessionId: source?.sessionId,
      cwd: source?.cwd,
      cols: 80,
      rows: 24,
    });
    if (!ws) return;
    const names = memberNameBySession(ws);
    const ids = layoutToSessionIds(ws.layout).filter((id) => id > 0);
    const cwdEntries = await Promise.all(ids.map(async (id) => {
      try {
        const meta = await fetchSessionMeta(id);
        return [id, typeof meta.cwd === 'string' ? meta.cwd : ''] as const;
      } catch {
        return [id, ''] as const;
      }
    }));
    const cwdMap = new Map(cwdEntries.filter(([, cwd]) => cwd).map(([id, cwd]) => [id, cwd]));
    setMemberNames(Object.fromEntries(names));
    setSessionCwds((prev) => ({ ...prev, ...Object.fromEntries(cwdMap) }));
    setPanels((prev) => reconcileWorkspacePanels(prev, ids, names, cwdMap));
    setFocused(Math.min(index, Math.max(0, ids.length - 1)));
  }, [workspaceId]);

  const movePaneTo = useCallback((fromKey: string, toIndex: number) => {
    setPanels((prev) => {
      const fromIndex = prev.findIndex((panel) => panel.key === fromKey);
      if (fromIndex < 0) return prev;
      const next = movePanel(prev, fromIndex, toIndex);
      syncWorkspace(next);
      setFocused(next.findIndex((panel) => panel.key === fromKey));
      return next;
    });
  }, [syncWorkspace]);

  const focusPrev = useCallback(() => setFocused((f) => (f > 0 ? f - 1 : f)), []);
  const focusNext = useCallback(() => {
    setPanels((p) => { setFocused((f) => (f < p.length - 1 ? f + 1 : f)); return p; });
  }, []);

  // 키바인딩
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === '\\') { e.preventDefault(); add(); return; }
      if (meta && e.code === 'ArrowLeft') { e.preventDefault(); focusPrev(); return; }
      if (meta && e.code === 'ArrowRight') { e.preventDefault(); focusNext(); return; }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [add, terminateAt, focusPrev, focusNext, focused]);

  // 포커스 시 xterm textarea에 포커스
  useEffect(() => {
    const panel = panels[focused];
    if (!panel) return;
    const el = panelRefs.current.get(panel.key);
    if (!el) return;
    el.querySelector('textarea')?.focus();
  }, [focused, panels]);

  // 모든 패널이 닫히면 대시보드로
  useEffect(() => {
    if (panels.length === 0) navigate({ page: 'dashboard' });
  }, [panels.length]);

  const cols = Math.max(1, Math.min(panels.length || 1, maxPanels));
  const rows = Math.max(1, Math.ceil((panels.length || 1) / maxPanels));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={toolbarStyle}>
        <button onClick={() => navigate({ page: 'dashboard' })} style={btnStyle}>&larr; dashboard</button>
        <span style={{ color: '#aaa', fontSize: 12 }}>{wsProject !== 'default' ? `${wsProject}/${wsName}` : wsName}</span>
        <button onClick={add} style={btnStyle}>+ split</button>
        <button onClick={detachWorkspace} style={btnStyle}>detach</button>
        <span style={{ color: '#666', fontSize: 12 }}>
          {panels.length} pane{panels.length > 1 ? 's' : ''} across {rows} row{rows > 1 ? 's' : ''}
        </span>
        <span style={{ color: '#444', fontSize: 11, marginLeft: 'auto' }}>
          {'\u2318\\ split \u2003 drag reorder \u2003 \u2318\u2190\u2192 navigate'}
        </span>
      </div>

      {panels.length === 0 ? null : (
        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`, gap: 0, background: '#1e1e1e', overflow: 'hidden' }}>
          {panels.map((panel, i) => {
            const isFocused = i === focused;
            return (
              <div
                key={panel.key}
                ref={(el) => { if (el) panelRefs.current.set(panel.key, el); else panelRefs.current.delete(panel.key); }}
                onClick={() => setFocused(i)}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (!draggedPanelKey) return;
                  movePaneTo(draggedPanelKey, i);
                  setDraggedPanelKey(null);
                }}
                style={{
                  display: 'flex', flexDirection: 'column', background: '#1e1e1e',
                  minHeight: 0, contain: 'strict',
                  borderLeft: i > 0 ? '1px solid #333' : 'none',
                }}
              >
                {/* title bar */}
                <div style={{
                  display: 'flex', alignItems: 'center', height: 34, padding: '0 8px',
                  background: isFocused ? '#1e1e1e' : '#181818',
                  borderTop: isFocused ? '2px solid #007acc' : '2px solid transparent',
                  borderBottom: '1px solid #333', flexShrink: 0, userSelect: 'none',
                }}
                draggable
                onDragStart={() => setDraggedPanelKey(panel.key)}
                onDragEnd={() => setDraggedPanelKey(null)}
                >
                  <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1, minWidth: 0 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                      <span style={{ color: isFocused ? '#ccc' : '#666', fontSize: 11, fontFamily: 'monospace' }}>
                        {panel.sessionId ? (panel.memberName || `#${panel.sessionId}`) : 'new'}
                      </span>
                      {panel.sessionId && panel.memberName ? (
                        <span style={{ color: '#555', fontSize: 10, fontFamily: 'monospace' }}>#{panel.sessionId}</span>
                      ) : null}
                    </span>
                    {panel.cwd ? (
                      <span
                        style={{
                          color: isFocused ? '#6b90b1' : '#4d6175',
                          fontSize: 10,
                          fontFamily: 'monospace',
                          maxWidth: '42vw',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={panel.cwd}
                      >
                        {formatCwd(panel.cwd)}
                      </span>
                    ) : null}
                  </span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                    {panel.sessionId ? (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          detachAt(i);
                        }}
                        style={miniLinkBtnStyle}
                        title="Detach pane"
                      >
                        detach
                      </button>
                    ) : null}
                    {panel.sessionId ? (
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          await copySessionUrl(panel.sessionId!);
                        }}
                        style={miniLinkBtnStyle}
                        title={`Copy ${getSessionUrl(panel.sessionId)}`}
                      >
                        copy
                      </button>
                    ) : null}
                  </span>
                  {panel.sessionId !== undefined && (
                    <button
                      onClick={(e) => { e.stopPropagation(); terminateAt(i); }}
                      style={closeBtnStyle}
                      title="Terminate"
                    >
                      ×
                    </button>
                  )}
                </div>
                <div style={{ flex: 1, minHeight: 0 }}>
                  {panel.sessionId !== undefined ? (
                    <Terminal
                      mux={mux}
                      attachId={panel.sessionId}
                      onExit={() => removeAt(i)}
                    />
                  ) : (
                    <div style={{
                      height: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: '#151515',
                      color: '#666',
                      fontFamily: 'monospace',
                      fontSize: 12,
                    }}>
                      <button onClick={() => void startAt(i)} style={actionBtnStyle}>start terminal</button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SettingsOverlay({
  maxPanels,
  onChange,
}: {
  maxPanels: number;
  onChange: (value: number) => void;
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
          <label style={settingsFieldStyle}>
            <span style={settingsLabelStyle}>max columns</span>
            <input
              type="number"
              min={MIN_MAX_PANELS}
              max={MAX_MAX_PANELS}
              value={maxPanels}
              onChange={(event) => onChange(Number(event.target.value))}
              style={settingsInputStyle}
            />
          </label>
          <div style={settingsHintStyle}>query: `maxPanels` (columns per row)</div>
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
                  {workspaceLabel(ws)}
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
        <Terminal mux={mux} attachId={sessionId} mode="readonly" fontSize={9} />
      </div>
    </div>
  );
}

// ───── App (라우터) ─────

function App() {
  const muxRef = useRef<TerminalMux | null>(null);
  const [connected, setConnected] = useState(false);
  const [route, setRoute] = useState<Route>(parseHash);
  const [maxPanels, setMaxPanels] = useState(readMaxPanels);

  useEffect(() => {
    const mux = new TerminalMux(`ws://${TTYM_HOST}`);
    muxRef.current = mux;
    mux.connect().then(() => setConnected(true));
    return () => mux.disconnect();
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const syncFromLocation = () => setMaxPanels(readMaxPanels());
    window.addEventListener('popstate', syncFromLocation);
    return () => window.removeEventListener('popstate', syncFromLocation);
  }, []);

  const handleMaxPanelsChange = useCallback((value: number) => {
    const next = clampMaxPanels(value);
    writeMaxPanels(next);
    setMaxPanels(next);
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
      page = <SessionPage mux={mux} sessionId={route.id} />;
      break;
    case 'viewer':
      page = <ViewerPage mux={mux} sessionId={route.id} />;
      break;
    case 'workspace':
      page = <WorkspacePage key={route.id} mux={mux} workspaceId={route.id} maxPanels={maxPanels} />;
      break;
    default:
      page = <DashboardPage mux={mux} />;
      break;
  }

  return (
    <>
      {page}
      <SettingsOverlay maxPanels={maxPanels} onChange={handleMaxPanelsChange} />
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
