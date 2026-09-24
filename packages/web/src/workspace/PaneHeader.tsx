import { useCallback, useEffect, useRef } from 'react';
import { formatCwd } from '@ttym/shared';
import { AGENT_COLORS, closeBtnStyle, copySessionUrl, miniLinkBtnStyle, type UI_STYLES } from '../app-shared.js';
import { viewSrc } from '../viewer/content.js';
import { PaneTabs } from '../viewer/PaneTabs.js';
import { sleepTitle } from './sleep-text.js';
import { paneView, useWorkspaceSessions } from './session-context.js';

/**
 * grid pane의 헤더 한 줄 — 터미널 탭(이름·#id·cwd), 뷰어 탭, 오른쪽 액션 버튼.
 *
 * 헤더를 끌어 다른 pane 헤더에 놓으면 둘이 자리를 바꾼다. 본문은 SessionBody다.
 */
export function PaneHeader({ sid, name, cwd, isFocused, dead, zoomed, fit, U, dragging, onDragStart, onDragEnd, onSwapWith, onToggleZoom, onToggleFit, onSplit, onZen, onTerminate }: {
  sid: number;
  name?: string;
  cwd?: string;
  isFocused: boolean;
  dead: boolean;
  zoomed: boolean;
  /** 터치 기기의 [fit] — 이 pane의 PTY를 화면 크기로 빌려 쓰는 중인가. */
  fit: boolean;
  U: (typeof UI_STYLES)[keyof typeof UI_STYLES];
  /** 지금 끌고 있는 pane (없으면 null). */
  dragging: number | null;
  onDragStart: () => void;
  onDragEnd: () => void;
  onSwapWith: (other: number) => void;
  onToggleZoom: () => void;
  onToggleFit: () => void;
  onSplit: (direction: 'right' | 'down') => void;
  onZen: () => void;
  onTerminate: () => void;
}) {
  const ctx = useWorkspaceSessions();
  const { viewer, touch } = ctx;
  const agent = ctx.agentStates[sid];
  const agentColor = agent?.kind ? AGENT_COLORS[agent.kind] : undefined;
  const sleep = agent?.sleep ?? null;
  const asleep = sleep?.state === 'sleeping' || sleep?.state === 'waking';
  const canRestore = !agent?.active && !asleep && (ctx.lastAgentIds[sid]?.claude || ctx.lastAgentIds[sid]?.codex);
  const { state: viewerState, tab: paneTab, item: paneItem } = paneView(ctx, sid);

  // viewer 탭 스트립이 우측 absolute 액션 클러스터(☾ sleep · zen · split · detach · × …) 밑으로
  // 깔려서, 마지막 탭의 ×를 누르려 하면 hover로 살아난 그 버튼들이 클릭을 가로채던 문제.
  // 클러스터의 실제 폭을 재서 헤더에 --pane-actions-w로 싣고, PaneTabs가 그만큼 오른쪽을 비운다.
  // reveal 버튼은 opacity만 바뀌고 폭은 그대로라(=클러스터 폭 불변) hover에도 탭이 재배치되지 않는다.
  const actionsRo = useRef<ResizeObserver | null>(null);
  const measure = (el: HTMLElement) => el.parentElement?.style.setProperty('--pane-actions-w', `${Math.ceil(el.getBoundingClientRect().width) + 16}px`);
  useEffect(() => () => actionsRo.current?.disconnect(), []);
  const actionsRef = useCallback((el: HTMLSpanElement | null) => {
    actionsRo.current?.disconnect();
    if (!el || typeof ResizeObserver === 'undefined') return;
    actionsRo.current = new ResizeObserver((entries) => { for (const e of entries) measure(e.target as HTMLElement); });
    actionsRo.current.observe(el);
    measure(el);
  }, []);

  return (
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
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
      onDrop={(e) => { e.preventDefault(); if (dragging !== null && dragging !== sid) onSwapWith(dragging); onDragEnd(); }}
      title="drag: swap"
    >
      {/* 터미널 탭 = 이름·#id (절대 안 줄어든다) + cwd (탭에 자리를 먼저 내준다). 두 형제로 나눈
          이유: 한 덩어리로 두면 flex가 덩어리째 줄여 이름까지 사라진다 — 탭 10개에서 실측. */}
      <span
        className={`pane-tab pane-tab-term${paneTab === 'term' ? ' on' : ''}`}
        onClick={() => { if (paneTab !== 'term') viewer.setActive(sid, 'term'); }}
        onDoubleClick={onToggleZoom}
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
        onDoubleClick={onToggleZoom}
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
        {ctx.bells.has(sid) ? (
          <span title="bell" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--warn)', boxShadow: '0 0 6px var(--warn)', flexShrink: 0 }} />
        ) : null}
        {zoomed ? <span style={{ color: 'var(--warn)', fontSize: 10, fontFamily: 'var(--mono)' }}>zoom</span> : null}

        {agent?.kind && !asleep && !dead ? (
          <button className="reveal" onClick={(e) => { e.stopPropagation(); void ctx.sleepAgent(sid); }} style={miniLinkBtnStyle} title="sleep now: the process exits, the screen stays, any input resumes it">☾</button>
        ) : null}
        {canRestore ? (
          <button className="reveal" onClick={(e) => { e.stopPropagation(); ctx.restoreAgent(sid); }} style={miniLinkBtnStyle} title="resume last agent session">restore</button>
        ) : null}
        {touch ? null : (
          <button className="reveal" onClick={(e) => { e.stopPropagation(); onZen(); }} style={miniLinkBtnStyle} title="zen · ⌘.">zen</button>
        )}
        <button className="reveal" onClick={(e) => { e.stopPropagation(); onSplit('right'); }} style={miniLinkBtnStyle} title="split right">│</button>
        <button className="reveal" onClick={(e) => { e.stopPropagation(); onSplit('down'); }} style={miniLinkBtnStyle} title="split down">─</button>
        {touch ? (
          <button
            className="reveal"
            onClick={(e) => {
              e.stopPropagation();
              onToggleFit();
            }}
            style={{ ...miniLinkBtnStyle, ...(fit ? { color: 'var(--accent)' } : null) }}
            title="borrow this viewport size · restored on leave"
          >{fit ? 'reset' : 'fit'}</button>
        ) : null}
        <button className="reveal" onClick={(e) => { e.stopPropagation(); void ctx.detachMember(sid); }} style={miniLinkBtnStyle} title="detach · session keeps running">detach</button>
        <button className="reveal" onClick={(e) => { e.stopPropagation(); void copySessionUrl(sid); }} style={miniLinkBtnStyle}>copy</button>
        {paneItem ? (
          <>
            <button onClick={(e) => { e.stopPropagation(); ctx.reloadViewer(sid); }} style={miniLinkBtnStyle} title="reload">⟳</button>
            <a href={viewSrc(paneItem)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={miniLinkBtnStyle} title="open in a browser tab">↗</a>
            <button onClick={(e) => { e.stopPropagation(); ctx.openFull(sid, paneItem.id); }} style={miniLinkBtnStyle} title="fill the workspace">full</button>
          </>
        ) : null}
        <button className="reveal" onClick={(e) => { e.stopPropagation(); onTerminate(); }} style={closeBtnStyle} title="terminate">×</button>
      </span>
    </div>
  );
}
