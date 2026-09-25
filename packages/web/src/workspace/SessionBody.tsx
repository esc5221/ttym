import { forwardRef } from 'react';
import { Terminal, beginDragGuard, getHost } from '@ttym/ui';
import { actionBtnStyle, emptyPaneStyle, miniLinkBtnStyle, uploadDroppedFiles } from '../app-shared.js';
import { SelectionOpen } from '../viewer/SelectionOpen.js';
import { ViewerPanel } from '../viewer/ViewerPanel.js';
import { ageText, sleepTitle } from './sleep-text.js';
import { paneView, useWorkspaceSessions } from './session-context.js';

export interface SessionBodyProps {
  sid: number;
  /** 화면마다 다른 것은 터미널을 어떻게 앉히느냐뿐이다. */
  terminal: {
    fontSize: number;
    fontFamily?: string;
    geometry: 'fit' | 'follow' | 'borrow';
    fixedCols?: number;
    enableWebgl: boolean;
    style?: React.CSSProperties;
  };
  /** 앞에 선 뷰어 탭을 터미널 위에 덮는다. zen은 뷰어를 옆에 따로 세우므로 끈다. */
  viewerOverlay: boolean;
  /** 폰: `--full` 탭도 제자리에서 보여준다 (paneView 참고). */
  showFullInPlace?: boolean;
  /** 터미널을 감싼 상자의 추가 스타일 — 패딩, zen의 가운데 정렬, 폰의 키바 여백. */
  wrapStyle?: React.CSSProperties;
  style?: React.CSSProperties;
  /** 세션이 끝났을 때 화면이 따로 할 일 (zen은 빠져나간다). 죽음 표시는 여기서 한다. */
  onExit?: () => void;
}

/**
 * 세션 하나의 본문 — 터미널과 그 위에 덮이는 것들.
 *
 * 검색창, 경로를 선택하면 뜨는 open 버튼, 끝난 세션의 restart, sleep 알약, 뷰어 탭,
 * 파일 드롭. grid·zen·폰이 전부 이것을 쓴다. 화면이 갖는 것은 테두리(헤더·탭 줄·
 * 제스처·키바)뿐이다.
 */
export const SessionBody = forwardRef<HTMLDivElement, SessionBodyProps>(function SessionBody(
  { sid, terminal, viewerOverlay, showFullInPlace = false, wrapStyle, style, onExit },
  ref,
) {
  const ctx = useWorkspaceSessions();
  const { search, setSearch, selOpen, setSelOpen, viewer, sleepNote } = ctx;
  const dead = ctx.deadSessions.has(sid);
  const agent = ctx.agentStates[sid];
  const sleep = agent?.sleep ?? null;
  const asleep = sleep?.state === 'sleeping' || sleep?.state === 'waking';
  const view = paneView(ctx, sid, showFullInPlace);
  const covered = viewerOverlay && view.item !== null;

  return (
    <div
      ref={ref}
      onMouseDown={(e) => {
        ctx.focusSid(sid);
        if (covered || e.button !== 0) return;
        // 선택은 pane 밖에서 끝날 수 있다 — 옆 패널 위에서 놓으면 mouseup이 그쪽으로 간다.
        // 그래서 mouseup은 window에서 받고, 그 사이 iframe이 포인터를 못 가져가게 막는다.
        const pane = e.currentTarget;
        beginDragGuard();
        const up = (ev: MouseEvent) => {
          window.removeEventListener('mouseup', up, true);
          if (ev.button === 0) ctx.offerSelection(sid, pane, ev.clientX, ev.clientY);
        };
        window.addEventListener('mouseup', up, true);
      }}
      onDragOver={(e) => {
        // 파일 드래그만 받는다 — 헤더의 pane 교환 드래그는 Files 타입이 없다.
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        ctx.setFileDropSid(sid);
      }}
      onDragLeave={() => ctx.setFileDropSid((cur) => (cur === sid ? null : cur))}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        ctx.setFileDropSid(null);
        const files = Array.from(e.dataTransfer.files);
        void uploadDroppedFiles(files)
          .then((paths) => ctx.insertPathsIntoPane(sid, paths))
          .catch(() => {});
      }}
      style={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative', display: 'flex', flexDirection: 'column', ...style }}
    >
      {search?.sid === sid ? (
        <div style={{
          position: 'absolute', top: 4, right: 10, zIndex: 11,
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
      {/* isolation: xterm 6의 스크롤바는 보일 때 z-index 11이 된다(vscode scrollable-element).
          터미널을 자기 스태킹 컨텍스트에 가두지 않으면, 뷰어가 앞에 있어도 출력이 흐를 때마다
          터미널 스크롤바가 뷰어(z 10) 위로 떠오른다 — elementsFromPoint로 실측. */}
      <div className={asleep ? 'pane-asleep' : undefined} style={{ flex: 1, minHeight: 0, isolation: 'isolate', ...wrapStyle }}>
        {!dead ? (
          <Terminal
            mux={ctx.mux}
            attachId={sid}
            fontSize={terminal.fontSize}
            fontFamily={terminal.fontFamily}
            geometry={terminal.geometry}
            fixedCols={terminal.fixedCols}
            enableWebgl={terminal.enableWebgl}
            localEcho={ctx.localEchoEnabled}
            style={terminal.style}
            onExit={() => { ctx.markDead(sid); onExit?.(); }}
            onBell={() => ctx.ringBell(sid)}
          />
        ) : (
          <div style={emptyPaneStyle}>
            <span style={{ color: 'var(--err)', fontSize: 11 }}>session ended</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => void ctx.restartAt(sid)} style={actionBtnStyle}>restart</button>
              <button onClick={() => void ctx.detachMember(sid)} style={{ ...actionBtnStyle, background: 'var(--line)', color: 'var(--text-soft)' }}>close</button>
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
          onClick={(e) => { e.stopPropagation(); if (sleep?.state === 'sleeping') void ctx.wakeAgent(sid); }}
          title={sleep ? sleepTitle(sleep) : undefined}
        >
          {sleepNote?.sid === sid && !sleep ? <span>{sleepNote.text}</span>
            : sleep!.state === 'sleeping' ? <><span className="mark">☾</span><span>sleeping · {ageText(sleep!.since)} · type or click to wake</span></>
            : sleep!.state === 'waking' ? <><span className="mark spin">◌</span><span>waking…{sleep!.queued ? ` ${sleep!.queued} B queued` : ''}</span></>
            : <><span className="mark">✕</span><span>resume failed: {sleep!.error ?? 'unknown'}</span><button onClick={(e) => { e.stopPropagation(); ctx.restoreAgent(sid); }} style={miniLinkBtnStyle}>restore</button></>}
        </div>
      ) : null}
      {/* 뷰어 탭은 터미널 위에 덮는다. 터미널을 떼거나 숨기면 PTY 크기가 흔들리고 돌아올 때
          다시 fit해야 한다 — 그대로 깔아두면 탭을 되돌리는 순간 그 화면이다.
          z-index: xterm의 레이어(link·decoration)가 자기 z-index를 갖고 있어, 없으면
          오버레이가 그 밑으로 들어가 휠·클릭을 터미널이 먹는다(elementFromPoint로 실측).
          touchAction: 폰 본문은 xterm 때문에 none이다. 문서는 브라우저가 스크롤해야 한다. */}
      {covered && view.state ? (
        <div style={{ position: 'absolute', inset: 0, zIndex: 10, display: 'flex', background: 'var(--bg0)', touchAction: 'auto' }}>
          <ViewerPanel
            sid={sid}
            state={view.state}
            activeId={view.item!.id}
            chrome="none"
            reloadKey={ctx.viewerReload[sid] ?? 0}
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
  );
});
