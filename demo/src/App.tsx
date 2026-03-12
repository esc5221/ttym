import { useCallback, useEffect, useRef, useState } from 'react';
import { TerminalMux, Terminal } from '@ttym/client';
import type { SessionInfo } from '@ttym/client';
import '@xterm/xterm/css/xterm.css';

// ───── Workspace 타입 + localStorage 관리 ─────

interface Workspace {
  id: string;
  name: string;
  sessionIds: number[];
}

const STORAGE_KEY = 'ttym-workspaces';

function loadWorkspaces(): Workspace[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveWorkspaces(ws: Workspace[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ws));
}

// ───── 해시 라우팅 ─────

type Route =
  | { page: 'dashboard' }
  | { page: 'session'; id: number }
  | { page: 'viewer'; id: number }
  | { page: 'workspace'; id: string };

function parseHash(): Route {
  const hash = window.location.hash;
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
    case 'session': window.location.hash = `s/${route.id}`; break;
    case 'viewer': window.location.hash = `v/${route.id}`; break;
    case 'workspace': window.location.hash = `w/${route.id}`; break;
  }
}

// ───── 대시보드 ─────

function DashboardPage({ mux }: { mux: TerminalMux }) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>(loadWorkspaces);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await mux.listSessions();
      setSessions(list.filter((s) => s.status !== 'dead'));
    } catch {}
    setLoading(false);
  }, [mux]);

  useEffect(() => { refresh(); }, [refresh]);

  // 세션이 죽은 것을 워크스페이스에서 정리 (로딩 완료 후에만)
  useEffect(() => {
    if (loading || sessions.length === 0) return;
    const aliveIds = new Set(sessions.map((s) => s.id));
    const updated = workspaces.map((w) => ({
      ...w,
      sessionIds: w.sessionIds.filter((id) => aliveIds.has(id)),
    }));
    const changed = updated.some((w, i) => w.sessionIds.length !== workspaces[i].sessionIds.length);
    if (changed) {
      setWorkspaces(updated);
      saveWorkspaces(updated);
    }
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

  const createWorkspace = useCallback(() => {
    const ws: Workspace = {
      id: crypto.randomUUID().slice(0, 8),
      name: `workspace ${workspaces.length + 1}`,
      sessionIds: [],
    };
    const next = [...workspaces, ws];
    setWorkspaces(next);
    saveWorkspaces(next);
    navigate({ page: 'workspace', id: ws.id });
  }, [workspaces]);

  const deleteWorkspace = useCallback((wsId: string) => {
    const next = workspaces.filter((w) => w.id !== wsId);
    setWorkspaces(next);
    saveWorkspaces(next);
  }, [workspaces]);

  return (
    <div style={{ padding: 32, fontFamily: 'monospace', color: '#ccc', maxWidth: 700 }}>
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
                <span style={{ color: '#eee', flex: 1 }}>{ws.name}</span>
                <span style={{ color: '#666', fontSize: 11 }}>
                  {ws.sessionIds.length} session{ws.sessionIds.length !== 1 ? 's' : ''}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteWorkspace(ws.id); }}
                  style={{ ...closeBtnStyle, color: '#555', fontSize: 12 }}
                  title="Delete workspace"
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
              <div
                key={s.id}
                onClick={() => navigate({ page: 'session', id: s.id })}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px',
                  background: '#252525', cursor: 'pointer',
                  borderLeft: `3px solid ${s.status === 'attached' ? '#007acc' : '#555'}`,
                }}
              >
                <span style={{ color: '#eee', fontWeight: 600, width: 36 }}>#{s.id}</span>
                <span style={{ color: '#aaa', flex: 1 }}>{s.cmd.join(' ')}</span>
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
        <span style={{ color: '#aaa', fontSize: 12 }}>session #{sessionId}</span>
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
        <span style={{ color: '#aaa', fontSize: 12 }}>session #{sessionId}</span>
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

function WorkspacePage({ mux, workspaceId }: { mux: TerminalMux; workspaceId: string }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>(loadWorkspaces);
  const ws = workspaces.find((w) => w.id === workspaceId);

  const [panels, setPanels] = useState<{ key: string; sessionId?: number }[]>(() => {
    if (!ws || ws.sessionIds.length === 0) return [{ key: crypto.randomUUID() }];
    return ws.sessionIds.map((id) => ({ key: crypto.randomUUID(), sessionId: id }));
  });
  const [focused, setFocused] = useState(0);
  const panelRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // 워크스페이스에 세션 ID 동기화
  const syncWorkspace = useCallback((sessionIds: number[]) => {
    const all = loadWorkspaces();
    const idx = all.findIndex((w) => w.id === workspaceId);
    if (idx !== -1) {
      all[idx].sessionIds = sessionIds;
      saveWorkspaces(all);
      setWorkspaces(all);
    }
  }, [workspaceId]);

  const add = useCallback(() => {
    setPanels((p) => {
      const next = [...p, { key: crypto.randomUUID() }];
      setFocused(next.length - 1);
      return next;
    });
  }, []);

  const removeAt = useCallback((index: number) => {
    setPanels((prev) => {
      const next = prev.filter((_, i) => i !== index);
      setFocused((f) => {
        if (next.length === 0) return 0;
        if (f >= next.length) return next.length - 1;
        if (f > index) return f - 1;
        if (f === index) return Math.min(f, next.length - 1);
        return f;
      });
      // sync surviving session ids
      const ids = next.map((p) => p.sessionId).filter((id): id is number => id !== undefined);
      syncWorkspace(ids);
      return next;
    });
  }, [syncWorkspace]);

  const handleCreated = useCallback((index: number, sessionId: number) => {
    setPanels((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], sessionId };
      const ids = next.map((p) => p.sessionId).filter((id): id is number => id !== undefined);
      syncWorkspace(ids);
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
      if (meta && e.key === 'w') { e.preventDefault(); removeAt(focused); return; }
      if (meta && e.code === 'ArrowLeft') { e.preventDefault(); focusPrev(); return; }
      if (meta && e.code === 'ArrowRight') { e.preventDefault(); focusNext(); return; }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [add, removeAt, focusPrev, focusNext, focused]);

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

  const cols = Math.min(panels.length, 3);
  const wsName = ws?.name ?? workspaceId;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={toolbarStyle}>
        <button onClick={() => navigate({ page: 'dashboard' })} style={btnStyle}>&larr; dashboard</button>
        <span style={{ color: '#aaa', fontSize: 12 }}>{wsName}</span>
        <button onClick={add} style={btnStyle}>+ split</button>
        <span style={{ color: '#666', fontSize: 12 }}>
          {panels.length} session{panels.length > 1 ? 's' : ''}
        </span>
        <span style={{ color: '#444', fontSize: 11, marginLeft: 'auto' }}>
          {'\u2318\\ split \u2003 \u2318W close \u2003 \u2318\u2190\u2192 navigate'}
        </span>
      </div>

      {panels.length === 0 ? null : (
        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 0, background: '#1e1e1e', overflow: 'hidden' }}>
          {panels.map((panel, i) => {
            const isFocused = i === focused;
            return (
              <div
                key={panel.key}
                ref={(el) => { if (el) panelRefs.current.set(panel.key, el); else panelRefs.current.delete(panel.key); }}
                onClick={() => setFocused(i)}
                style={{
                  display: 'flex', flexDirection: 'column', background: '#1e1e1e',
                  minHeight: 0, contain: 'strict',
                  borderLeft: i > 0 ? '1px solid #333' : 'none',
                }}
              >
                {/* title bar */}
                <div style={{
                  display: 'flex', alignItems: 'center', height: 28, padding: '0 8px',
                  background: isFocused ? '#1e1e1e' : '#181818',
                  borderTop: isFocused ? '2px solid #007acc' : '2px solid transparent',
                  borderBottom: '1px solid #333', flexShrink: 0, userSelect: 'none',
                }}>
                  <span style={{ color: isFocused ? '#ccc' : '#666', fontSize: 11, fontFamily: 'monospace' }}>
                    {panel.sessionId ? `#${panel.sessionId}` : 'new'}
                  </span>
                  {panels.length > 1 && (
                    <button
                      onClick={(e) => { e.stopPropagation(); removeAt(i); }}
                      style={closeBtnStyle}
                      title="Close (⌘W)"
                    >
                      ×
                    </button>
                  )}
                </div>
                <div style={{ flex: 1, minHeight: 0 }}>
                  <Terminal
                    mux={mux}
                    attachId={panel.sessionId}
                    onCreated={(id) => handleCreated(i, id)}
                    onExit={() => removeAt(i)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ───── App (라우터) ─────

function App() {
  const muxRef = useRef<TerminalMux | null>(null);
  const [connected, setConnected] = useState(false);
  const [route, setRoute] = useState<Route>(parseHash);

  useEffect(() => {
    const mux = new TerminalMux('ws://localhost:7690');
    muxRef.current = mux;
    mux.connect().then(() => setConnected(true));
    return () => mux.disconnect();
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (!connected || !muxRef.current) {
    return (
      <div style={{ color: '#888', padding: 40, fontFamily: 'monospace' }}>
        connecting to ttym server...
      </div>
    );
  }

  const mux = muxRef.current;

  switch (route.page) {
    case 'session':
      return <SessionPage mux={mux} sessionId={route.id} />;
    case 'viewer':
      return <ViewerPage mux={mux} sessionId={route.id} />;
    case 'workspace':
      return <WorkspacePage key={route.id} mux={mux} workspaceId={route.id} />;
    default:
      return <DashboardPage mux={mux} />;
  }
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

export default App;
