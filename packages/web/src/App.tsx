import { useCallback, useEffect, useRef, useState } from 'react';
import { TerminalMux, Terminal } from '@ttym/ui';
import * as api from '@ttym/api';
import type { SessionInfo } from '@ttym/ui';
import '@xterm/xterm/css/xterm.css';
import {
  MutationBarrier,
  formatCwd,
  layoutToSessionIds,
  memberNameBySession,
  reconcileSessionPanels,
  sessionIdsToLayout,
  shouldBootstrapWorkspacePanels,
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

const DEFAULT_MAX_PANELS = 3;
const MIN_MAX_PANELS = 1;
const MAX_MAX_PANELS = 8;
const LOCAL_ECHO_STORAGE_KEY = 'ttym-demo-local-echo';

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

function reconcileWorkspacePanels(
  prevPanels: PanelState[],
  sessionIds: number[],
  memberNames: Map<number, string>,
  sessionCwds?: Map<number, string>,
): PanelState[] {
  return reconcileSessionPanels(prevPanels, sessionIds, {
    createEmpty: () => ({ key: uuid() }),
    createForSession: (sessionId) => ({
      key: uuid(),
      sessionId,
      memberName: memberNames.get(sessionId),
      cwd: sessionCwds?.get(sessionId),
    }),
    decorateSession: (panel, sessionId) => ({
      ...panel,
      sessionId,
      memberName: memberNames.get(sessionId),
      cwd: sessionCwds?.get(sessionId) ?? panel.cwd,
    }),
    clearUnassigned: (panel) => ({ ...panel, sessionId: undefined }),
  });
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

function xterm256Color(code: number): string {
  if (code < 16) {
    const base = [
      '#000000', '#cd3131', '#0dbc79', '#e5e510',
      '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
      '#666666', '#f14c4c', '#23d18b', '#f5f543',
      '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
    ];
    return base[code] ?? '#d4d4d4';
  }
  if (code >= 16 && code <= 231) {
    const n = code - 16;
    const r = Math.floor(n / 36);
    const g = Math.floor((n % 36) / 6);
    const b = n % 6;
    const channel = [0, 95, 135, 175, 215, 255];
    return `rgb(${channel[r]}, ${channel[g]}, ${channel[b]})`;
  }
  const gray = 8 + (code - 232) * 10;
  return `rgb(${gray}, ${gray}, ${gray})`;
}

function ansiToHtml(value: string): string {
  let result = '';
  let index = 0;
  let column = 0;
  let fg = '#d4d4d4';
  let bg = 'transparent';
  let bold = false;
  let open = false;

  const close = () => {
    if (open) {
      result += '</span>';
      open = false;
    }
  };

  const openSpan = () => {
    close();
    result += `<span style="color:${fg};background:${bg};font-weight:${bold ? 600 : 400}">`;
    open = true;
  };

  openSpan();

  while (index < value.length) {
    const char = value[index];
    if (char === '\u001b') {
      const cursorForward = /^\u001b\[([0-9]*)C/.exec(value.slice(index));
      if (cursorForward) {
        const amount = Number(cursorForward[1] || '1');
        result += ' '.repeat(Math.max(0, amount));
        column += Math.max(0, amount);
        index += cursorForward[0].length;
        continue;
      }

      const cursorBackward = /^\u001b\[([0-9]*)D/.exec(value.slice(index));
      if (cursorBackward) {
        const amount = Number(cursorBackward[1] || '1');
        column = Math.max(0, column - Math.max(0, amount));
        index += cursorBackward[0].length;
        continue;
      }

      const cursorAbsolute = /^\u001b\[([0-9]*)G/.exec(value.slice(index));
      if (cursorAbsolute) {
        const target = Math.max(0, Number(cursorAbsolute[1] || '1') - 1);
        if (target > column) result += ' '.repeat(target - column);
        column = target;
        index += cursorAbsolute[0].length;
        continue;
      }

      const sgr = /^\u001b\[([0-9;]*)m/.exec(value.slice(index));
      if (sgr) {
        const codes = sgr[1].split(';').filter(Boolean).map((code) => Number(code));
        if (codes.length === 0) codes.push(0);
        for (let i = 0; i < codes.length; i += 1) {
          const code = codes[i];
          if (code === 0) {
            fg = '#d4d4d4';
            bg = 'transparent';
            bold = false;
          } else if (code === 1) {
            bold = true;
          } else if (code === 22) {
            bold = false;
          } else if (code === 39) {
            fg = '#d4d4d4';
          } else if (code === 49) {
            bg = 'transparent';
          } else if (code >= 30 && code <= 37) {
            fg = xterm256Color(code - 30);
          } else if (code >= 90 && code <= 97) {
            fg = xterm256Color(code - 82);
          } else if (code >= 40 && code <= 47) {
            bg = xterm256Color(code - 40);
          } else if (code >= 100 && code <= 107) {
            bg = xterm256Color(code - 92);
          } else if (code === 38 && codes[i + 1] === 5 && typeof codes[i + 2] === 'number') {
            fg = xterm256Color(codes[i + 2]);
            i += 2;
          } else if (code === 48 && codes[i + 1] === 5 && typeof codes[i + 2] === 'number') {
            bg = xterm256Color(codes[i + 2]);
            i += 2;
          }
        }
        openSpan();
        index += sgr[0].length;
        continue;
      }

      const otherEscape = /^\u001b(?:[@-Z\\-_]|\[[0-9;?]*[ -/]*[@-~])/.exec(value.slice(index));
      if (otherEscape) {
        index += otherEscape[0].length;
        continue;
      }
    }

    if (char === '&') result += '&amp;';
    else if (char === '<') result += '&lt;';
    else if (char === '>') result += '&gt;';
    else if (char === '\n') {
      result += '\n';
      column = 0;
    } else if (char !== '\r') {
      result += char;
      column += 1;
    }
    index += 1;
  }

  close();
  return result;
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
  options: { targetSessionId?: number; cwd?: string; cols?: number; rows?: number; name?: string; role?: string; cmd?: string[] } = {},
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

// ───── 워크스페이스 페이지 (분할 터미널) ─────

function WorkspacePage({ mux, workspaceId, maxPanels, localEchoEnabled }: { mux: TerminalMux; workspaceId: string; maxPanels: number; localEchoEnabled: boolean }) {
  const [wsName, setWsName] = useState(workspaceId);
  const [wsProject, setWsProject] = useState('default');
  const [memberNames, setMemberNames] = useState<Record<number, string>>({});
  const [sessionCwds, setSessionCwds] = useState<Record<number, string>>({});
  const [panels, setPanels] = useState<PanelState[]>([{ key: uuid() }]);
  const [focused, setFocused] = useState(0);
  const [draggedPanelKey, setDraggedPanelKey] = useState<string | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [standaloneSessions, setStandaloneSessions] = useState<Array<{ id: number; cwd?: string }>>([]);
  const [attachLoading, setAttachLoading] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState('');
  const panelRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const initialized = useRef(false);
  const bootstrappedInitialTerminal = useRef(false);
  const hydrationSettled = useRef(false);
  const panelsRef = useRef(panels);
  const mutationBarrierRef = useRef(new MutationBarrier());

  useEffect(() => {
    panelsRef.current = panels;
  }, [panels]);

  useEffect(() => {
    initialized.current = false;
    bootstrappedInitialTerminal.current = false;
    hydrationSettled.current = false;
    setPanels([{ key: uuid() }]);
    setFocused(0);
  }, [workspaceId]);

  const refreshWorkspaceMeta = useCallback(async () => {
    try {
      const ws = await api.getWorkspace(API_BASE, workspaceId) as Workspace;
      setWsName(ws.name);
      setWsProject(ws.project || 'default');
      const names = memberNameBySession(ws.members);
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
    api.getWorkspace(API_BASE, workspaceId)
      .catch(() => null)
      .then(async (ws: Workspace | null) => {
        if (!ws) return;
        setWsName(ws.name);
        setWsProject(ws.project || 'default');
        setMemberNames(Object.fromEntries((ws.members || []).map((member) => [member.sessionId, member.name])));
        const ids = layoutToSessionIds(ws.layout).filter((id) => id > 0);
        if (ids.length > 0) {
          const names = memberNameBySession(ws.members);
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
      .catch(() => {})
      .finally(() => {
        hydrationSettled.current = true;
      });
  }, [workspaceId]);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      if (mutationBarrierRef.current.isLocked()) return;
      const hasPendingLocalPane = panelsRef.current.some((panel) => panel.sessionId === undefined);
      if (hasPendingLocalPane) return;

      try {
        const ws = await api.getWorkspace(API_BASE, workspaceId) as Workspace;
        if (cancelled) return;

        const names = memberNameBySession(ws.members);
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
    mutationBarrierRef.current.blockFor();
    const sessionIds = nextPanels.map((p) => p.sessionId).filter((id): id is number => id !== undefined);
    const layout = sessionIdsToLayout(sessionIds);
    apiUpdateWorkspace(workspaceId, { layout });
  }, [workspaceId]);

  const add = useCallback(async () => {
    const endMutation = mutationBarrierRef.current.begin();
    const source = panelsRef.current[focused];
    try {
      const ws = await apiSplitWorkspace(workspaceId, {
        targetSessionId: source?.sessionId,
        cwd: source?.cwd,
        cols: 80,
        rows: 24,
      });
      if (!ws) return;
      setWsName(ws.name);
      setWsProject(ws.project || 'default');
      const names = memberNameBySession(ws.members);
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
    } finally {
      endMutation();
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
    mutationBarrierRef.current.blockFor();
    setPanels((prev) => {
      const panel = prev[index];
      if (panel?.sessionId !== undefined) mux.detachSession(panel.sessionId);
      return updatePanelsAfterRemoval(prev, index);
    });
  }, [mux, updatePanelsAfterRemoval]);

  const terminateAt = useCallback((index: number) => {
    mutationBarrierRef.current.blockFor();
    setPanels((prev) => {
      const panel = prev[index];
      if (panel?.sessionId !== undefined) mux.destroySession(panel.sessionId);
      return updatePanelsAfterRemoval(prev, index);
    });
  }, [mux, updatePanelsAfterRemoval]);

  const detachWorkspace = useCallback(() => {
    mutationBarrierRef.current.blockFor();
    setPanels((prev) => {
      for (const panel of prev) {
        if (panel.sessionId !== undefined) mux.detachSession(panel.sessionId);
      }
      syncWorkspace([]);
      return [{ key: uuid() }];
    });
  }, [mux, syncWorkspace]);

  const loadStandaloneSessions = useCallback(async () => {
    setAttachLoading(true);
    try {
      const [list, wsList] = await Promise.all([mux.listSessions(), fetchWorkspaces()]);
      const taken = new Set<number>();
      for (const ws of wsList) for (const m of ws.members) taken.add(m.sessionId);
      const live = list.filter((s) => s.status !== 'dead' && !taken.has(s.id));
      const enriched = await Promise.all(live.map(async (s) => {
        try {
          const meta = await fetchSessionMeta(s.id);
          return { id: s.id, cwd: typeof meta.cwd === 'string' ? meta.cwd : undefined };
        } catch {
          return { id: s.id };
        }
      }));
      setStandaloneSessions(enriched);
    } finally {
      setAttachLoading(false);
    }
  }, [mux]);

  const toggleAttach = useCallback(() => {
    setAttachOpen((prev) => {
      const next = !prev;
      if (next) void loadStandaloneSessions();
      return next;
    });
  }, [loadStandaloneSessions]);

  const attachSession = useCallback(async (sessionId: number) => {
    const endMutation = mutationBarrierRef.current.begin();
    try {
      const used = new Set(Object.values(memberNames));
      let name = '';
      for (let i = 1; i < 1000; i++) {
        const candidate = `term-${i}`;
        if (!used.has(candidate)) { name = candidate; break; }
      }
      if (!name) name = `term-${sessionId}`;
      const ws = await apiAddMember(workspaceId, sessionId, name);
      if (!ws) return;
      setWsName(ws.name);
      setWsProject(ws.project || 'default');
      const names = memberNameBySession(ws.members);
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
      const attachedIndex = ids.indexOf(sessionId);
      if (attachedIndex >= 0) setFocused(attachedIndex);
      setAttachOpen(false);
    } finally {
      endMutation();
    }
  }, [memberNames, workspaceId]);

  useEffect(() => {
    if (!attachOpen) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAttachOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [attachOpen]);

  const beginEditName = useCallback(() => {
    setDraftName(wsName);
    setEditingName(true);
  }, [wsName]);

  const commitEditName = useCallback(async () => {
    const next = draftName.trim();
    setEditingName(false);
    if (!next || next === wsName) return;
    setWsName(next);
    await apiUpdateWorkspace(workspaceId, { name: next });
  }, [draftName, wsName, workspaceId]);

  const cancelEditName = useCallback(() => {
    setEditingName(false);
  }, []);

  const removeAt = useCallback((index: number) => {
    mutationBarrierRef.current.blockFor();
    setPanels((prev) => updatePanelsAfterRemoval(prev, index));
  }, [updatePanelsAfterRemoval]);

  const markDeadAt = useCallback((index: number) => {
    setPanels((prev) => prev.map((p, i) => i === index ? { ...p, dead: true } : p));
  }, []);

  const restartAt = useCallback(async (index: number) => {
    const endMutation = mutationBarrierRef.current.begin();
    const panel = panelsRef.current[index];
    try {
      if (panel?.sessionId !== undefined) {
        await apiRemoveMember(workspaceId, panel.sessionId);
      }
      const neighbor = panelsRef.current.find((p, i) => i !== index && p.sessionId !== undefined && !p.dead);
      const ws = await apiSplitWorkspace(workspaceId, {
        targetSessionId: neighbor?.sessionId,
        cwd: panel?.cwd ?? neighbor?.cwd,
        cols: 80,
        rows: 24,
      });
      if (!ws) return;
      const names = memberNameBySession(ws.members);
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
      setFocused(index);
    } finally {
      endMutation();
    }
  }, [workspaceId]);

  const startAt = useCallback(async (index: number) => {
    const endMutation = mutationBarrierRef.current.begin();
    const source = panelsRef.current[index] ?? panelsRef.current[Math.max(0, index - 1)];
    try {
      const ws = await apiSplitWorkspace(workspaceId, {
        targetSessionId: source?.sessionId,
        cwd: source?.cwd,
        cols: 80,
        rows: 24,
      });
      if (!ws) return;
      const names = memberNameBySession(ws.members);
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
    } finally {
      endMutation();
    }
  }, [workspaceId]);

  useEffect(() => {
    if (bootstrappedInitialTerminal.current) return;
    if (!shouldBootstrapWorkspacePanels({
      initialized: initialized.current,
      hydrated: hydrationSettled.current,
      panels,
    })) return;

    bootstrappedInitialTerminal.current = true;
    void startAt(0);
  }, [panels, startAt]);

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
  // panels 레퍼런스가 아니라 focused 패널의 안정된 key에만 의존.
  // 2초 폴링이 reconcile로 panels 배열을 새로 만들어도, 같은 key면 재포커스하지 않는다.
  const focusedPanelKey = panels[focused]?.key;
  useEffect(() => {
    if (!focusedPanelKey) return;
    const el = panelRefs.current.get(focusedPanelKey);
    if (!el) return;
    el.querySelector('textarea')?.focus();
  }, [focusedPanelKey]);

  // 모든 패널이 닫히면 대시보드로
  useEffect(() => {
    if (panels.length === 0) navigate({ page: 'dashboard' });
  }, [panels.length]);

  // 브라우저 탭 제목
  useEffect(() => {
    const count = panels.filter((p) => p.sessionId !== undefined).length;
    const label = wsProject !== 'default' ? `${wsProject}/${wsName}` : wsName;
    document.title = count > 0 ? `${label} (${count})` : label;
    return () => { document.title = 'ttym demo'; };
  }, [wsName, wsProject, panels]);

  const cols = Math.max(1, Math.min(panels.length || 1, maxPanels));
  const rows = Math.max(1, Math.ceil((panels.length || 1) / maxPanels));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={toolbarStyle}>
        <button onClick={() => navigate({ page: 'dashboard' })} style={btnStyle} title="dashboard">&larr;</button>
        {wsProject !== 'default' ? (
          <span style={{ color: '#666', fontSize: 13 }}>{wsProject}/</span>
        ) : null}
        {editingName ? (
          <input
            autoFocus
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={() => { void commitEditName(); }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); void commitEditName(); }
              else if (event.key === 'Escape') { event.preventDefault(); cancelEditName(); }
            }}
            style={workspaceNameInputStyle}
          />
        ) : (
          <span
            onClick={beginEditName}
            style={workspaceNameStyle}
            title="click to rename"
          >
            {wsName}
          </span>
        )}
        <button onClick={add} style={btnStyle}>+ split</button>
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
                  <button
                    key={s.id}
                    onClick={() => void attachSession(s.id)}
                    style={attachDropdownItemStyle}
                    title={s.cwd ?? ''}
                  >
                    <span style={{ color: '#eaf0f6' }}>#{s.id}</span>
                    {s.cwd ? <span style={{ color: '#8892a0', marginLeft: 8, fontSize: 10 }}>{s.cwd}</span> : null}
                  </button>
                ))
              )}
            </div>
          ) : null}
        </span>
        <button onClick={detachWorkspace} style={btnStyle}>detach</button>
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
                  borderTop: panel.dead ? '2px solid #a55' : isFocused ? '2px solid #007acc' : '2px solid transparent',
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
                  {panel.sessionId !== undefined && !panel.dead ? (
                    <Terminal
                      mux={mux}
                      attachId={panel.sessionId}
                      localEcho={localEchoEnabled}
                      onExit={() => markDeadAt(i)}
                    />
                  ) : (
                    <div style={{
                      height: '100%',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: '#151515',
                      color: '#666',
                      fontFamily: 'monospace',
                      fontSize: 12,
                      gap: 8,
                    }}>
                      {panel.dead ? (
                        <>
                          <span style={{ color: '#a55', fontSize: 11 }}>session ended</span>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button onClick={() => void restartAt(i)} style={actionBtnStyle}>restart</button>
                            <button onClick={() => removeAt(i)} style={{ ...actionBtnStyle, background: '#333', color: '#888' }}>close</button>
                          </div>
                        </>
                      ) : (
                        <button onClick={() => void startAt(i)} style={actionBtnStyle}>start terminal</button>
                      )}
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
  localEchoEnabled,
  onChange,
  onLocalEchoChange,
}: {
  maxPanels: number;
  localEchoEnabled: boolean;
  onChange: (value: number) => void;
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
          <label style={{ ...settingsFieldStyle, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <span style={settingsLabelStyle}>optimistic local echo</span>
            <input
              type="checkbox"
              checked={localEchoEnabled}
              onChange={(event) => onLocalEchoChange(event.target.checked)}
            />
          </label>
          <div style={settingsHintStyle}>experimental: predicts printable shell echo before server confirmation</div>
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
  const [maxPanels, setMaxPanels] = useState(readMaxPanels);
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
      page = <WorkspacePage key={route.id} mux={mux} workspaceId={route.id} maxPanels={maxPanels} localEchoEnabled={localEchoEnabled} />;
      break;
    default:
      page = <DashboardPage mux={mux} />;
      break;
  }

  return (
    <>
      {page}
      <SettingsOverlay
        maxPanels={maxPanels}
        localEchoEnabled={localEchoEnabled}
        onChange={handleMaxPanelsChange}
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
