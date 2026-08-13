import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TerminalMux, Terminal, LayoutView, refreshTerminalThemes, getHost } from '@ttym/ui';
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
import { actionBtnStyle, tabStyle, AGENT_COLORS, API_BASE, AgentState, IS_NATIVE, Route, TTYM_HOST, UI_STYLES, UI_STYLE_STORAGE_KEY, UiStyle, Workspace, apiAddMember, apiCreateWorkspace, apiRemoveMember, apiSplitWorkspace, apiUpdateWorkspace, closeBtnStyle, copySessionUrl, emptyPaneStyle, fetchSessionMeta, fetchWorkspaces, getSessionUrl, isSecure, memberLabel, miniLinkBtnStyle, navigate, parseHash, quotePathForShell, readLocalEchoEnabled, readUiStyle, sessionWorkspaceMembership, stripBtnStyle, uploadDroppedFiles, workspaceDisplayLabel, writeLocalEchoEnabled } from './app-shared.js';
import { DashboardPage } from './DashboardPage.js';
import { MapPage } from './MapPage.js';
import { SettingsModal } from './SettingsModal.js';

/** crypto.randomUUID fallback for non-secure contexts (HTTP over LAN) */
function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ───── 대시보드 ─────

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
  const [fileDropSid, setFileDropSid] = useState<number | null>(null);
  /** pane 내 문자열 검색 (vscode 터미널의 ⌘F). null = 닫힘. */
  const [search, setSearch] = useState<{ sid: number; query: string; index: number; count: number } | null>(null);
  const [bells, setBells] = useState<Set<number>>(new Set());
  const [lastAgentIds, setLastAgentIds] = useState<Record<number, { claude?: string; codex?: string }>>({});
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

  /** 드롭 공통 종착지: 경로들을 인용해 해당 pane의 PTY에 타이핑처럼 꽂는다.
   *  제출(CR)은 하지 않는다 — vscode·ghostty와 같은 관례. */
  const insertPathsIntoPane = useCallback((sid: number, paths: string[]) => {
    if (paths.length === 0) return;
    mux.send(sid, paths.map(quotePathForShell).join(' '));
    setFocusedSid(sid);
  }, [mux]);

  // desktop에선 웹뷰 HTML5 drop이 억제되고 네이티브 drag-drop 이벤트가 온다 —
  // 그리고 여기엔 실경로가 실려 있다(vscode·ghostty 계보). 좌표로 pane을
  // 찾아 그 PTY에 꽂는다. 업로드는 필요 없다.
  useEffect(() => {
    if (!IS_NATIVE) return;
    const tauri = (window as unknown as {
      __TAURI__?: { event?: { listen?: (name: string, cb: (e: { payload: { paths?: string[]; position?: { x: number; y: number } } }) => void) => Promise<() => void> } };
    }).__TAURI__;
    const listen = tauri?.event?.listen;
    if (!listen) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void listen('tauri://drag-drop', (event) => {
      const paths = event.payload?.paths ?? [];
      const pos = event.payload?.position;
      if (paths.length === 0 || !pos) return;
      const scale = window.devicePixelRatio || 1;
      const el = document.elementFromPoint(pos.x / scale, pos.y / scale);
      const paneEl = el?.closest?.('[data-pane-sid]');
      const sid = paneEl ? Number(paneEl.getAttribute('data-pane-sid')) : NaN;
      if (Number.isFinite(sid) && sid > 0) insertPathsIntoPane(sid, paths);
    }).then((fn) => { if (disposed) fn(); else unlisten = fn; });
    return () => { disposed = true; unlisten?.(); };
  }, [insertPathsIntoPane]);

  const sessionIds = ws ? layoutToSessionIds(ws.layout).filter((id) => id > 0) : [];

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

  // 검색 결과 카운트 구독 — host가 (index, count)를 밀어준다.
  useEffect(() => {
    if (!search) return;
    const host = getHost(search.sid);
    if (!host) return;
    host.onSearchResults = (index, count) => {
      setSearch((cur) => (cur && cur.sid === search.sid ? { ...cur, index, count } : cur));
    };
    return () => { host.onSearchResults = undefined; };
  }, [search?.sid]);

  // 다른 pane으로 넘어가면 찾기바는 닫힌다 — 하이라이트도 함께.
  useEffect(() => {
    if (search && focusedSid !== null && search.sid !== focusedSid) {
      getHost(search.sid)?.clearSearch();
      setSearch(null);
    }
  }, [focusedSid]);

  // ── 키바인딩: ⌘\ 우분할 · ⌘⇧\ 하분할 · ⌘←→ 포커스 순환 ──

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      // ⌘F: 포커스 pane 검색. 브라우저 찾기는 이 페이지에선 캔버스라 무용 —
      // 가로채도 잃는 것이 없다. pane이 없으면 브라우저 기본 동작 유지.
      if (meta && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && focusedSid !== null && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        getHost(focusedSid)?.jumpCommand(e.key === 'ArrowUp' ? -1 : 1);
        return;
      }
      if (meta && e.key === 'f' && !e.shiftKey && focusedSid !== null) {
        e.preventDefault();
        setSearch({ sid: focusedSid, query: '', index: -1, count: 0 });
        return;
      }
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
        data-pane-sid={sid}
        onMouseDown={() => { setFocusedSid(sid); setBells((prev) => { if (!prev.has(sid)) return prev; const next = new Set(prev); next.delete(sid); return next; }); }}
        onDragOver={(e) => {
          // 파일 드래그만 받는다 — 헤더의 pane 교환 드래그는 Files 타입이 없다.
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setFileDropSid(sid);
        }}
        onDragLeave={() => setFileDropSid((cur) => (cur === sid ? null : cur))}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setFileDropSid(null);
          const files = Array.from(e.dataTransfer.files);
          void uploadDroppedFiles(files)
            .then((paths) => insertPathsIntoPane(sid, paths))
            .catch(() => {});
        }}
        style={{
          display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, background: 'var(--bg0)',
          border: fileDropSid === sid
            ? '1px solid var(--accent)'
            : U.frameBorder ? (dead ? '1px solid var(--err)' : '1px solid var(--line)') : 'none',
          borderRadius: U.paneRadius,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {search?.sid === sid ? (
          <div style={{
            position: 'absolute', top: 34, right: 10, zIndex: 3,
            display: 'flex', alignItems: 'center', gap: 8,
            background: 'var(--bg1)', border: '1px solid var(--line)', borderRadius: 6,
            padding: '4px 8px', fontFamily: 'var(--mono)', fontSize: 11,
          }}>
            <input
              autoFocus
              value={search.query}
              placeholder="find"
              onChange={(e) => {
                const query = e.target.value;
                setSearch((cur) => (cur ? { ...cur, query } : cur));
                getHost(sid)?.findNext(query, true);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); const h = getHost(sid); if (e.shiftKey) h?.findPrevious(search.query); else h?.findNext(search.query); }
                else if (e.key === 'Escape') {
                  e.preventDefault();
                  const h = getHost(sid);
                  h?.clearSearch(); h?.focusTerminal();
                  setSearch(null);
                }
              }}
              style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 11, width: 150 }}
            />
            <span style={{ color: 'var(--text-dim)', minWidth: 34, textAlign: 'right' }}>
              {search.query ? `${search.count === 0 ? 0 : search.index + 1}/${search.count}` : ''}
            </span>
            <span onClick={() => { const h = getHost(sid); h?.findPrevious(search.query); }} style={{ cursor: 'pointer', color: 'var(--text-soft)' }}>↑</span>
            <span onClick={() => { const h = getHost(sid); h?.findNext(search.query); }} style={{ cursor: 'pointer', color: 'var(--text-soft)' }}>↓</span>
            <span onClick={() => { const h = getHost(sid); h?.clearSearch(); h?.focusTerminal(); setSearch(null); }} style={{ cursor: 'pointer', color: 'var(--text-dim)' }}>✕</span>
          </div>
        ) : null}
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
            <span style={{ color: agentColor ?? (isFocused ? 'var(--text)' : 'var(--text-soft)'), fontSize: 11, fontFamily: 'var(--mono)', fontWeight: 700, flexShrink: 0 }}>
              {name || `#${sid}`}
            </span>
            {name ? <span style={{ color: 'var(--text-dim)', fontSize: 10, fontFamily: 'var(--mono)', flexShrink: 0 }}>#{sid}</span> : null}
            {cwd ? (
              <span style={{ color: 'var(--cwd)', fontSize: 10, fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }} title={cwd}>
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
            {zoomedSid === sid ? <span style={{ color: 'var(--warn)', fontSize: 10, fontFamily: 'var(--mono)' }}>zoom</span> : null}
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
  }, [deadSessions, focusedSid, memberNames, sessionCwds, zoomedSid, dragSid, fileDropSid, search, bells, mux, localEchoEnabled, fontSize, agentStates, lastAgentIds, doSplit, detachMember, terminateMember, commitSwap, restartAt, restoreAgent, insertPathsIntoPane]);

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
          <div style={{ color: 'var(--text-dim)', padding: 40, fontFamily: 'var(--mono)' }}>loading…</div>
        )}
      </div>

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
      <div style={{ color: 'var(--text-dim)', padding: 40, fontFamily: 'var(--mono)' }}>loading...</div>
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
        <div style={{ color: 'var(--text-dim)', fontSize: 13, fontFamily: 'var(--mono)', padding: 40 }}>
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
                <span style={{ color: 'var(--text)', fontSize: 13, fontFamily: 'var(--mono)', fontWeight: 600 }}>
                  {workspaceDisplayLabel(ws)}
                </span>
                <span style={{ color: 'var(--text-dim)', fontSize: 11, fontFamily: 'var(--mono)' }}>
                  {ws.liveSessions.length} session{ws.liveSessions.length !== 1 ? 's' : ''}
                </span>
                <span style={{ color: 'var(--text-dim)', fontSize: 11, fontFamily: 'var(--mono)', marginLeft: 'auto' }}>
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
                <span style={{ color: 'var(--text-soft)', fontSize: 13, fontFamily: 'var(--mono)', fontWeight: 600 }}>
                  standalone
                </span>
                <span style={{ color: 'var(--text-dim)', fontSize: 11, fontFamily: 'var(--mono)' }}>
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
        fontFamily: 'var(--mono)', fontSize: 11, userSelect: 'none',
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
        <Terminal mux={mux} attachId={sessionId} mode="readonly" fontSize={10} enableWebgl={false} />
      </div>
    </div>
  );
}

// ───── App (라우터) ─────

const MAIN_VIEW_STORAGE_KEY = 'ttym-main-view';
type MainView = 'preview' | 'map';
function readMainView(): MainView {
  try { return localStorage.getItem(MAIN_VIEW_STORAGE_KEY) === 'map' ? 'map' : 'preview'; } catch { return 'preview'; }
}

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

  const [connectNote, setConnectNote] = useState('connecting to ttym server...');

  useEffect(() => {
    const wsUrl = `${isSecure ? 'wss' : 'ws'}://${TTYM_HOST}/ws`;
    const mux = new TerminalMux(wsUrl);
    muxRef.current = mux;
    let cancelled = false;

    // 한 번 삐끗하면 영원히 "connecting..."이던 결함 — 백오프 재시도.
    const attempt = async (delayMs: number) => {
      while (!cancelled) {
        try {
          await mux.connect();
          if (!cancelled) setConnected(true);
          return;
        } catch {
          setConnectNote(`서버 연결 재시도 중… (${Math.round(delayMs / 1000) || 1}s)`);
          await new Promise((r) => setTimeout(r, delayMs));
          delayMs = Math.min(delayMs * 2, 5000);
        }
      }
    };
    void attempt(500);

    // 접속 후 끊기면 조용히 재접속하고 리로드한다. 리로드는 스냅샷 경로라
    // 공짜는 아니지만(워터마크는 페이지와 함께 죽는 게 정직하다), 1000줄
    // 캡 + 스태거로 부담이 작고, 재연결 후의 host 상태 복원 문제를 통째로
    // 피한다. 리로드 없는 재연결은 host 리셋 훅이 생기면 그때.
    const unsubscribe = mux.onDisconnect(() => {
      if (cancelled) return;
      setConnected(false);
      setConnectNote('연결이 끊겼다 — 재연결 중…');
      const retry = async () => {
        let delay = 500;
        while (!cancelled) {
          try {
            await mux.connect();
            window.location.reload();
            return;
          } catch {
            await new Promise((r) => setTimeout(r, delay));
            delay = Math.min(delay * 2, 5000);
          }
        }
      };
      void retry();
    });

    return () => { cancelled = true; unsubscribe(); mux.disconnect(); };
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
  const zoomSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zoomInitDone = useRef(false);
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
      // 마지막으로 정한 zoom이 다음 창의 기본값이 된다. 창별 키(label)는
      // timestamp 라벨이 config에 쓰레기를 무한 축적해서 기각 — 창별 독립은
      // 런타임에서만, 영속은 하나의 truth로.
      if (zoomSaveTimer.current !== null) clearTimeout(zoomSaveTimer.current);
      zoomSaveTimer.current = setTimeout(() => {
        void api.patchConfig(API_BASE, { zoom: String(zoomRef.current) }).catch(() => {});
      }, 500);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  // ⌘1 = 홈, ⌘2.. = workspace 탭 — desktop 전용. 브라우저에서 ⌘숫자는
  // 크롬 탭 전환의 영토라, 가로채면 사용자의 손버릇과 싸우게 된다.
  useEffect(() => {
    if (!IS_NATIVE) return;
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

  const [mainView, setMainView] = useState<MainView>(() => readMainView());
  const handleMainViewChange = useCallback((value: MainView) => {
    try { localStorage.setItem(MAIN_VIEW_STORAGE_KEY, value); } catch {}
    setMainView(value);
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
    if (values['main-view'] === 'preview' || values['main-view'] === 'map') {
      setMainView(values['main-view']);
      try { localStorage.setItem(MAIN_VIEW_STORAGE_KEY, values['main-view']); } catch {}
    }
    if (values['local-echo'] !== undefined) setLocalEchoEnabled(values['local-echo'] === 'true');
    if (values['font-size'] !== undefined) {
      const size = Number(values['font-size']);
      if (Number.isFinite(size) && size >= 8 && size <= 32) setFontSize(size);
    }
    // desktop 창의 zoom 복원 — 최초 config 수신 때 한 번만. 이후의 push에
    // 반응하면 다른 창에서 zoom을 바꿀 때마다 이 창까지 끌려간다.
    if (IS_NATIVE && !zoomInitDone.current && values.zoom !== undefined) {
      zoomInitDone.current = true;
      const z = Number(values.zoom);
      if (Number.isFinite(z) && z >= 0.5 && z <= 2) {
        const tauri = (window as unknown as { __TAURI__?: { webview?: { getCurrentWebview?: () => { setZoom: (f: number) => Promise<void> } } } }).__TAURI__;
        const webview = tauri?.webview?.getCurrentWebview?.();
        if (webview) {
          zoomRef.current = z;
          void webview.setZoom(z);
        }
      }
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
      <div style={{ color: 'var(--text-soft)', padding: 40, fontFamily: 'var(--mono)' }}>
        {connectNote}
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
      page = mainView === 'map'
        ? <MapPage />
        : <DashboardPage mux={mux} agentStates={agentStates} localEchoEnabled={localEchoEnabled} actionsSlot={stripSlot} />;
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
              title={`${workspaceDisplayLabel(ws)}${IS_NATIVE ? ` · ⌘${i + 2}` : ''} · 더블클릭: 이름 변경`}
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
                  style={{ background: 'var(--bg0)', color: 'var(--text)', border: '1px solid var(--line-strong)', borderRadius: 4, padding: '1px 5px', fontFamily: 'var(--mono)', fontSize: 12, width: 110, outline: 'none' }}
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
        <SettingsModal
          localEchoEnabled={localEchoEnabled}
          onLocalEchoChange={(value) => { handleLocalEchoChange(value); patchConfig({ 'local-echo': String(value) }); }}
          uiStyle={uiStyle}
          onUiStyleChange={(value) => { handleUiStyleChange(value); patchConfig({ 'ui-style': value }); }}
          mainView={mainView}
          onMainViewChange={(value) => { handleMainViewChange(value); patchConfig({ 'main-view': value }); }}
          fontSize={fontSize}
          onFontSizeChange={(value) => { setFontSize(value); patchConfig({ 'font-size': String(value) }); }}
          onThemeChange={(value) => patchConfig({ theme: value })}
          onPatchConfig={patchConfig}
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
  fontFamily: 'var(--mono)',
  flexShrink: 0,
  userSelect: 'none',
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

// ───── 스타일 ─────

const toolbarStyle: React.CSSProperties = {
  padding: '6px 16px',
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  borderBottom: '1px solid #333',
  fontFamily: 'var(--mono)',
};

const btnStyle: React.CSSProperties = {
  background: 'var(--bg2)',
  color: 'var(--text)',
  border: '1px solid #444',
  padding: '3px 10px',
  cursor: 'pointer',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  borderRadius: 3,
};



/* pane 헤더의 상시 노출 버튼 — 파랑은 포커스·상태 몫, 이 버튼들은 조용해야 한다. */


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
  fontFamily: 'var(--mono)',
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
  fontFamily: 'var(--mono)',
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
  fontFamily: 'var(--mono)',
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





const settingsInputStyle: React.CSSProperties = {
  width: '100%',
  border: '1px solid var(--line-strong)',
  background: 'var(--bg2)',
  color: 'var(--text)',
  borderRadius: 7,
  padding: '7px 9px',
  outline: 'none',
  fontFamily: 'var(--mono)',
};


export default App;
