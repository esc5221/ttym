import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as api from '@ttym/api';
import { Terminal, LayoutView, getHost, type TerminalMux } from '@ttym/ui';
import { MutationBarrier, formatCwd, layoutToSessionIds, memberNameBySession, removePane, resizeSplit, swapPanes } from '@ttym/shared';
import { actionBtnStyle, ZEN_DEFAULT_COLS, AGENT_COLORS, API_BASE, useSurface, IS_NATIVE, UI_STYLES, apiAddMember, apiRemoveMember, apiSplitWorkspace, apiUpdateWorkspace, closeBtnStyle, copySessionUrl, emptyPaneStyle, fetchSessionMeta, fetchWorkspaces, miniLinkBtnStyle, navigate, quotePathForShell, stripBtnStyle, uploadDroppedFiles, type AgentState, type UiStyle, type Workspace } from '../app-shared.js';
import { KeyBar } from '../KeyBar.js';
import { PhoneWorkspace } from './PhoneWorkspace.js';
import { useViewerState } from '../viewer/useViewerState.js';
import { ViewerPanel } from '../viewer/ViewerPanel.js';
import { ViewerOverlay } from '../viewer/ViewerOverlay.js';
import { viewSrc } from '../viewer/content.js';
import { PaneTabs } from '../viewer/PaneTabs.js';
import { SelectionOpen, type SelectionTarget } from '../viewer/SelectionOpen.js';
import { parsePathCandidate } from '../viewer/paths.js';
import { type ViewerFocus } from '../route.js';
import { StripMenu, attachDropdownTitleStyle, attachDropdownItemStyle, attachDropdownEmptyStyle } from '../StripMenu.js';
import { ageText, sleepTitle } from './sleep-text.js';
import { ZenView } from './ZenView.js';

// ───── 워크스페이스 페이지 (트리 레이아웃) ─────

export function WorkspacePage({ mux, workspaceId, pane, zen, open, localEchoEnabled, agentStates, actionsSlot, uiStyle, fontSize, fontFamily }: { mux: TerminalMux; workspaceId: string; pane: number | null; zen: number | null; open: ViewerFocus | null; localEchoEnabled: boolean; agentStates: Record<number, AgentState>; actionsSlot: HTMLElement | null; uiStyle: UiStyle; fontSize: number; fontFamily: string }) {
  const U = UI_STYLES[uiStyle];
  const [ws, setWs] = useState<Workspace | null>(null);
  const [memberNames, setMemberNames] = useState<Record<number, string>>({});
  const [sessionCwds, setSessionCwds] = useState<Record<number, string>>({});
  const [deadSessions, setDeadSessions] = useState<Set<number>>(new Set());
  const [focusedSid, setFocusedSid] = useState<number | null>(null);

  // 폰에서 만든 주소(#w/<id>/p/<sid>)를 데스크톱에서 열면 그 pane에 포커스가
  // 간다. 폰 쪽은 카드에서 열 때 이미 onFocusSid를 부르므로 여기선 링크로
  // 들어온 경우를 받는 셈이다.
  useEffect(() => {
    if (pane !== null) setFocusedSid(pane);
  }, [pane]);
  const [zoomedSid, setZoomedSid] = useState<number | null>(null);
  /** zen 읽기 모드로 보고 있는 pane. zoom과 다른 물건이다 — zoom은 레이아웃 투영이고,
   *  zen은 크롬을 전부 걷어내고 고정 폭으로 읽는 화면이다.
   *
   *  상태가 아니라 URL(#w/<id>/z/<sid>)이 원천이다. 컴포넌트에 들고 있으면
   *  새로고침 한 번에 레이아웃으로 튕기고, 읽던 화면을 링크로 보낼 수도 없다. */
  const zenSid = zen;
  const openZen = useCallback((sid: number | null) => {
    // 들어갈 때는 히스토리에 쌓아 뒤로가기로 나올 수 있게, 나올 때는 갈아끼워
    // 뒤로가기가 zen으로 되돌아가지 않게.
    navigate(
      sid === null ? { page: 'workspace', id: workspaceId } : { page: 'workspace', id: workspaceId, zen: sid },
      sid === null ? { replace: true } : undefined,
    );
  }, [workspaceId]);
  const surface = useSurface();
  const touch = surface !== 'desktop';
  // 폰의 [맞춤] 토글: 이 pane의 PTY를 폰 크기로 빌려 쓴다 (떠나면 자동 반납)
  const [fitSids, setFitSids] = useState<Set<number>>(new Set);
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

  // ── viewer (`ttym open`) ──
  // full 모드는 zen과 같은 자리(URL #w/<id>/o/<sid>/<vid>)라 둘은 배타적이다.
  const openFull = useCallback((sid: number, vid: string) => {
    navigate({ page: 'workspace', id: workspaceId, open: { sid, vid } });
  }, [workspaceId]);
  const exitFull = useCallback(() => {
    navigate({ page: 'workspace', id: workspaceId }, { replace: true });
  }, [workspaceId]);
  /** zen에서 뷰어를 옆에 펼쳐 두는지 — 탭이 있을 때만 의미가 있다. 기본은 접힘: 이 화면에서
   *  펼친 적이 없는데 예전 `ttym open` 탭이 터미널 옆을 차지하고 있으면 안 된다. */
  const [zenSideOpen, setZenSideOpen] = useState<boolean>(() => { try { return window.localStorage.getItem('ttym-zen-side') === '1'; } catch { return false; } });
  const viewer = useViewerState(mux, sessionIds, (sid, vid, presentation) => {
    if (presentation === 'full') openFull(sid, vid);
    else if (open?.sid === sid) exitFull();
    // 방금 연 파일은 보여야 한다 — 접어 둔 zen 패널도 이번엔 펼친다(기억은 안 바꾼다).
    if (presentation !== 'full' && zenSid === sid) setZenSideOpen(true);
  });
  const fullState = open !== null ? viewer.states[open.sid] ?? null : null;
  const toggleZenSide = useCallback(() => setZenSideOpen((v) => { try { window.localStorage.setItem('ttym-zen-side', v ? '0' : '1'); } catch {} return !v; }), []);
  const zenViewer = zenSid !== null ? viewer.states[zenSid] ?? null : null;
  // full로 보던 탭이 닫혔거나 pane이 빠졌으면 빈 오버레이에 갇힌다 — 주소를 되돌린다.
  useEffect(() => {
    if (open === null) return;
    if (sessionIds.length > 0 && !sessionIds.includes(open.sid)) { exitFull(); return; }
    if (open.sid in viewer.states && !viewer.states[open.sid]) exitFull();
  }, [open?.sid, open?.vid, sessionIds.join(','), viewer.states, exitFull]);
  // URL이 말하는 탭이 곧 active — 새로고침해도 같은 탭.
  useEffect(() => {
    if (open !== null) viewer.setActive(open.sid, open.vid);
  }, [open?.sid, open?.vid]);
  /** 헤더의 ⟳ — 뷰어 탭 본문을 다시 마운트한다. 세션별 카운터면 충분하다. */
  const [viewerReload, setViewerReload] = useState<Record<number, number>>({});
  /** 터미널에서 경로를 선택했을 때 뜨는 open 버튼. 한 번에 하나. */
  const [selOpen, setSelOpen] = useState<SelectionTarget | null>(null);
  /** ~ 를 풀 홈 디렉터리 — 서버가 안 알려주므로 세션 cwd에서 /Users/x · /home/x 를 읽는다. */
  const homeDir = useMemo(() => {
    for (const cwd of Object.values(sessionCwds)) {
      const m = /^(\/Users\/[^/]+|\/home\/[^/]+)(?:\/|$)/.exec(cwd);
      if (m) return m[1]!;
    }
    return undefined;
  }, [sessionCwds]);
  const offerSelection = useCallback((sid: number, e: React.MouseEvent<HTMLDivElement>) => {
    const pane = e.currentTarget;
    const px = e.clientX; const py = e.clientY;
    // 선택은 mouseup 뒤에 확정된다 — 한 틱 늦게 읽는다.
    setTimeout(() => {
      const text = getHost(sid)?.term.getSelection() ?? '';
      const candidate = parsePathCandidate(text, sessionCwds[sid], homeDir);
      if (!candidate) { setSelOpen((cur) => (cur?.sid === sid ? null : cur)); return; }
      const rect = pane.getBoundingClientRect();
      setSelOpen({ sid, x: px - rect.left, y: py - rect.top, candidate, text });
    }, 0);
  }, [sessionCwds, homeDir]);

  // pane이 사라졌는데 zen에 남아 있으면 빈 화면에 갇힌다. 주소도 같이 되돌린다.
  // Agent sleep. The server does the work; these only ask and let the push update the state.
  const sleepAgent = useCallback(async (sid: number) => {
    try { await api.sleepAgent(API_BASE, sid); } catch (e) {
      // A refusal (409) names its reason: "1 background task running (…)", "a wakeup is scheduled (…)".
      let text = (e as Error).message;
      try { text = JSON.parse((e as { body: string }).body).error ?? text; } catch {}
      setSleepNote({ sid, text: `won't sleep: ${text}` });
    }
  }, []);
  const wakeAgent = useCallback(async (sid: number) => {
    try { await api.wakeAgent(API_BASE, sid); } catch {}
  }, []);
  const [sleepNote, setSleepNote] = useState<{ sid: number; text: string } | null>(null);
  useEffect(() => {
    if (!sleepNote) return;
    const t = setTimeout(() => setSleepNote(null), 4000);
    return () => clearTimeout(t);
  }, [sleepNote]);

  useEffect(() => {
    if (zenSid !== null && sessionIds.length > 0 && !sessionIds.includes(zenSid)) openZen(null);
  }, [sessionIds.join(','), zenSid, openZen]);

  // zen으로 들어온 pane은 포커스도 그쪽이어야 한다 — 나갔을 때 그 자리에 선다.
  useEffect(() => {
    if (zenSid !== null) setFocusedSid(zenSid);
  }, [zenSid]);

  // ⌘. 토글. Esc는 못 쓴다 — 터미널이 Esc의 주인이라 가로채면 vim·claude에서
  // Esc가 죽는다. 기존 단축키가 전부 ⌘ 기반이고 ⌘.이 비어 있다.
  useEffect(() => {
    if (touch) return;
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== '.') return;
      event.preventDefault();
      if (open !== null) exitFull();
      else if (zenSid !== null) openZen(null);
      else openZen(focusedSid ?? sessionIds[0] ?? null);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [touch, focusedSid, zenSid, openZen, sessionIds.join(','), open, exitFull]);

  const restoreAgent = useCallback((sid: number) => {
    if (!lastAgentIds[sid]) return;
    // 명령을 여기서 조립하지 않는다. `ttym agent resume`이 어느 에이전트인지
    // 찾고 설정·env·플래그를 붙이는 일을 이미 한다 — 베껴 두면 이렇게 어긋난다:
    // 이 줄이 `claude --resume <id>`를 직접 만들던 동안 설정한 기본 플래그가
    // 웹에서만 빠져 있었다.
    //
    // pane의 셸 PATH에 ttym이 있어야 한다. 없으면 command not found가 터미널에
    // 그대로 찍힌다 — 조용히 아무 일도 안 일어나는 것보다 낫다.
    void api.sendToSession(API_BASE, sid, 'ttym agent resume\r');
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
    const label = ws.name;
    document.title = sessionIds.length > 0 ? `${label} (${sessionIds.length})` : label;
    return () => { document.title = 'ttym'; };
  }, [ws?.name, sessionIds.length]);

  // viewer 탭 스트립이 우측 absolute 액션 클러스터(☾ sleep · zen · split · detach · × …) 밑으로
  // 깔려서, 마지막 탭의 ×를 누르려 하면 hover로 살아난 그 버튼들이 클릭을 가로채던 문제.
  // 클러스터의 실제 폭을 재서 헤더에 --pane-actions-w로 싣고, PaneTabs가 그만큼 오른쪽을 비운다.
  // reveal 버튼은 opacity만 바뀌고 폭은 그대로라(=클러스터 폭 불변) hover에도 탭이 재배치되지 않는다.
  const actionsRo = useRef<ResizeObserver | null>(null);
  if (actionsRo.current === null && typeof ResizeObserver !== 'undefined') {
    actionsRo.current = new ResizeObserver((entries) => {
      for (const e of entries) {
        const el = e.target as HTMLElement;
        const parent = el.parentElement;
        if (parent) parent.style.setProperty('--pane-actions-w', `${Math.ceil(el.getBoundingClientRect().width) + 16}px`);
      }
    });
  }
  useEffect(() => () => actionsRo.current?.disconnect(), []);
  const actionsRef = useCallback((el: HTMLSpanElement | null) => {
    if (!el || !actionsRo.current) return;
    actionsRo.current.observe(el);
    const parent = el.parentElement;
    if (parent) parent.style.setProperty('--pane-actions-w', `${Math.ceil(el.getBoundingClientRect().width) + 16}px`);
  }, []);

  const renderPane = useCallback((sid: number, _path: number[]) => {
    if (sid <= 0) {
      return (
        <div key="empty" style={emptyPaneStyle}>
          <button onClick={() => void doSplit('right')} style={actionBtnStyle}>start terminal</button>
        </div>
      );
    }
    // zen이 이 pane을 데려갔다. 여기서 Terminal을 또 그리면 같은 세션에 호스트를
    // 두 번 붙이는 셈이라, 자리만 비워둔다. 호스트는 하나뿐이고 zen 컨테이너로
    // 옮겨 담겼을 뿐이다(terminal-host의 mount는 재생성이 아니라 재배치다).
    if (sid === zenSid) {
      return <div key={`zen-${sid}`} style={{ ...emptyPaneStyle, color: 'var(--text-dim)', fontSize: 11 }}>zen</div>;
    }
    const dead = deadSessions.has(sid);
    const isFocused = focusedSid === sid;
    const name = memberNames[sid];
    const cwd = sessionCwds[sid];
    const agent = agentStates[sid];
    const agentColor = agent?.kind ? AGENT_COLORS[agent.kind] : undefined;
    const sleep = agent?.sleep ?? null;
    const asleep = sleep?.state === 'sleeping' || sleep?.state === 'waking';
    const canRestore = !agent?.active && !asleep && (lastAgentIds[sid]?.claude || lastAgentIds[sid]?.codex);
    // 헤더의 탭. 왼쪽 덩어리(이름·#id·cwd)가 터미널 탭이고, 그 오른쪽에 뷰어 탭이 선다.
    // full로 나가 있으면 pane 안에서는 안 그린다 — 같은 탭을 두 번 마운트하지 않는다.
    const viewerState = open?.sid === sid ? null : (viewer.states[sid] ?? null);
    const activeVid = viewer.active[sid];
    const paneTab = viewerState && activeVid && viewerState.items.some((i) => i.id === activeVid) ? activeVid : 'term';
    const paneItem = paneTab === 'term' ? null : viewerState!.items.find((i) => i.id === paneTab)!;
    return (
      <div
        key={sid}
        data-pane-sid={sid}
        onMouseDown={() => { setFocusedSid(sid); setSelOpen(null); setBells((prev) => { if (!prev.has(sid)) return prev; const next = new Set(prev); next.delete(sid); return next; }); }}
        onMouseUp={(e) => { if (paneTab === 'term' && e.button === 0) offerSelection(sid, e); }}
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
        {selOpen?.sid === sid ? (
          <SelectionOpen
            target={selOpen}
            onDismiss={() => setSelOpen((cur) => (cur?.sid === sid ? null : cur))}
            onOpen={async (candidate) => {
              const results = await viewer.open(sid, [candidate.target], undefined, candidate.line !== undefined ? { line: candidate.line, col: candidate.col } : undefined);
              const r = results[0];
              return r && !r.ok ? r.error.replace(/^not found: .*$/, 'not found') : null;
            }}
          />
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
          title="drag: swap"
        >
          {/* 터미널 탭 = 이름·#id (절대 안 줄어든다) + cwd (탭에 자리를 먼저 내준다). 두 형제로 나눈
              이유: 한 덩어리로 두면 flex가 덩어리째 줄여 이름까지 사라진다 — 탭 10개에서 실측. */}
          <span
            className={`pane-tab pane-tab-term${paneTab === 'term' ? ' on' : ''}`}
            onClick={() => { if (paneTab !== 'term') viewer.setActive(sid, 'term'); }}
            onDoubleClick={() => setZoomedSid((z) => (z === sid ? null : sid))}
            title={paneTab === 'term' ? 'double-click: zoom' : 'back to the terminal'}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 0 2px 10px',
              flexShrink: 0, height: '100%',
              // frame: 포커스 신호는 텍스트 밝기 하나. classic: 바 배경이 말한다.
              opacity: U.headerBar ? 1 : isFocused ? 1 : 0.45,
            }}
          >
            {sleep ? (
              <span className={`agent-sleep-mark ${sleep.state}`} title={sleepTitle(sleep)}>
                {sleep.state === 'sleeping' ? '☾' : sleep.state === 'waking' ? '◌' : '✕'}
              </span>
            ) : agentColor ? (
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
          </span>
          <span
            onClick={() => { if (paneTab !== 'term') viewer.setActive(sid, 'term'); }}
            onDoubleClick={() => setZoomedSid((z) => (z === sid ? null : sid))}
            title={cwd}
            style={{
              flexGrow: viewerState ? 0 : 1, flexShrink: viewerState ? 4 : 1, minWidth: 0, overflow: 'hidden',
              padding: '2px 10px 2px 6px', height: '100%', display: 'inline-flex', alignItems: 'center',
              opacity: U.headerBar ? 1 : isFocused ? 1 : 0.45,
            }}
          >
            {cwd ? (
              <span style={{ color: 'var(--cwd)', fontSize: 10, fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                {formatCwd(cwd)}
              </span>
            ) : null}
          </span>
          {viewerState ? (
            <PaneTabs
              items={viewerState.items}
              activeId={paneTab === 'term' ? null : paneTab}
              onSelect={(vid) => viewer.setActive(sid, vid)}
              onClose={(vid) => void viewer.close(sid, vid)}
              // 우측 액션 클러스터가 absolute라, 측정된 그 폭(--pane-actions-w)만큼 스트립 오른쪽을
              // 비운다 — 마지막 탭의 ×가 클러스터 밑에 깔리지 않게. 측정 전 첫 프레임은 8px 폴백.
              reserveRight="var(--pane-actions-w, 8px)"
            />
          ) : null}
          <span ref={actionsRef} style={{
            position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
            display: 'inline-flex', alignItems: 'center', gap: 6, zIndex: 2,
            // hover로 펼쳐지는 버튼들은 탭 끝을 잠깐 덮는다 — cwd를 덮던 것과 같은 규칙. 바탕은 깔지
            // 않는다: 투명한 버튼도 폭을 차지해서, 바탕이 있으면 hover 전에도 탭을 가린다(실측).
          }}>
            {bells.has(sid) ? (
              <span title="bell" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--warn)', boxShadow: '0 0 6px var(--warn)', flexShrink: 0 }} />
            ) : null}
            {zoomedSid === sid ? <span style={{ color: 'var(--warn)', fontSize: 10, fontFamily: 'var(--mono)' }}>zoom</span> : null}

            {agent?.kind && !asleep && !dead ? (
              <button className="reveal" onClick={(e) => { e.stopPropagation(); void sleepAgent(sid); }} style={miniLinkBtnStyle} title="sleep now: the process exits, the screen stays, any input resumes it">☾</button>
            ) : null}
            {canRestore ? (
              <button className="reveal" onClick={(e) => { e.stopPropagation(); restoreAgent(sid); }} style={miniLinkBtnStyle} title="resume last agent session">restore</button>
            ) : null}
            {touch ? null : (
              <button className="reveal" onClick={(e) => { e.stopPropagation(); openZen(sid); }} style={miniLinkBtnStyle} title="zen · ⌘.">zen</button>
            )}
            <button className="reveal" onClick={(e) => { e.stopPropagation(); void doSplit('right', sid); }} style={miniLinkBtnStyle} title="split right">│</button>
            <button className="reveal" onClick={(e) => { e.stopPropagation(); void doSplit('down', sid); }} style={miniLinkBtnStyle} title="split down">─</button>
            {touch ? (
              <button
                className="reveal"
                onClick={(e) => {
                  e.stopPropagation();
                  setFitSids((prev) => { const next = new Set(prev); if (next.has(sid)) next.delete(sid); else next.add(sid); return next; });
                }}
                style={{ ...miniLinkBtnStyle, ...(fitSids.has(sid) ? { color: 'var(--accent)' } : null) }}
                title="borrow this viewport size · restored on leave"
              >{fitSids.has(sid) ? 'reset' : 'fit'}</button>
            ) : null}
            <button className="reveal" onClick={(e) => { e.stopPropagation(); void detachMember(sid); }} style={miniLinkBtnStyle} title="detach · session keeps running">detach</button>
            <button className="reveal" onClick={(e) => { e.stopPropagation(); void copySessionUrl(sid); }} style={miniLinkBtnStyle}>copy</button>
            {paneItem ? (
              <>
                <button onClick={(e) => { e.stopPropagation(); setViewerReload((prev) => ({ ...prev, [sid]: (prev[sid] ?? 0) + 1 })); }} style={miniLinkBtnStyle} title="reload">⟳</button>
                <a href={viewSrc(paneItem)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={miniLinkBtnStyle} title="open in a browser tab">↗</a>
                <button onClick={(e) => { e.stopPropagation(); openFull(sid, paneItem.id); }} style={miniLinkBtnStyle} title="fill the workspace">full</button>
              </>
            ) : null}
            <button className="reveal" onClick={(e) => { e.stopPropagation(); void terminateMember(sid); }} style={closeBtnStyle} title="terminate">×</button>
          </span>
        </div>
        <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
        {/* isolation: xterm 6의 스크롤바는 보일 때 z-index 11이 된다(vscode scrollable-element).
            터미널을 자기 스태킹 컨텍스트에 가두지 않으면, 뷰어가 앞에 있어도 출력이 흐를 때마다
            터미널 스크롤바가 뷰어(z 10) 위로 떠오른다 — elementsFromPoint로 실측. */}
        <div className={asleep ? 'pane-asleep' : undefined} style={{ flex: 1, minHeight: 0, padding: U.termPad, isolation: 'isolate', ...(touch ? { overflow: 'auto', WebkitOverflowScrolling: 'touch' } : null) }}>
          {!dead ? (
            <Terminal
              mux={mux}
              attachId={sid}
              fontSize={touch ? 14 : fontSize}
              fontFamily={fontFamily || undefined}
              geometry={touch ? (fitSids.has(sid) ? 'borrow' : 'follow') : 'fit'}
              enableWebgl={!touch}
              localEcho={localEchoEnabled}
              onExit={() => setDeadSessions((prev) => new Set(prev).add(sid))}
              onBell={() => { if (touch) navigator.vibrate?.(60); setBells((prev) => (focusedSid === sid ? prev : new Set(prev).add(sid))); }}
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
        {/* Sleep pill: the one place the pane says "not live". A click wakes; so does any key,
            which is why it must not steal focus from the terminal (mousedown is stopped, not the click). */}
        {sleep || sleepNote?.sid === sid ? (
          <div
            className={`agent-sleep-pill ${sleep?.state ?? 'note'}`}
            onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
            onClick={(e) => { e.stopPropagation(); if (sleep?.state === 'sleeping') void wakeAgent(sid); }}
            title={sleep ? sleepTitle(sleep) : undefined}
          >
            {sleepNote?.sid === sid && !sleep ? <span>{sleepNote.text}</span>
              : sleep!.state === 'sleeping' ? <><span className="mark">☾</span><span>sleeping · {ageText(sleep!.since)} · type or click to wake</span></>
              : sleep!.state === 'waking' ? <><span className="mark spin">◌</span><span>waking…{sleep!.queued ? ` ${sleep!.queued} B queued` : ''}</span></>
              : <><span className="mark">✕</span><span>resume failed: {sleep!.error ?? 'unknown'}</span><button onClick={(e) => { e.stopPropagation(); restoreAgent(sid); }} style={miniLinkBtnStyle}>restore</button></>}
          </div>
        ) : null}
        {/* 뷰어 탭은 터미널 위에 덮는다. 터미널을 떼거나 숨기면 PTY 크기가 흔들리고 돌아올 때
            다시 fit해야 한다 — 그대로 깔아두면 탭을 되돌리는 순간 그 화면이다. */}
        {/* z-index: xterm의 레이어(link·decoration)가 자기 z-index를 갖고 있어, 없으면
            오버레이가 그 밑으로 들어가 휠·클릭을 터미널이 먹는다(elementFromPoint로 실측). */}
        {paneItem && viewerState ? (
          <div style={{ position: 'absolute', inset: 0, zIndex: 10, display: 'flex', background: 'var(--bg0)' }}>
            <ViewerPanel
              sid={sid}
              state={viewerState}
              activeId={paneItem.id}
              chrome="none"
              reloadKey={viewerReload[sid] ?? 0}
              jump={viewer.jump[sid]}
              onSelect={(vid) => viewer.setActive(sid, vid)}
              onClose={(vid) => void viewer.close(sid, vid)}
              onCloseAll={() => void viewer.closeAll(sid)}
              onOpen={(targets) => void viewer.open(sid, targets)}
              mode="pane"
            />
          </div>
        ) : null}
        </div>
      </div>
    );
  }, [deadSessions, focusedSid, memberNames, sessionCwds, zoomedSid, zenSid, dragSid, fileDropSid, search, bells, fitSids, mux, localEchoEnabled, fontSize, fontFamily, agentStates, lastAgentIds, doSplit, detachMember, terminateMember, commitSwap, restartAt, restoreAgent, insertPathsIntoPane, viewer, open, viewerReload, openFull, selOpen, offerSelection, sleepAgent, wakeAgent, sleepNote]);

  // 툴바 줄을 없앴다 — split/layout/attach는 탭 스트립 우측 슬롯에 포털로 산다.
  const stripActions = (
    <>
      <button onClick={() => void doSplit('right')} style={stripBtnStyle} title="split right of focused · ⌘\\">+ split</button>
      <StripMenu label="layout ▾" open={layoutMenuOpen} onToggle={() => setLayoutMenuOpen((v) => !v)}>
        <div style={attachDropdownTitleStyle}>preset · same members, new arrangement</div>
        {(['auto', 'even-h', 'even-v', 'main-v', 'tiled'] as const).map((preset) => (
          <button key={preset} onClick={() => void applyPreset(preset)} style={attachDropdownItemStyle}>
            {preset}
          </button>
        ))}
      </StripMenu>
      <StripMenu label="+ attach" open={attachOpen} onToggle={toggleAttach}>
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
      </StripMenu>
    </>
  );

  // 폰은 분할을 투영하는 대신 화면을 둘로 나눈다 (카드 목록 / 전체화면).
  // 6인치에서 pane 두 개를 동시에 조작하는 건 물리적으로 안 되고, 동시에
  // 감시하는 건 되니까. 스크롤할 물건도 모드마다 하나로 줄어든다.
  if (surface === 'phone') {
    // 스트립 액션은 폰에서 접는다. 393px 폭의 절반을 split·layout·attach가
    // 먹는데, 터미널 추가는 카드 목록 아래에 있고 분할 프리셋은 폰에서 쓸 데가
    // 없다. attach는 데스크톱에서 하면 된다.
    return (
      <>
        {ws ? (
          <PhoneWorkspace
            mux={mux}
            sessionIds={sessionIds}
            memberNames={memberNames}
            sessionCwds={sessionCwds}
            agentStates={agentStates}
            deadSessions={deadSessions}
            bells={bells}
            focusedSid={focusedSid}
            pane={pane ?? zen}
            fontSize={fontSize}
            // 위치는 URL이 갖는다. 목록에서 열 때만 히스토리에 쌓고, pane 사이를
            // 넘길 때와 목록으로 나올 때는 갈아끼운다 — 안 그러면 여섯 번 넘긴 뒤
            // 뒤로가기를 여섯 번 눌러야 목록에 닿는다.
            onOpenPane={(sid, options) => navigate(
              sid === null ? { page: 'workspace', id: workspaceId } : { page: 'workspace', id: workspaceId, pane: sid },
              options,
            )}
            onFocusSid={(sid) => {
              setFocusedSid(sid);
              setBells((prev) => { if (!prev.has(sid)) return prev; const next = new Set(prev); next.delete(sid); return next; });
            }}
            localEchoEnabled={localEchoEnabled}
            onSearch={(sid) => setSearch({ sid, query: '', index: -1, count: 0 })}
            onExit={(sid) => setDeadSessions((prev) => new Set(prev).add(sid))}
            onBell={(sid) => { navigator.vibrate?.(60); setBells((prev) => (focusedSid === sid ? prev : new Set(prev).add(sid))); }}
            onSplit={() => void doSplit('right')}
            onRestart={(sid) => void restartAt(sid)}
            onDetach={(sid) => void detachMember(sid)}
          />
        ) : (
          <div style={{ color: 'var(--text-dim)', padding: 40, fontFamily: 'var(--mono)' }}>loading…</div>
        )}
      </>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {actionsSlot ? createPortal(stripActions, actionsSlot) : null}
      {open !== null && fullState && sessionIds.includes(open.sid) ? (
        <ViewerOverlay
          sid={open.sid}
          name={memberNames[open.sid]}
          state={fullState}
          activeId={viewer.active[open.sid] ?? open.vid}
          onSelect={(vid) => { viewer.setActive(open.sid, vid); navigate({ page: 'workspace', id: workspaceId, open: { sid: open.sid, vid } }, { replace: true }); }}
          onClose={(vid) => void viewer.close(open.sid, vid)}
          onCloseAll={() => void viewer.closeAll(open.sid)}
          onOpen={(targets) => void viewer.open(open.sid, targets)}
          jump={viewer.jump[open.sid]}
          onExit={exitFull}
        />
      ) : null}
      {zenSid !== null && sessionIds.includes(zenSid) ? (
        <ZenView
          mux={mux}
          sid={zenSid}
          name={memberNames[zenSid]}
          cwd={sessionCwds[zenSid]}
          cols={ZEN_DEFAULT_COLS}
          localEchoEnabled={localEchoEnabled}
          fontFamily={fontFamily}
          baseFontSize={fontSize}
          onExit={() => openZen(null)}
          onBell={() => setBells((prev) => new Set(prev).add(zenSid))}
          onSessionExit={() => { setDeadSessions((prev) => new Set(prev).add(zenSid)); openZen(null); }}
          sideOpen={zenSideOpen}
          onToggleSide={toggleZenSide}
          side={zenViewer ? (
            <ViewerPanel
              sid={zenSid}
              state={zenViewer}
              activeId={viewer.active[zenSid] ?? null}
              onSelect={(vid) => viewer.setActive(zenSid, vid)}
              onClose={(vid) => void viewer.close(zenSid, vid)}
              onCloseAll={() => void viewer.closeAll(zenSid)}
              onOpen={(targets) => void viewer.open(zenSid, targets)}
              mode="pane"
            />
          ) : undefined}
        />
      ) : null}
      <div style={{ flex: 1, minHeight: 0, background: 'var(--bg0)', padding: U.wrapPad }}>
        {ws ? (
          <LayoutView
            layout={ws.layout}
            renderPane={renderPane}
            onResize={commitResize}
            zoomedSessionId={zoomedSid}
            stacked={false}
            splitterPx={U.splitterPx}
            splitterColor={U.splitterColor}
            splitterActiveColor="var(--accent)"
          />
        ) : (
          <div style={{ color: 'var(--text-dim)', padding: 40, fontFamily: 'var(--mono)' }}>loading…</div>
        )}
      </div>
      {touch && focusedSid !== null ? (
        <KeyBar
          sid={focusedSid}
          onSearch={() => setSearch({ sid: focusedSid, query: '', index: -1, count: 0 })}
        />
      ) : null}

    </div>
  );
}
