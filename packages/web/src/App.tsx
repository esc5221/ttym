import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as api from '@ttym/api';
import { TerminalMux, Terminal, refreshTerminalThemes, ensureFontsRegistered, resetAllHosts, reactivateHosts } from '@ttym/ui';
import type { SessionInfo } from '@ttym/ui';
import '@xterm/xterm/css/xterm.css';
import { layoutToSessionIds, nextWorkspaceName } from '@ttym/shared';
import { apiAddStream, apiDeleteWorkspace, apiRemoveStream, apiRenameStream, apiReorderStreams, fetchStreams, groupByStream, isNameConflict, streamOf, tabStyle, UNSORTED_STREAM, AGENT_COLORS, API_BASE, useSurface, useViewportHeight, IS_NATIVE, TTYM_HOST, UI_STYLES, UI_STYLE_STORAGE_KEY, apiCreateWorkspace, apiReorderWorkspaces, apiUpdateWorkspace, copySessionUrl, fetchWorkspaces, getSessionUrl, isSecure, memberLabel, miniLinkBtnStyle, navigate, parseHash, readLocalEchoEnabled, readUiStyle, sessionWorkspaceMembership, workspaceDisplayLabel, writeLocalEchoEnabled, type AgentState, type Route, type UiStyle, type Workspace } from './app-shared.js';
import { StripMenu, attachDropdownStyle, attachDropdownTitleStyle, attachDropdownItemStyle } from './StripMenu.js';
import { DashboardPage } from './DashboardPage.js';
import { MapPage } from './MapPage.js';
import { SettingsModal } from './SettingsModal.js';
import { WorkspacePage } from './workspace/WorkspacePage.js';

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



/** 에이전트 점 — 탭·stream 메뉴가 같은 것을 보게 하려고 한 곳에 둔다.
 *  도는 중이면 뛰고, 붙어만 있으면 흐리게. 없으면 아무것도 안 그린다. */
function AgentDot({ kind, running }: { kind: AgentState['kind'] | null | undefined; running: boolean }) {
  if (!kind) return null;
  return (
    <span
      className={running ? 'agent-dot-run' : undefined}
      style={{ width: 5, height: 5, borderRadius: '50%', background: AGENT_COLORS[kind], opacity: running ? 1 : 0.4, flexShrink: 0 }}
    />
  );
}

/** workspace 안의 에이전트 상태를 한 점으로 접는다 — 도는 게 있으면 그게 이긴다. */
function workspaceAgent(ws: Workspace, agentStates: Record<number, AgentState>): { kind: AgentState['kind'] | null; running: boolean } {
  const ids = layoutToSessionIds(ws.layout).filter((id) => id > 0);
  const states = ids.map((id) => agentStates[id]);
  const running = states.find((a) => a?.active && a.kind);
  if (running) return { kind: running.kind, running: true };
  const idle = states.find((a) => a?.kind);
  return { kind: idle?.kind ?? null, running: false };
}

function streamAgent(items: Workspace[], agentStates: Record<number, AgentState>): { kind: AgentState['kind'] | null; running: boolean } {
  let idle: AgentState['kind'] | null = null;
  for (const ws of items) {
    const a = workspaceAgent(ws, agentStates);
    if (a.running) return a;
    if (a.kind && !idle) idle = a.kind;
  }
  return { kind: idle, running: false };
}

/** 탭 줄 맨 앞의 stream 메뉴 — 보는 곳이자 만들고 옮기는 곳.
 *
 *  탭 줄은 workspace 18개에 2161px가 필요한데 1512 화면의 실제 폭은 1422다(실측).
 *  그래서 줄에는 현재 stream의 workspace만 남기고 나머지는 이 메뉴 안으로 넣는다.
 *  대신 메뉴는 열자마자 전부 보여준다 — 접힌 쪽에서 도는 것이 실측 5개 중 3개라,
 *  호버로 한 줄기씩 갈아 끼우면 그 셋을 찾느라 마우스를 열 번 옮겨야 한다.
 *  트리거의 점이 모든 stream을 통틀어 가장 급한 것을 띄우는 이유도 같다 —
 *  접는 대가를 갚는 유일한 자리다.
 *
 *  관리도 여기서 한다. stream 줄을 하나 더 두는 안은 14개가 1264px(실측 이름
 *  길이)라 1280 화면에서 넘치고, 절반이 workspace 하나짜리라 같은 이름이 위아래
 *  두 번 나온다. 이 메뉴는 이미 전부를 보여주므로 그 위에 동작만 얹는다:
 *    · 마지막 줄 "+ new stream" — 클릭하면 이름 입력. 알약을 놓아도 만든다
 *    · 줄 끝 "+" — 그 stream에 새 workspace (Paseo #4487의 compact 제안과 같은 자리)
 *    · 라벨 더블클릭 — 이름 바꾸기. 이미 있는 이름이면 Enter 한 번 더 = 합치기
 *    · 라벨 우클릭 — rename · new workspace · up/down · remove(미분류로)
 *    · 알약 드래그 — 다른 줄에 놓으면 옮긴다. 라벨 드래그 — 줄 순서
 *  탭 줄의 탭도 트리거(▾)로 끌면 이 메뉴가 열려 같은 줄에 놓을 수 있다. */
type StreamGroup = { stream: string; items: Workspace[] };

/** 드롭이 끝난 직후의 click은 '바깥 클릭'이 아니다 — 탭을 끌어다 놓으면 mouseup
 *  뒤에 click이 공통 조상(body)에서 나고, 그게 메뉴를 닫아버린다. 한 번 삼킨다. */
let swallowNextStreamMenuClose = false;
function swallowStreamMenuClose(): void { swallowNextStreamMenuClose = true; }

/** 포인터 아래의 stream 줄 이름. "+ new stream" 줄이면 NEW_STREAM_DROP. 없으면 null. */
const NEW_STREAM_DROP = '\u0000new';
function streamDropAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  if (el.closest('[data-stream-new]')) return NEW_STREAM_DROP;
  const row = el.closest('[data-stream-row]') as HTMLElement | null;
  return row?.dataset.streamRow ?? null;
}

function StreamMenu({ groups, current, agentStates, activeId, uiStyle, compact = false, open, onToggle, onPick, pendingNew, onCreateStream, onRenameStream, onRemoveStream, onReorderStreams, onMoveWorkspace, onNewWorkspaceIn, highlight }: {
  groups: StreamGroup[];
  current: string;
  agentStates: Record<number, AgentState>;
  activeId: string | null;
  uiStyle: UiStyle;
  /** 폰: 버튼은 이름 앞 네 글자(넘치면 …)와 ▾만. 탭 줄에 자리를 넘긴다 — 전체 이름은 패널에 있다. */
  compact?: boolean;
  open: boolean;
  onToggle: (open: boolean) => void;
  onPick: (ws: Workspace) => void;
  /** 탭 줄에서 "+ new stream"에 놓인 workspace — 입력창을 그 workspace를 물고 연다. */
  pendingNew: { wsId: string; nonce: number } | null;
  onCreateStream: (name: string, wsId?: string) => void;
  onRenameStream: (from: string, to: string) => void;
  onRemoveStream: (name: string) => void;
  onReorderStreams: (names: string[]) => void;
  onMoveWorkspace: (ws: Workspace, stream: string) => void;
  onNewWorkspaceIn: (stream: string) => void;
  /** 탭 줄에서 끌어온 탭이 지금 어느 줄 위에 있는가 — 그 줄을 밝힌다. */
  highlight: string | null;
}) {
  const count = groups.find((g) => g.stream === current)?.items.length ?? 0;
  const named = groups.filter((g) => g.stream !== UNSORTED_STREAM).map((g) => g.stream);

  // 열면 지금 stream 줄이 패널 가운데 온다. 폰에서는 패널이 560px인데 내용이 1800px을 넘어,
  // 맨 위부터 열면 아래쪽 stream은 스크롤해야 보였다. 패널은 StripMenu가 버튼 위치를 잰
  // 다음 프레임에 그리므로, 줄이 생길 때까지 몇 프레임 기다린다.
  useEffect(() => {
    if (!open) return;
    let raf = 0; let tries = 0;
    const center = () => {
      const row = document.querySelector<HTMLElement>(`.stream-grid [data-stream-row="${CSS.escape(current)}"]`);
      const panel = row?.closest('.stream-grid')?.parentElement;
      if (!row || !panel) { if (++tries < 10) raf = requestAnimationFrame(center); return; }
      const r = row.getBoundingClientRect(); const p = panel.getBoundingClientRect();
      panel.scrollTop += r.top - p.top - (panel.clientHeight - r.height) / 2;
    };
    raf = requestAnimationFrame(center);
    return () => cancelAnimationFrame(raf);
  }, [open, current]);

  // 열려 있는 동안 바깥 클릭으로 닫는다. 패널 안의 클릭은 stopPropagation으로
  // 여기까지 안 온다 — 입력창·드래그·우클릭 메뉴가 메뉴를 닫지 않게.
  useEffect(() => {
    if (!open) return;
    const close = () => {
      if (swallowNextStreamMenuClose) { swallowNextStreamMenuClose = false; return; }
      onToggle(false);
    };
    // 한 프레임 미뤄서 단다. React는 click 같은 discrete 이벤트에서 effect를
    // 동기로 비우므로, 즉시 달면 '메뉴를 여는 그 클릭'이 계속 버블해 방금 단
    // 이 리스너에 잡힌다 — 열리자마자 닫혀 아예 안 눌리는 것처럼 보인다.
    // (합성 click으로는 재현되지 않아 진짜 마우스로 눌러야 드러난다)
    const raf = requestAnimationFrame(() => window.addEventListener('click', close));
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onToggle(false); };
    window.addEventListener('keydown', esc);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open, onToggle]);

  // ── 새 stream 입력 ──
  const [creating, setCreating] = useState<{ wsId?: string } | null>(null);
  const [createDraft, setCreateDraft] = useState('');
  const [createTaken, setCreateTaken] = useState(false);
  useEffect(() => {
    if (!pendingNew) return;
    setCreating({ wsId: pendingNew.wsId });
    setCreateDraft('');
    setCreateTaken(false);
  }, [pendingNew?.nonce]);
  useEffect(() => { if (!open) { setCreating(null); setRenaming(null); setLabelMenu(null); } }, [open]);
  const commitCreate = () => {
    const name = createDraft.trim();
    if (!name || name === UNSORTED_STREAM) { setCreating(null); return; }
    if (named.includes(name) && !creating?.wsId) { setCreateTaken(true); return; }
    onCreateStream(name, creating?.wsId);
    setCreating(null);
  };

  // ── 라벨 인라인 rename ──
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [mergeArmed, setMergeArmed] = useState(false);
  const startRename = (name: string) => { setRenaming(name); setRenameDraft(name); setMergeArmed(false); };
  const commitRename = () => {
    if (renaming === null) return;
    const to = renameDraft.trim();
    if (!to || to === renaming || to === UNSORTED_STREAM) { setRenaming(null); return; }
    // 있는 이름으로 바꾸는 것은 합치기다 — 되돌릴 수 없으니 한 번 더 누르게 한다.
    if (named.includes(to) && !mergeArmed) { setMergeArmed(true); return; }
    onRenameStream(renaming, to);
    setRenaming(null);
  };

  // ── 라벨 우클릭 메뉴 ──
  const [labelMenu, setLabelMenu] = useState<{ name: string; x: number; y: number; armed: boolean } | null>(null);
  useEffect(() => {
    if (!labelMenu) return;
    const close = () => setLabelMenu(null);
    const raf = requestAnimationFrame(() => {
      window.addEventListener('click', close);
      window.addEventListener('contextmenu', close);
    });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
    };
  }, [labelMenu?.name]);

  // ── 드래그: 알약은 줄 사이로, 라벨은 위아래로 ──
  const [dragWs, setDragWs] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const lit = highlight ?? dropTarget;
  const [dragLabel, setDragLabel] = useState<string | null>(null);
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const suppressClick = useRef(false);

  const beginPillDrag = (ws: Workspace, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    const onMove = (ev: MouseEvent) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      if (!moved) { moved = true; suppressClick.current = true; setDragWs(ws.id); document.body.classList.add('stream-dragging'); }
      setDropTarget(streamDropAt(ev.clientX, ev.clientY));
    };
    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('stream-dragging');
      setDragWs(null);
      setDropTarget(null);
      if (!moved) return;
      const at = streamDropAt(ev.clientX, ev.clientY);
      if (at === NEW_STREAM_DROP) { setCreating({ wsId: ws.id }); setCreateDraft(''); setCreateTaken(false); }
      else if (at && at !== streamOf(ws)) onMoveWorkspace(ws, at);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const beginLabelDrag = (name: string, e: React.MouseEvent) => {
    if (e.button !== 0 || renaming !== null) return;
    const sy = e.clientY;
    let moved = false;
    let order = named.slice();
    const onMove = (ev: MouseEvent) => {
      if (!moved && Math.abs(ev.clientY - sy) < 4) return;
      if (!moved) { moved = true; suppressClick.current = true; setDragLabel(name); }
      // 탭 재배치와 같은 문법 — 이웃 줄의 중점을 넘었는가. 세로일 뿐이다.
      const rows = [...document.querySelectorAll('[data-stream-label]')] as HTMLElement[];
      const names = rows.map((r) => r.dataset.streamRow!).filter((n) => n !== UNSORTED_STREAM);
      const from = names.indexOf(name);
      if (from === -1) return;
      let to = from;
      rows.forEach((el) => {
        const n = el.dataset.streamRow!;
        const i = names.indexOf(n);
        if (i === -1) return;
        const r = el.getBoundingClientRect();
        const mid = r.top + r.height / 2;
        if (i < from && ev.clientY < mid) to = Math.min(to, i);
        else if (i > from && ev.clientY > mid) to = Math.max(to, i);
      });
      if (to !== from) {
        order = names.slice();
        order.splice(from, 1);
        order.splice(to, 0, name);
        setDragOrder(order);
      }
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      setDragLabel(null);
      setDragOrder(null);
      if (moved && order.join('\n') !== named.join('\n')) onReorderStreams(order);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // 라벨은 클릭(이동)과 더블클릭(이름 바꾸기)을 같이 받는다. 첫 클릭에 바로 가면
  // 두 번째 클릭이 닿을 자리가 없다 — 더블클릭 간격만큼 미뤘다가 간다.
  const pickTimer = useRef<number | null>(null);
  const pickLater = (ws: Workspace) => {
    if (pickTimer.current) window.clearTimeout(pickTimer.current);
    pickTimer.current = window.setTimeout(() => { pickTimer.current = null; onToggle(false); onPick(ws); }, 230);
  };
  const cancelPick = () => { if (pickTimer.current) { window.clearTimeout(pickTimer.current); pickTimer.current = null; } };

  const pill = (ws: Workspace, label: string) => {
    const agent = workspaceAgent(ws, agentStates);
    const ids = layoutToSessionIds(ws.layout).filter((id) => id > 0);
    return (
      <button
        key={ws.id}
        onMouseDown={(e) => beginPillDrag(ws, e)}
        onClick={() => {
          if (suppressClick.current) { suppressClick.current = false; return; }
          onToggle(false); onPick(ws);
        }}
        style={{
          ...tabStyle,
          cursor: dragWs === ws.id ? 'grabbing' : 'pointer',
          ...(ws.id === activeId ? { ...tabActiveStyle, background: UI_STYLES[uiStyle].tabActiveBg } : null),
          ...(dragWs === ws.id ? { opacity: 0.55 } : null),
        }}
        title={`${workspaceDisplayLabel(ws)} · 드래그: 다른 stream으로`}
      >
        <AgentDot kind={agent.kind} running={agent.running} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>{label}</span>
        <span style={{ color: 'var(--text-dim)' }}>{ids.length}</span>
      </button>
    );
  };

  const addBtn = (stream: string) => (
    <button
      onClick={() => { onToggle(false); onNewWorkspaceIn(stream); }}
      style={{ ...tabAddStyle, color: 'var(--text-dim)', height: 26 }}
      title={`new workspace in ${stream}`}
    >+</button>
  );

  // 드래그 중에는 임시 순서로 그린다 — 놓으면 서버 순서가 다시 온다.
  const shown = dragOrder
    ? [...dragOrder.map((n) => groups.find((g) => g.stream === n)!).filter(Boolean), ...groups.filter((g) => g.stream === UNSORTED_STREAM)]
    : groups;

  return (
    <StripMenu
      align="left"
      open={open}
      onToggle={() => onToggle(!open)}
      anchorStyle={compact ? { ...streamTriggerStyle, padding: '0 7px', gap: 3 } : streamTriggerStyle}
      anchorProps={{ 'data-stream-trigger': true }}
      panelStyle={streamPanelStyle}
      label={
        <>
          {/* 점은 없다 — 탭마다 이미 점이 있고, 여기 모인 점은 어느 탭 얘긴지 말해주지 못한다. */}
          {compact ? (
            <span>{Array.from(current).length > 4 ? `${Array.from(current).slice(0, 4).join('')}…` : current}</span>
          ) : (
            <>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150 }}>{current}</span>
              <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>{count}</span>
            </>
          )}
          <span style={{ color: 'var(--text-dim)', fontWeight: 400, fontSize: 9 }}>▾</span>
        </>
      }
    >
      <div className={compact ? 'stream-grid stream-grid-stack' : 'stream-grid'} onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
        {shown.map(({ stream, items }, i) => {
          const unsorted = stream === UNSORTED_STREAM;
          const agent = streamAgent(items, agentStates);
          const isRenaming = renaming === stream;
          const rowProps = { 'data-stream-row': stream, className: `stream-row${lit === stream ? ' stream-row-lit' : ''}` };
          return (
            <Fragment key={stream}>
              {i ? <div className="stream-rule" /> : null}
              {(
                <>
                  {isRenaming ? (
                    <div {...rowProps} data-stream-label style={{ display: 'flex', alignItems: 'center', height: 29, paddingLeft: 7 }}>
                      <input
                        autoFocus
                        value={renameDraft}
                        onChange={(e) => { setRenameDraft(e.target.value); setMergeArmed(false); }}
                        onBlur={() => setRenaming(null)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                          else if (e.key === 'Escape') { e.preventDefault(); setRenaming(null); }
                        }}
                        style={{ ...streamInputStyle, borderColor: mergeArmed ? 'var(--warn, #d9a441)' : 'var(--line-strong)' }}
                        title={mergeArmed ? `Enter again: merge into ${renameDraft.trim()}` : 'Enter: rename · Esc: cancel'}
                      />
                      {mergeArmed ? <span style={{ color: 'var(--text-dim)', fontSize: 10, marginLeft: 6, whiteSpace: 'nowrap' }}>Enter again = merge</span> : null}
                    </div>
                  ) : (
                    <button
                      {...rowProps}
                      data-stream-label
                      onMouseDown={(e) => { if (!unsorted) beginLabelDrag(stream, e); }}
                      onClick={() => {
                        if (suppressClick.current) { suppressClick.current = false; return; }
                        if (items[0]) pickLater(items[0]);
                      }}
                      onDoubleClick={() => { cancelPick(); if (!unsorted) startRename(stream); }}
                      onContextMenu={(e) => { e.preventDefault(); if (!unsorted) setLabelMenu({ name: stream, x: e.clientX, y: e.clientY, armed: false }); }}
                      style={{
                        ...streamLabelStyle,
                        // 이름 칸은 fit-content(120px)로 묶여 있다. 칸이 글자를 따라 늘지 않게 버튼이
                        // 칸 폭을 넘지 못하고, 넘치는 이름은 … 로 줄인다 (전체는 title).
                        minWidth: 0, maxWidth: '100%', overflow: 'hidden',
                        color: stream === current ? 'var(--text)' : 'var(--text-soft)',
                        cursor: unsorted ? 'default' : dragLabel === stream ? 'grabbing' : 'pointer',
                        ...(dragLabel === stream ? { opacity: 0.55 } : null),
                      }}
                      title={unsorted ? '아직 stream이 없는 workspace' : `${stream} · 더블클릭: 이름 변경 · 드래그: 순서 · 우클릭: 메뉴`}
                    >
                      <AgentDot kind={agent.kind} running={agent.running} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{stream}</span>
                    </button>
                  )}
                  <div {...rowProps} className={`${rowProps.className} stream-pills`}>
                    {items.map((ws) => pill(ws, ws.name))}
                    {items.length === 0 ? <span style={{ color: 'var(--text-dim)', fontSize: 11, alignSelf: 'center', padding: '0 4px' }}>empty</span> : null}
                    <span style={{ flex: 1 }} />
                    {addBtn(stream)}
                  </div>
                </>
              )}
            </Fragment>
          );
        })}
        <div className="stream-rule" />
        {creating ? (
          <div data-stream-new className={`stream-new${lit === NEW_STREAM_DROP ? ' stream-row-lit' : ''}`} style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8, height: 29, paddingLeft: 7 }}>
            <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>+</span>
            <input
              autoFocus
              value={createDraft}
              placeholder={creating.wsId ? `new stream for ${groups.flatMap((g) => g.items).find((w) => w.id === creating.wsId)?.name ?? ''}` : 'new stream name'}
              onChange={(e) => { setCreateDraft(e.target.value); setCreateTaken(false); }}
              onBlur={() => setCreating(null)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitCreate(); }
                else if (e.key === 'Escape') { e.preventDefault(); setCreating(null); }
              }}
              style={{ ...streamInputStyle, borderColor: createTaken ? 'var(--err)' : 'var(--line-strong)' }}
              title="Enter: create · Esc: cancel"
            />
            {createTaken ? <span style={{ color: 'var(--err)', fontSize: 10 }}>already exists</span> : null}
          </div>
        ) : (
          <button
            data-stream-new
            className={`stream-new${lit === NEW_STREAM_DROP ? ' stream-row-lit' : ''}`}
            onClick={() => { setCreating({}); setCreateDraft(''); setCreateTaken(false); }}
            style={{ ...streamLabelStyle, gridColumn: '1 / -1', fontWeight: 400, color: 'var(--text-dim)' }}
            title="새 stream · 알약을 여기 놓아도 만든다"
          >+ new stream</button>
        )}
      </div>
      {labelMenu ? createPortal(
        <div
          onClick={(e) => e.stopPropagation()}
          style={{ ...attachDropdownStyle, minWidth: 160, left: Math.min(labelMenu.x, window.innerWidth - 170), top: Math.min(labelMenu.y, window.innerHeight - 200), zIndex: 60 }}
        >
          <div style={{ ...attachDropdownTitleStyle, textTransform: 'none', fontSize: 11 }}>{labelMenu.name}</div>
          <button style={attachDropdownItemStyle} onClick={() => { setLabelMenu(null); startRename(labelMenu.name); }}>rename</button>
          <button style={attachDropdownItemStyle} onClick={() => { setLabelMenu(null); onToggle(false); onNewWorkspaceIn(labelMenu.name); }}>new workspace</button>
          {(() => {
            const i = named.indexOf(labelMenu.name);
            const swap = (j: number) => { const o = named.slice(); [o[i], o[j]] = [o[j], o[i]]; setLabelMenu(null); onReorderStreams(o); };
            return (
              <>
                <button style={attachDropdownItemStyle} disabled={i <= 0} onClick={() => swap(i - 1)}>move up</button>
                <button style={attachDropdownItemStyle} disabled={i < 0 || i >= named.length - 1} onClick={() => swap(i + 1)}>move down</button>
              </>
            );
          })()}
          <div style={{ height: 1, background: 'var(--line)', margin: '5px 6px 1px' }} />
          {(() => {
            const n = groups.find((g) => g.stream === labelMenu.name)?.items.length ?? 0;
            return (
              <button
                style={{ ...attachDropdownItemStyle, color: labelMenu.armed ? 'var(--err)' : 'var(--text-soft)' }}
                onClick={() => {
                  if (n > 0 && !labelMenu.armed) { setLabelMenu({ ...labelMenu, armed: true }); return; }
                  setLabelMenu(null); onRemoveStream(labelMenu.name);
                }}
              >
                {labelMenu.armed ? 'confirm remove' : 'remove'}
                {n > 0 ? <span style={{ color: 'var(--text-dim)', marginLeft: 6, fontSize: 11 }}>· {n} → {UNSORTED_STREAM}</span> : null}
              </button>
            );
          })()}
        </div>,
        document.body,
      ) : null}
    </StripMenu>
  );
}

const streamInputStyle: React.CSSProperties = {
  background: 'var(--bg0)',
  color: 'var(--text)',
  border: '1px solid var(--line-strong)',
  borderRadius: 4,
  padding: '1px 5px',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  width: 150,
  outline: 'none',
};

const streamTriggerStyle: React.CSSProperties = {
  ...tabStyle,
  fontWeight: 700,
  color: 'var(--text)',
  background: 'var(--bg1)',
  border: '1px solid var(--line)',
  cursor: 'pointer',
};

const streamPanelStyle: React.CSSProperties = {
  // 실측 684×505에 18개가 스크롤 없이 들어간다. 폰에서는 화면이 정하게 둔다.
  width: 'min(684px, calc(100vw - 20px))',
  minWidth: 0,
  maxHeight: 'min(560px, calc(100vh - 90px))',
};

const streamLabelStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  height: 29,
  padding: '0 4px 0 7px',
  fontSize: 12,
  fontWeight: 700,
  fontFamily: 'var(--mono)',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  textAlign: 'left',
};

/** 탭 우클릭 메뉴 — 이름 바꾸기와 삭제.
 *
 *  hover ×가 아니라 우클릭인 이유: 탭은 이미 클릭(이동)·더블클릭(rename)·
 *  드래그(재배치) 세 제스처를 쓴다. 하루에 수십 번 누르는 자리에 되돌릴 수 없는
 *  버튼을 네 번째로 앉히면 언젠가 잘못 눌린다. 폭도 늘어난다 — gpai 8개가 이미
 *  1109px로 스트립 1081을 넘고 있다. 삭제는 드물고 못 되돌리니 일부러 가는
 *  자리에 둔다.
 *
 *  세션이 살아 있으면 한 번 더 누르게 한다. 삭제는 터미널까지 죽이는데,
 *  그 6개를 실수로 날리면 복구가 없다. 모달을 새로 만들지 않고 같은 항목이
 *  두 번째 얼굴로 바뀐다 — 새 개념 없이 확인만 얻는 가장 싼 방법.
 *
 *  첫 얼굴이 값을 말하고(delete · 2 sessions) 두 번째가 행동을 말한다
 *  (confirm delete). 확인은 사용자를 떠보는 게 아니라 잃을 것을 보여주고
 *  다시 묻는 일이다. 잃을 게 없으면(세션 0) 묻지 않고 바로 지운다. */
function TabContextMenu({ target, streams, onClose, onRename, onDelete, onMove }: {
  target: { ws: Workspace; x: number; y: number } | null;
  streams: string[];
  onClose: () => void;
  onRename: (ws: Workspace) => void;
  onDelete: (ws: Workspace) => void;
  /** 목록에 없는 이름이면 새 stream이 되어 거기로 간다. */
  onMove: (ws: Workspace, stream: string) => void;
}) {
  const [armed, setArmed] = useState(false);
  const [newName, setNewName] = useState('');
  useEffect(() => { setArmed(false); setNewName(''); }, [target?.ws.id]);
  useEffect(() => {
    if (!target) return;
    const close = () => onClose();
    // StreamMenu와 같은 이유로 한 프레임 미룬다 — 여는 이벤트가 그대로
    // 버블해 방금 단 리스너에 잡히면 열리자마자 닫힌다.
    const raf = requestAnimationFrame(() => {
      window.addEventListener('click', close);
      window.addEventListener('contextmenu', close);
    });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
    };
  }, [target, onClose]);

  if (!target) return null;
  const live = layoutToSessionIds(target.ws.layout).filter((id) => id > 0).length;
  return createPortal(
    <div
      // 패널 안의 클릭은 '바깥 클릭'이 아니다. 안 끊으면 delete 첫 클릭이
      // 확인 단계로 가는 대신 메뉴를 닫아버려, 확인이 영영 안 뜬다.
      onClick={(e) => e.stopPropagation()}
      style={{
      ...attachDropdownStyle,
      minWidth: 180,
      // 오른쪽 끝에서 열면 화면 밖으로 나간다 — 커서 자리를 쓰되 안으로 물린다.
      maxHeight: 'min(420px, calc(100vh - 80px))',
      left: Math.min(target.x, window.innerWidth - 190),
      top: Math.min(target.y, window.innerHeight - 120),
      }}
    >
      {/* 구획 이름이 아니라 사람이 지은 이름이라 대문자로 소리치지 않는다 */}
      <div style={{ ...attachDropdownTitleStyle, textTransform: 'none', fontSize: 11 }}>
        {workspaceDisplayLabel(target.ws)}
      </div>
      <button
        style={attachDropdownItemStyle}
        onClick={() => { onClose(); onRename(target.ws); }}
      >rename</button>
      <button
        style={{ ...attachDropdownItemStyle, color: armed ? 'var(--err)' : 'var(--text-soft)' }}
        onClick={() => {
          if (live > 0 && !armed) { setArmed(true); return; }
          onClose();
          onDelete(target.ws);
        }}
      >
        {armed ? 'confirm delete' : 'delete'}
        {!armed && live > 0 ? (
          <span style={{ color: 'var(--text-dim)', marginLeft: 6, fontSize: 11 }}>
            · {live} session{live === 1 ? '' : 's'}
          </span>
        ) : null}
      </button>
      {/* 요약기가 정한 묶음을 사람이 되돌릴 자리. 이게 없으면 잘못 묶인 것을
          고칠 방법이 아예 없어서, 새 workspace를 어디에 두든 절반은 틀린 채로
          남는다. 고르면 그 이름은 고정된다 — 요약기는 이름 없는 것만 건드린다. */}
      {/* 위는 이 workspace에 하는 일, 아래는 갈 곳. 두 구획이라 선으로 가른다 */}
      <div style={{ height: 1, background: 'var(--line)', margin: '5px 6px 1px' }} />
      <div style={attachDropdownTitleStyle}>move to stream</div>
      {/* 새 이름을 칠 자리. 이게 없으면 목록에 있는 곳으로만 갈 수 있어서,
          첫 번째 stream은 아무 데서도 만들 수 없다. */}
      <input
        value={newName}
        placeholder="new stream…"
        onChange={(e) => setNewName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const name = newName.trim();
            if (!name || name === UNSORTED_STREAM) return;
            e.preventDefault(); onClose(); onMove(target.ws, name);
          } else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
        }}
        style={{ ...streamInputStyle, width: 'calc(100% - 16px)', margin: '2px 8px 4px' }}
      />
      {streams.map((name) => {
        const here = name === streamOf(target.ws);
        return (
          <button
            key={name}
            disabled={here}
            style={{
              ...attachDropdownItemStyle,
              color: here ? 'var(--text-dim)' : 'var(--text-soft)',
              cursor: here ? 'default' : 'pointer',
            }}
            onClick={() => { if (here) return; onClose(); onMove(target.ws, name); }}
          >
            {name}
            {here ? <span style={{ color: 'var(--text-dim)', marginLeft: 6, fontSize: 11 }}>· here</span> : null}
          </button>
        );
      })}
    </div>,
    document.body,
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
  // 명시적으로 preview를 고른 적 있을 때만 preview — 신규 설치의 기본은 map.
  try { return localStorage.getItem(MAIN_VIEW_STORAGE_KEY) === 'preview' ? 'preview' : 'map'; } catch { return 'map'; }
}

function App() {
  const muxRef = useRef<TerminalMux | null>(null);
  const [connected, setConnected] = useState(false);
  const [route, setRoute] = useState<Route>(parseHash);
  const [localEchoEnabled, setLocalEchoEnabled] = useState(readLocalEchoEnabled);
  const [uiStyle, setUiStyle] = useState<UiStyle>(readUiStyle);
  const [fontSize, setFontSize] = useState(14);
  // 빈 문자열 = 플랫폼 기본에 맡긴다 (맥=Menlo, 그 외=Monoplex KR Nerd).
  const [fontFamily, setFontFamily] = useState('');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  /** stream 이름의 순서 — 서버 목록. 빈 stream은 여기에만 있다. */
  const [streams, setStreams] = useState<string[]>([]);
  const [streamMenuOpen, setStreamMenuOpen] = useState(false);
  /** 탭 줄에서 '+ new stream'에 놓인 탭 — 메뉴의 입력창이 그 workspace를 물고 열린다. */
  const [pendingNewStream, setPendingNewStream] = useState<{ wsId: string; nonce: number } | null>(null);
  /** 탭을 끌고 있을 때 메뉴의 어느 줄 위인가. */
  const [streamDropLit, setStreamDropLit] = useState<string | null>(null);
  const [agentStates, setAgentStates] = useState<Record<number, AgentState>>({});
  const [stripSlot, setStripSlot] = useState<HTMLSpanElement | null>(null);
  const appSurface = useSurface();
  const phone = appSurface === 'phone';
  const visualH = useViewportHeight();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [tabMenu, setTabMenu] = useState<{ ws: Workspace; x: number; y: number } | null>(null);

  // 목적지 목록. 지금 비어 있어도 미분류는 항상 갈 수 있어야 한다 — 여기서
  // 빼내는 게 이 메뉴의 주된 쓸모다.
  const streamTargets = useMemo(() => {
    const names = groupByStream(workspaces, streams).map((g) => g.stream);
    return names.includes(UNSORTED_STREAM) ? names : [...names, UNSORTED_STREAM];
  }, [workspaces, streams]);

  const moveWorkspaceToStream = useCallback(async (ws: Workspace, stream: string) => {
    // column/order는 지도의 배치라 여기서 건드릴 게 아니다. 서버의 update가
    // map을 통째로 갈아끼우므로 남은 필드를 직접 실어 보낸다.
    // 먼저 그리고 나중에 보낸다 — 드롭한 알약이 그 자리에서 바로 옮겨가야
    // 놓은 게 맞았는지 보인다. 서버 push가 같은 값을 다시 준다.
    const next = stream === UNSORTED_STREAM ? undefined : stream;
    setWorkspaces((prev) => prev.map((w) => (w.id === ws.id ? { ...w, map: { ...w.map, stream: next } } : w)));
    if (next && !streams.includes(next)) setStreams((prev) => (prev.includes(next) ? prev : [...prev, next]));
    await apiUpdateWorkspace(ws.id, { map: { stream: next, column: ws.map?.column, order: ws.map?.order } });
  }, [streams]);


  const deleteWorkspace = useCallback(async (ws: Workspace) => {
    const ids = layoutToSessionIds(ws.layout).filter((id) => id > 0);
    // 세션을 먼저 죽인다. workspace만 지우면 PTY는 holder에 살아남아
    // 어디에도 안 붙은 유령이 된다 (CLI의 delete와 같은 순서).
    for (const sid of ids) muxRef.current?.destroySession(sid);
    await apiDeleteWorkspace(ws.id);
    const next = await fetchWorkspaces();
    setWorkspaces(next);
    // 보고 있던 탭을 지웠으면 갈 곳을 정해준다 — 같은 stream의 이웃, 없으면 홈.
    if (route.page === 'workspace' && route.id === ws.id) {
      const sibling = next.find((w) => w.id !== ws.id && streamOf(w) === streamOf(ws));
      navigate(sibling ? { page: 'workspace', id: sibling.id } : { page: 'dashboard' });
    }
  }, [route]);

  const commitRename = useCallback(async () => {
    const id = renamingId;
    const name = renameDraft.trim();
    setRenamingId(null);
    if (!id || !name) return;
    try { await api.updateWorkspace(API_BASE, id, { name }); } catch {}
  }, [renamingId, renameDraft]);

  const [connectNote, setConnectNote] = useState('connecting to ttym server...');
  // 첫 접속 전에만 화면을 통째로 내준다. 그 뒤의 끊김은 배너로만 말한다 —
  // 트리를 버리면 host가 언마운트되고, 그게 곧 화면 상실이다.
  const [everConnected, setEverConnected] = useState(false);

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
          if (!cancelled) { setConnected(true); setEverConnected(true); }
          return;
        } catch {
          setConnectNote(`retrying in ${Math.round(delayMs / 1000) || 1}s…`);
          await new Promise((r) => setTimeout(r, delayMs));
          delayMs = Math.min(delayMs * 2, 5000);
        }
      }
    };
    void attempt(500);

    // 끊기면 조용히 재접속하고 살아있는 버퍼 위에 delta를 잇는다. 예전엔
    // 여기서 리로드했다 — host 복원을 통째로 피하는 대신 워터마크와 xterm
    // 버퍼를 같이 버려서, 복귀할 때마다 fromSeq=0 풀 스냅샷이 됐다.
    //
    // 순서가 전부다: 끊긴 즉시 host를 idle로 되돌려야(resetAllHosts) 그 사이
    // 탭이 돌아와도 ATTACH 없는 연결에 RESUME_VIEW를 쏘지 않는다.
    const unsubscribe = mux.onDisconnect(() => {
      if (cancelled) return;
      resetAllHosts();
      setConnected(false);
      setConnectNote('disconnected · reconnecting…');
      const retry = async () => {
        let delay = 500;
        while (!cancelled) {
          try {
            await mux.connect();
            if (cancelled) return;
            setConnected(true);
            // 워터마크는 mux.cleanup()을 살아남았다 — 재부착은 그 지점부터다.
            reactivateHosts();
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
    void fetchStreams().then(setStreams);
    const mux = muxRef.current;
    if (!mux) return;
    return mux.onWorkspace((event) => {
      if (event.streams) { setStreams(event.streams); return; }
      setWorkspaces((prev) => {
        if (event.order) {
          // 서버가 부른 순서 전체 — 모르는 id(경합 생성분)는 꼬리에 보존
          const byId = new Map(prev.map((w) => [w.id, w]));
          const ordered = (event.order as string[]).map((id) => byId.get(id)).filter(Boolean) as Workspace[];
          const rest = prev.filter((w) => !(event.order as string[]).includes(w.id));
          return [...ordered, ...rest];
        }
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
      // 세션당 1요청(N+1)이던 것을 한 판으로 — 창 10개가 각자 돌리던 안전망이
      // 분당 270커넥션을 만들던 실측이 이 배치의 이유다.
      try {
        const all = await api.getAgentStates(API_BASE);
        if (cancelled) return;
        const entries = memberIds.map((id) => {
          const state = all[id];
          return [id, state ? { kind: state.kind as AgentState['kind'], active: state.active, sleep: state.sleep ?? null } : { kind: null, active: false }] as const;
        });
        setAgentStates(Object.fromEntries(entries));
      } catch {}
    };
    void sweep();
    const fallback = window.setInterval(() => { void sweep(); }, 60_000);
    const mux = muxRef.current;
    const unsubscribe = mux ? mux.onAgent((event) => {
      setAgentStates((prev) => ({ ...prev, [event.sessionId]: { kind: event.kind, active: event.active, sleep: event.sleep ?? null } }));
    }) : undefined;
    return () => { cancelled = true; window.clearInterval(fallback); unsubscribe?.(); };
  }, [connected, workspaces.map((w) => w.id + ':' + layoutToSessionIds(w.layout).join('.')).join('|')]);

  // ── 탭 넘침: 탭 구간만 가로 스크롤 (스크롤바 없음, 양끝 페이드가 힌트) ──
  const tabScrollerRef = useRef<HTMLDivElement | null>(null);
  const [tabFade, setTabFade] = useState({ left: false, right: false });
  const updateTabFade = useCallback(() => {
    const el = tabScrollerRef.current;
    if (!el) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft < el.scrollWidth - el.clientWidth - 2;
    setTabFade((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);
  useEffect(() => {
    updateTabFade();
    window.addEventListener('resize', updateTabFade);
    return () => window.removeEventListener('resize', updateTabFade);
  }, [updateTabFade, workspaces.length]);
  // 활성 탭은 어디서 열어도 시야 한가운데로 온다.
  //
  // nearest는 최소한만 움직여 탭을 가장자리에 붙여놓는다 — 탭 15개짜리에서
  // 12번째를 열면 오른쪽 끝에 정확히 걸쳐(실측 right 370 = 스크롤러 끝) 양끝의
  // 페이드에 흐려지고, 잘린 것처럼 읽힌다. center면 좌우 이웃이 함께 보여
  // 지금 어디쯤인지도 같이 드러난다. 양 끝 탭은 center가 불가능해 자연히
  // 가장자리에 서는데, 그건 실제로 끝이라 오해가 없다.
  useEffect(() => {
    if (route.page !== 'workspace') return;
    const el = tabScrollerRef.current?.querySelector(`[data-ws-tab="${route.id}"]`);
    (el as HTMLElement | null)?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [route, workspaces.length]);

  // ── 탭 드래그 재배치 — 4px 문턱 전까지는 클릭/더블클릭 문법 그대로 ──
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const suppressTabClick = useRef(false);
  // 탭 줄에 남길 것: 현재 stream의 workspace만. 현재 stream은 열려 있는 탭이
  // 정한다 — 따로 저장하지 않는다. 홈·지도처럼 workspace가 없는 화면에서는
  // 마지막으로 있던 줄기를 기억한다 (없으면 첫 줄기).
  const streamGroups = useMemo(() => groupByStream(workspaces, streams), [workspaces, streams]);
  const activeWs = route.page === 'workspace' ? workspaces.find((w) => w.id === route.id) ?? null : null;
  const [lastStream, setLastStream] = useState<string | null>(null);
  useEffect(() => {
    if (activeWs) setLastStream(streamOf(activeWs));
  }, [activeWs?.id, activeWs ? streamOf(activeWs) : null]);
  const currentStream = activeWs
    ? streamOf(activeWs)
    : (lastStream && streamGroups.some((g) => g.stream === lastStream) ? lastStream : streamGroups[0]?.stream ?? UNSORTED_STREAM);
  const visibleWorkspaces = useMemo(
    () => streamGroups.find((g) => g.stream === currentStream)?.items ?? [],
    [streamGroups, currentStream],
  );

  // ── stream 관리. 전부 낙관적 — 서버 push(streams 전체)가 곧 따라온다 ──
  const createStream = useCallback((name: string, wsId?: string) => {
    if (!streams.includes(name)) {
      setStreams((prev) => (prev.includes(name) ? prev : [...prev, name]));
      void apiAddStream(name);
    }
    const ws = wsId ? workspaces.find((w) => w.id === wsId) : null;
    if (ws) void moveWorkspaceToStream(ws, name);
  }, [streams, workspaces, moveWorkspaceToStream]);
  const renameStream = useCallback((from: string, to: string) => {
    setStreams((prev) => (prev.includes(to) ? prev.filter((s) => s !== from) : prev.map((s) => (s === from ? to : s))));
    setWorkspaces((prev) => prev.map((w) => (streamOf(w) === from ? { ...w, map: { ...w.map, stream: to } } : w)));
    if (lastStream === from) setLastStream(to);
    void apiRenameStream(from, to);
  }, [lastStream]);
  const removeStream = useCallback((name: string) => {
    setStreams((prev) => prev.filter((s) => s !== name));
    setWorkspaces((prev) => prev.map((w) => (streamOf(w) === name ? { ...w, map: { ...w.map, stream: undefined } } : w)));
    void apiRemoveStream(name);
  }, []);
  const reorderStreams = useCallback((names: string[]) => {
    setStreams(names);
    void apiReorderStreams(names);
  }, []);

  const beginTabDrag = useCallback((id: string, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;
    // 스트립 밖(아래)으로 나간 드래그는 stream 메뉴로 가는 길이다: 트리거(▾)에
    // 닿으면 메뉴가 열리고, 그 줄에 놓으면 옮겨진다. 그동안 탭 재배치는 멈춘다 —
    // 안 그러면 메뉴로 내려가는 사이에 X가 흔들려 탭이 제멋대로 밀린다.
    let inMenu = false;
    let boardCol: string | null = null;
    const onMove = (ev: MouseEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      if (!moved) { moved = true; suppressTabClick.current = true; setDragTabId(id); document.body.classList.add('stream-dragging'); }
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      if (under?.closest('[data-stream-trigger]')) { inMenu = true; setStreamMenuOpen(true); }
      if (inMenu) { setStreamDropLit(streamDropAt(ev.clientX, ev.clientY)); return; }
      // map 홈에서는 보드 칸이 바로 아래 있다 — 그 칸에 놓으면 그 stream으로 옮긴다.
      // 탭을 어디로 끌지(순서냐 다른 stream이냐)를 한 제스처로 자연스럽게 가른다.
      const col = (under?.closest('[data-wmb-col]') as HTMLElement | null)?.dataset.wmbCol ?? null;
      boardCol = col;
      const boardCols = document.querySelectorAll('[data-wmb-col]');
      boardCols.forEach((c) => c.classList.toggle('lit', (c as HTMLElement).dataset.wmbCol === col));
      if (col) return;
      if (Math.abs(ev.clientY - startY) > 30) return;
      // 삽입 위치: 형제 탭들의 중점을 넘었는가. 상태 재배열 → 리렌더 → 다음
      // move가 새 DOM을 재측정 — 반복 수렴이라 좌우 어느 방향도 자연스럽다.
      const tabs = [...document.querySelectorAll('[data-ws-tab]')] as HTMLElement[];
      const ids = tabs.map((t) => t.dataset.wsTab!);
      const from = ids.indexOf(id);
      if (from === -1) return;
      let to = from;
      tabs.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        const mid = r.left + r.width / 2;
        if (i < from && ev.clientX < mid) to = Math.min(to, i);
        else if (i > from && ev.clientX > mid) to = Math.max(to, i);
      });
      if (to !== from) {
        // DOM에 보이는 것은 현재 stream의 탭뿐이라 to는 '보이는 순서'의 자리다.
        // 전역 배열에 그대로 쓰면 다른 stream 사이로 끼어든다 — 목표 자리에 있던
        // 탭의 전역 인덱스로 옮겨 심는다.
        const targetId = ids[to];
        setWorkspaces((prev) => {
          const arr = prev.slice();
          const at = arr.findIndex((w) => w.id === id);
          const dest = arr.findIndex((w) => w.id === targetId);
          if (at === -1 || dest === -1) return prev;
          const [item] = arr.splice(at, 1);
          arr.splice(arr.findIndex((w) => w.id === targetId) + (dest > at ? 1 : 0), 0, item);
          return arr;
        });
      }
    };
    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('stream-dragging');
      setDragTabId(null);
      setStreamDropLit(null);
      document.querySelectorAll('[data-wmb-col]').forEach((c) => c.classList.remove('lit'));
      if (!moved) return;
      if (boardCol) {
        const ws = workspacesRef.current.find((w) => w.id === id);
        if (ws && boardCol !== streamOf(ws)) void moveWorkspaceToStream(ws, boardCol);
        return;
      }
      if (inMenu) {
        const at = streamDropAt(ev.clientX, ev.clientY);
        const ws = workspacesRef.current.find((w) => w.id === id);
        // 놓은 뒤의 click이 메뉴를 닫지 않게 — 새 stream 입력창이 열려 있어야 한다.
        swallowStreamMenuClose();
        if (ws && at === NEW_STREAM_DROP) setPendingNewStream({ wsId: id, nonce: Date.now() });
        else if (ws && at && at !== streamOf(ws)) { void moveWorkspaceToStream(ws, at); setStreamMenuOpen(false); }
        return;
      }
      setWorkspaces((prev) => {
        void apiReorderWorkspaces(prev.map((w) => w.id));
        return prev;
      });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [moveWorkspaceToStream]);
  const workspacesRef = useRef<Workspace[]>([]);
  workspacesRef.current = workspaces;

  const createWorkspaceTab = useCallback(async (stream: string = currentStream) => {
    // 이름의 유일성은 서버가 판정한다. 다른 창이 같은 번호를 동시에 집을 수
    // 있으니, 충돌한 이름은 빼고 다음 번호로 몇 번 더 시도한다. 충돌이 아닌
    // 실패(터널 끊김 등)는 재시도해봐야 같은 결과라 바로 그만둔다.
    const taken = new Set(workspaces.map((w) => w.name));
    let ws: Workspace | null = null;
    for (let attempt = 0; attempt < 5 && !ws; attempt++) {
      const name = nextWorkspaceName(taken);
      try {
        ws = await apiCreateWorkspace({ id: uuid().slice(0, 8), name, layout: { type: 'pane', sessionId: 0 }, stream: stream === UNSORTED_STREAM ? undefined : stream });
      } catch (error) {
        if (!isNameConflict(error)) {
          // 화면에 띄울 자리가 아직 없다. 적어도 콘솔에는 남긴다 —
          // 아무 데도 안 남으면 다음에도 "버튼이 안 눌린다"로만 보인다.
          console.error('workspace 만들기 실패', error);
          return;
        }
        taken.add(name);
      }
    }
    if (!ws) return;
    // 보고 있던 줄기(또는 메뉴에서 고른 줄기)에 넣는다. gpai를 열어놓고 +를
    // 누르는 건 gpai에서 일을 하나 더 벌인다는 뜻이지, 분류를 미루겠다는 뜻이
    // 아니다. 안 붙이면 탭 줄이 미분류로 통째로 갈아엎이면서 보던 형제 탭들이
    // 사라진다. 만들 때 같이 보내므로(POST의 map) 탭 줄이 미분류로 튀었다
    // 돌아오는 일이 없다.
    //
    // 미분류에서 만든 것에는 아무것도 안 붙인다. stream이 비어 있어야 요약기가
    // 이름을 지어주므로, 그 자리는 "아직 분류 안 함"의 뜻을 유지한다.
    navigate({ page: 'workspace', id: ws.id });
  }, [workspaces.length, currentStream]);

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
      // 줄에 보이는 것과 번호가 어긋나면 안 된다 — 필터된 목록을 센다.
      const ws = visibleWorkspaces[at - 1];
      if (ws) navigate({ page: 'workspace', id: ws.id });
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [visibleWorkspaces]);

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
    // 터미널과 UI 크롬이 같은 스택을 쓴다 — 둘이 갈리면 탭 라벨과 pane 안의
    // 글자가 다른 폰트로 보인다. --mono는 index.html이 심어둔 기본을 덮어쓴다.
    if (values['font-family'] !== undefined) {
      const stack = values['font-family'].trim();
      setFontFamily(stack);
      if (stack) {
        // 크롬은 터미널보다 먼저 그려진다 — 등록을 TerminalHost에 맡기면
        // 첫 pane이 뜨기 전까지 탭 라벨만 폴백 폰트로 보인다.
        ensureFontsRegistered(stack);
        document.documentElement.style.setProperty('--mono', stack);
      } else {
        document.documentElement.style.removeProperty('--mono');
      }
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

  if (!muxRef.current || (!connected && !everConnected)) {
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
      page = <WorkspacePage key={route.id} mux={mux} workspaceId={route.id} pane={route.pane ?? null} zen={route.zen ?? null} open={route.open ?? null} localEchoEnabled={localEchoEnabled} agentStates={agentStates} actionsSlot={stripSlot} uiStyle={uiStyle} fontSize={fontSize} fontFamily={fontFamily} />;
      break;
    default:
      page = mainView === 'map'
        ? <MapPage mux={mux} />
        : <DashboardPage mux={mux} agentStates={agentStates} localEchoEnabled={localEchoEnabled} actionsSlot={stripSlot} />;
      break;
  }

  const homeActive = route.page === 'dashboard' || route.page === 'overview';

  return (
    // 키보드가 올라오면 100vh는 그대로인데 가시 영역만 줄어든다. 폰에서는
    // 그 차이가 곧 잘려나가는 높이라, 루트를 visualViewport에 묶는다.
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: appSurface !== 'desktop' && visualH !== null ? visualH : '100vh',
      // pan-y: 세로 스크롤(터미널 scrollback)은 살리고 브라우저의 핀치 줌만 끊는다.
      // 안 막으면 터미널에서 핀치할 때 페이지가 통째로 확대되어 visualViewport가
      // 755에서 151까지 무너지고(실측), 루트를 거기 묶어놨으니 터미널이 한 줄로
      // 찌그러진다. viewport meta의 user-scalable=no 는 쓰지 않는다 — 페이지 전체
      // 접근성을 죽이는 데다 최신 Chrome은 무시하기도 한다.
      // overscroll-behavior: 아래로 당겼을 때 Chrome이 페이지를 새로고침해
      // 목록으로 튕기던 것(pull-to-refresh)을 끊는다.
      ...(appSurface !== 'desktop' ? { touchAction: 'pan-y', overscrollBehavior: 'none' as const } : null),
    }}>
      {connected ? null : (
        // 흐름에 끼우지 않고 떠 있는다: 한 줄이라도 자리를 차지하면 pane 높이가
        // 바뀌고, fit이 그걸 PTY resize로 번역해 끊긴 김에 화면까지 재배치된다.
        <div style={{
          position: 'fixed', top: 6, right: 8, zIndex: 90,
          padding: '3px 9px', borderRadius: 999,
          background: 'var(--warn-bg, #4a3a1a)', color: 'var(--warn-fg, #f0d090)',
          font: '11px var(--mono)', pointerEvents: 'none', opacity: 0.92,
        }}>{connectNote}</div>
      )}
      <div
        {...(IS_NATIVE ? { 'data-tauri-drag-region': true } : {})}
        style={{ ...tabStripStyle, background: UI_STYLES[uiStyle].stripBg, borderBottom: UI_STYLES[uiStyle].stripLine, paddingLeft: IS_NATIVE ? 84 : 10 }}
      >
        <button
          onClick={() => navigate({ page: 'dashboard' })}
          style={{ ...tabStyle, ...(phone ? phoneTabTrim : null), ...(homeActive ? { ...tabActiveStyle, background: UI_STYLES[uiStyle].tabActiveBg } : null) }}
          title="home · ⌘1"
        >⌂</button>
        {/* stream이 하나뿐이어도 보인다 — 둘째 stream을 만드는 자리가 여기뿐이다 */}
        <StreamMenu
          groups={streamGroups}
          current={currentStream}
          agentStates={agentStates}
          activeId={route.page === 'workspace' ? route.id : null}
          uiStyle={uiStyle}
          compact={phone}
          open={streamMenuOpen}
          onToggle={setStreamMenuOpen}
          onPick={(ws) => navigate({ page: 'workspace', id: ws.id })}
          pendingNew={pendingNewStream}
          highlight={streamDropLit}
          onCreateStream={createStream}
          onRenameStream={renameStream}
          onRemoveStream={removeStream}
          onReorderStreams={reorderStreams}
          onMoveWorkspace={(ws, stream) => { void moveWorkspaceToStream(ws, stream); }}
          onNewWorkspaceIn={(stream) => { void createWorkspaceTab(stream); }}
        />
        <span style={{ width: 1, height: 16, background: 'var(--line)', flexShrink: 0, margin: phone ? '0 3px' : '0 5px' }} />
        <div style={{ position: 'relative', flex: 1, minWidth: 0, alignSelf: 'stretch', display: 'flex' }}>
          <div
            ref={tabScrollerRef}
            className="tab-scroller"
            onScroll={updateTabFade}
            onWheel={(e) => {
              // 세로 휠을 가로로 — 트랙패드 가로 제스처는 네이티브로 이미 온다.
              const el = tabScrollerRef.current;
              if (el && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY;
            }}
            style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, flex: 1 }}
          >
        {visibleWorkspaces.map((ws, i) => {
          const ids = layoutToSessionIds(ws.layout).filter((id) => id > 0);
          const agent = workspaceAgent(ws, agentStates);
          const active = route.page === 'workspace' && route.id === ws.id;
          return (
            <button
              key={ws.id}
              data-ws-tab={ws.id}
              onMouseDown={(e) => beginTabDrag(ws.id, e)}
              onContextMenu={(e) => { e.preventDefault(); setTabMenu({ ws, x: e.clientX, y: e.clientY }); }}
              onClick={() => {
                if (suppressTabClick.current) { suppressTabClick.current = false; return; }
                navigate({ page: 'workspace', id: ws.id });
              }}
              style={{
                ...tabStyle,
                ...(phone ? phoneTabTrim : null),
                ...(active ? { ...tabActiveStyle, background: UI_STYLES[uiStyle].tabActiveBg } : null),
                ...(dragTabId === ws.id ? { opacity: 0.55, cursor: 'grabbing' } : null),
              }}
              title={`${workspaceDisplayLabel(ws)}${IS_NATIVE ? ` · ⌘${i + 2}` : ''} · 더블클릭: 이름 변경 · 드래그: 재배치`}
              onDoubleClick={() => { setRenamingId(ws.id); setRenameDraft(ws.name); }}
            >
              <AgentDot kind={agent.kind} running={agent.running} />
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
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: phone ? 110 : 160 }}>
                  {workspaceDisplayLabel(ws)}
                </span>
              )}
              {/* 폰은 보고 있는 탭만 개수를 단다 — 나머지는 점이 상태를 말한다. */}
              {phone && !active ? null : <span style={{ color: 'var(--text-dim)' }}>{ids.length}</span>}
            </button>
          );
        })}
        <button onClick={() => void createWorkspaceTab()} style={tabAddStyle} title="new workspace">+</button>
          </div>
          {tabFade.left ? <div style={{ ...tabFadeStyle, left: 0, background: 'linear-gradient(to right, var(--bg0), transparent)' }} /> : null}
          {tabFade.right ? <div style={{ ...tabFadeStyle, right: 0, background: 'linear-gradient(to left, var(--bg0), transparent)' }} /> : null}
        </div>
        <span ref={setStripSlot} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} />
        <TabContextMenu
          target={tabMenu}
          streams={streamTargets}
          onMove={(ws, stream) => { void moveWorkspaceToStream(ws, stream); }}
          onClose={() => setTabMenu(null)}
          onRename={(ws) => { setRenamingId(ws.id); setRenameDraft(ws.name); }}
          onDelete={(ws) => { void deleteWorkspace(ws); }}
        />
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

const tabFadeStyle: React.CSSProperties = {
  position: 'absolute', top: 0, bottom: 0, width: 26, pointerEvents: 'none', zIndex: 1,
};

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
  // 좁은 화면에선 탭바가 스스로 가로 스크롤 — 페이지 전체가 밀리는 것의 방지책.
  // 데스크톱에선 내용이 다 들어가므로 아무 효과 없다.
  overflowX: 'auto',
  scrollbarWidth: 'none',
  userSelect: 'none',
};


const tabActiveStyle: React.CSSProperties = {
  // 화면에서 유일하게 채워진 크롬 = 현재 워크스페이스.
  background: 'var(--bg2)',
  color: 'var(--text)',
  border: '1px solid var(--line)',
};

/** 폰의 탭 줄 — 390px에 탭이 두 개도 안 들어가던 여백을 줄인다(스크롤 영역 178px 실측). */
const phoneTabTrim: React.CSSProperties = { padding: '0 8px', gap: 5 };

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
