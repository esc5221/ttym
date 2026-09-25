import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as api from '@ttym/api';
import { LayoutView, getHost, type LocalEchoSetting, type TerminalMux } from '@ttym/ui';
import { MutationBarrier, layoutToSessionIds, memberNameBySession, removePane, resizeSplit, swapPanes } from '@ttym/shared';
import { actionBtnStyle, ZEN_DEFAULT_COLS, API_BASE, useSurface, IS_NATIVE, UI_STYLES, apiAddMember, apiRemoveMember, apiSplitWorkspace, apiUpdateWorkspace, emptyPaneStyle, fetchSessionMeta, fetchWorkspaces, navigate, quotePathForShell, stripBtnStyle, type AgentState, type UiStyle, type Workspace } from '../app-shared.js';
import { KeyBar } from '../KeyBar.js';
import { PhoneWorkspace } from './PhoneWorkspace.js';
import { useViewerState } from '../viewer/useViewerState.js';
import { ViewerPanel } from '../viewer/ViewerPanel.js';
import { ViewerOverlay } from '../viewer/ViewerOverlay.js';
import type { SelectionTarget } from '../viewer/SelectionOpen.js';
import { parsePathCandidate } from '../viewer/paths.js';
import { type ViewerFocus } from '../route.js';
import { StripMenu, attachDropdownTitleStyle, attachDropdownItemStyle, attachDropdownEmptyStyle } from '../StripMenu.js';
import { ZenView } from './ZenView.js';
import { PaneHeader } from './PaneHeader.js';
import { SessionBody } from './SessionBody.js';
import { WorkspaceSessionsContext, type WorkspaceSessions } from './session-context.js';

// ───── 워크스페이스 페이지 (트리 레이아웃) ─────

export function WorkspacePage({ mux, workspaceId, pane, zen, open, localEchoEnabled, agentStates, actionsSlot, uiStyle, fontSize, fontFamily }: { mux: TerminalMux; workspaceId: string; pane: number | null; zen: number | null; open: ViewerFocus | null; localEchoEnabled: LocalEchoSetting; agentStates: Record<number, AgentState>; actionsSlot: HTMLElement | null; uiStyle: UiStyle; fontSize: number; fontFamily: string }) {
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

  const markDead = useCallback((sid: number) => setDeadSessions((prev) => new Set(prev).add(sid)), []);
  const focusSid = useCallback((sid: number) => {
    setFocusedSid(sid);
    setSelOpen(null);
    setBells((prev) => { if (!prev.has(sid)) return prev; const next = new Set(prev); next.delete(sid); return next; });
  }, []);
  const ringBell = useCallback((sid: number) => {
    if (touch) navigator.vibrate?.(60);
    setBells((prev) => (focusedSid === sid ? prev : new Set(prev).add(sid)));
  }, [touch, focusedSid]);
  const reloadViewer = useCallback((sid: number) => setViewerReload((prev) => ({ ...prev, [sid]: (prev[sid] ?? 0) + 1 })), []);

  const sessions = useMemo<WorkspaceSessions>(() => ({
    mux, localEchoEnabled, touch, agentStates, lastAgentIds, deadSessions, markDead, focusedSid, focusSid, bells, ringBell,
    viewer, open, openFull, viewerReload, reloadViewer, selOpen, setSelOpen, offerSelection, search, setSearch,
    fileDropSid, setFileDropSid, insertPathsIntoPane, sleepAgent, wakeAgent, restoreAgent, sleepNote, restartAt, detachMember,
  }), [mux, localEchoEnabled, touch, agentStates, lastAgentIds, deadSessions, markDead, focusedSid, focusSid, bells, ringBell,
    viewer, open, openFull, viewerReload, reloadViewer, selOpen, offerSelection, search,
    fileDropSid, insertPathsIntoPane, sleepAgent, wakeAgent, restoreAgent, sleepNote, restartAt, detachMember]);

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
    return (
      <div
        key={sid}
        data-pane-sid={sid}
        onMouseDown={() => focusSid(sid)}
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
        <PaneHeader
          sid={sid}
          name={name}
          cwd={cwd}
          isFocused={isFocused}
          dead={dead}
          zoomed={zoomedSid === sid}
          fit={fitSids.has(sid)}
          U={U}
          dragging={dragSid}
          onDragStart={() => setDragSid(sid)}
          onDragEnd={() => setDragSid(null)}
          onSwapWith={(other) => commitSwap(other, sid)}
          onToggleZoom={() => setZoomedSid((z) => (z === sid ? null : sid))}
          onToggleFit={() => setFitSids((prev) => { const next = new Set(prev); if (next.has(sid)) next.delete(sid); else next.add(sid); return next; })}
          onSplit={(direction) => void doSplit(direction, sid)}
          onZen={() => openZen(sid)}
          onTerminate={() => void terminateMember(sid)}
        />
        <SessionBody
          sid={sid}
          viewerOverlay
          terminal={{
            fontSize: touch ? 14 : fontSize,
            fontFamily: fontFamily || undefined,
            geometry: touch ? (fitSids.has(sid) ? 'borrow' : 'follow') : 'fit',
            enableWebgl: !touch,
          }}
          wrapStyle={{ padding: U.termPad, ...(touch ? { overflow: 'auto', WebkitOverflowScrolling: 'touch' } : null) }}
        />
      </div>
    );
  }, [deadSessions, focusedSid, focusSid, memberNames, sessionCwds, zoomedSid, zenSid, dragSid, fileDropSid, fitSids, touch, fontSize, fontFamily, doSplit, terminateMember, commitSwap, openZen, U]);

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
      <WorkspaceSessionsContext.Provider value={sessions}>
        {ws ? (
          <PhoneWorkspace
            sessionIds={sessionIds}
            memberNames={memberNames}
            sessionCwds={sessionCwds}
            // --full은 폰에서 따로 없다 — 그 pane을 열고 그 탭을 앞에 세운다.
            pane={pane ?? zen ?? open?.sid ?? null}
            fontSize={fontSize}
            // 위치는 URL이 갖는다. 목록에서 열 때만 히스토리에 쌓고, pane 사이를
            // 넘길 때와 목록으로 나올 때는 갈아끼운다 — 안 그러면 여섯 번 넘긴 뒤
            // 뒤로가기를 여섯 번 눌러야 목록에 닿는다.
            onOpenPane={(sid, options) => navigate(
              sid === null ? { page: 'workspace', id: workspaceId } : { page: 'workspace', id: workspaceId, pane: sid },
              options,
            )}
            onSplit={() => void doSplit('right')}
          />
        ) : (
          <div style={{ color: 'var(--text-dim)', padding: 40, fontFamily: 'var(--mono)' }}>loading…</div>
        )}
      </WorkspaceSessionsContext.Provider>
    );
  }

  return (
    <WorkspaceSessionsContext.Provider value={sessions}>
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
          sid={zenSid}
          name={memberNames[zenSid]}
          cwd={sessionCwds[zenSid]}
          cols={ZEN_DEFAULT_COLS}
          fontFamily={fontFamily}
          baseFontSize={fontSize}
          onExit={() => openZen(null)}
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
    </WorkspaceSessionsContext.Provider>
  );
}
