import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatCwd } from '@ttym/shared';
import { beginDragGuard, getHost } from '@ttym/ui';
import { readZenFontDelta, writeZenFontDelta, readZenCols, writeZenCols, readZenReader, writeZenReader, readZenReaderDock, writeZenReaderDock, READER_COLUMN_PX, ZEN_DEFAULT_COLS, ZEN_COLS_MIN, ZEN_COLS_MAX, miniLinkBtnStyle, type AgentState } from '../app-shared.js';
import { SessionBody } from './SessionBody.js';
import { type DockMode } from '../reader/ReaderView.js';
import { WorkspaceReader } from './WorkspaceReader.js';
import { useReader } from '../reader/useReader.js';

/** zen 읽기 모드 — 크롬을 전부 걷고 한 pane만 고정 폭으로 크게 읽는다.
 *
 *  들판 위에 글자만 남는다. 터미널 배경(--term-bg)과 앱 배경(--bg0)이 같은 값이라
 *  테두리를 안 그리면 경계가 아예 없다.
 *
 *  cols를 못박는 이유: 지금 살아있는 세션이 86~314 cols로 흩어져 있다. 폭을
 *  안 정하면 314짜리는 키울수록 못 읽는다. borrow로 빌리므로 나갈 때, 탭을 닫을
 *  때, 창이 죽을 때 서버가 이전 기하로 되돌린다(session.ts releaseBorrow).
 *
 *  바가 absolute인 것이 핵심이다. 흐름에 두면 마우스를 위로 올릴 때마다 컨테이너
 *  높이가 줄고 → rows가 바뀌고 → PTY가 리플로우된다. 읽는 중에 화면이 다시
 *  그려지는 최악의 경우다. */
export function ZenView({ sid, name, cwd, fontFamily, baseFontSize, agent, onExit, side, sideOpen, onToggleSide }: {
  sid: number;
  name?: string;
  cwd?: string;
  fontFamily: string;
  /** pane의 글자 크기. zen은 여기에 기억된 차이만 더한다 — 기본은 같은 크기. */
  baseFontSize: number;
  /** 이 세션의 에이전트 상태. reader 모드가 "작업 중"·"권한 대기"를 여기서 읽는다. */
  agent?: AgentState;
  /** ⌘. · exit 버튼 · 세션이 끝났을 때. */
  onExit: () => void;
  /** 이 세션의 뷰어. 있으면 바에 토글이 생기고, 열면 터미널 오른쪽에 나란히 선다. */
  side?: React.ReactNode;
  sideOpen?: boolean;
  onToggleSide?: () => void;
}) {
  const [delta, setDelta] = useState(() => readZenFontDelta());
  // 폭은 이 기기의 것(localStorage). ◂ ▸ 한 번에 10칸, 숫자 클릭은 기본으로.
  const [cols, setCols] = useState(() => readZenCols());
  const widen = (by: number) => setCols((c) => Math.min(ZEN_COLS_MAX, Math.max(ZEN_COLS_MIN, c + by)));
  const fontSize = Math.min(32, Math.max(9, baseFontSize + delta));
  // 좌우 비율은 이 브라우저의 것. 터미널은 cols가 고정이라 왼쪽이 좁아지면 잘린다 —
  // 그래서 기본을 터미널 쪽에 넉넉히 준다.
  const [sideRatio, setSideRatio] = useState(() => { try { const v = Number(window.localStorage.getItem('ttym-zen-side-ratio')); return v > 0 && v < 1 ? v : 0.55; } catch { return 0.55; } });
  const startSideDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const container = (e.currentTarget as HTMLElement).parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const el = e.currentTarget;
    el.classList.add('drag');
    // 옆 패널이 iframe이면 포인터가 그 위로 가는 순간 move가 끊긴다.
    beginDragGuard('col-resize');
    let last = sideRatio;
    const move = (ev: PointerEvent) => { last = Math.min(0.85, Math.max(0.15, (ev.clientX - rect.left) / rect.width)); setSideRatio(last); };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      el.classList.remove('drag');
      try { window.localStorage.setItem('ttym-zen-side-ratio', String(last)); } catch {}
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const split = !!side && !!sideOpen;
  // reader: 같은 세션의 대화를 읽기 좋게 터미널 위에 덮는다. 터미널은 그대로 떠 있고 아래 몇 줄(입력창·권한 창)만 비친다.
  // 옆 뷰어와 나란히 설 때는 폭이 모자라 끈다.
  const [readerPref, setReaderPref] = useState(() => readZenReader());
  const readerOn = readerPref && !split;
  const [dockMode, setDockMode] = useState<DockMode>(() => readZenReaderDock());
  const pickDock = (m: DockMode) => { setDockMode(m); writeZenReaderDock(m); };
  const stageRef = useRef<HTMLDivElement>(null);
  const { transcript, dock, working } = useReader(sid, agent, stageRef, readerOn);
  // 본문 폭을 px로 맞춘다. 첫 측정 전에는 글자 폭을 글자 크기의 0.6배로 어림한다 — 기존 cols(140)로 먼저 붙었다가 줄이면
  // 140칸으로 그려진 화면이 접혀서(reflow) 에이전트가 다시 그릴 때까지 입력창 줄이 깨진다.
  const fixedCols = split ? undefined : readerOn ? Math.max(ZEN_COLS_MIN, Math.floor(READER_COLUMN_PX / (dock?.cellW ?? fontSize * 0.6))) : cols;
  const setReader = (on: boolean) => { setReaderPref(on); writeZenReader(on); };
  useEffect(() => {
    if (!readerOn) return;
    const host = getHost(sid);
    host?.term.scrollToBottom();
    host?.focusTerminal();
  }, [readerOn, sid]);
  // 들어올 때 한 번은 보여준다 — 안 보여주면 나가는 법을 알 도리가 없다.
  const [hintOpen, setHintOpen] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setHintOpen(false), 2200);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => writeZenFontDelta(delta), 300);
    return () => clearTimeout(timer);
  }, [delta]);
  useEffect(() => {
    const timer = setTimeout(() => writeZenCols(cols), 300);
    return () => clearTimeout(timer);
  }, [cols]);

  const bump = (by: number) => setDelta((d) => Math.min(20, Math.max(-20, d + by)));

  return createPortal(
    <div style={zenOverlayStyle}>
      {/* 상단 44px만 바를 깨운다. 본문 위에서 마우스를 움직여도 안 뜬다 —
          읽는 중에 크롬이 번쩍이지 않게. */}
      {/* 나란히 볼 때는 바를 숨기지 않는다 — 흐름에 두면 높이가 고정이라 rows도 안 흔들린다. */}
      <div className="zen-top" style={split ? { flexShrink: 0 } : zenTopZoneStyle}>
        <div className={`zen-bar${hintOpen || split ? ' zen-bar-show' : ''}`} style={zenBarStyle}>
          <span style={{ color: 'var(--text)', fontWeight: 700 }}>{name || `%${sid}`}</span>
          {cwd ? <span style={{ color: 'var(--cwd)', fontSize: 11 }}>{formatCwd(cwd)}</span> : null}
          {split ? null : (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              {(['terminal', 'reader'] as const).map((m) => {
                const on = (m === 'reader') === readerOn;
                return <button key={m} onClick={() => setReader(m === 'reader')} style={{ ...miniLinkBtnStyle, ...(on ? { color: 'var(--accent)' } : null) }} title={m === 'reader' ? 'conversation, laid out to read' : 'the raw terminal'}>{m}</button>;
              })}
            </span>
          )}
          {readerOn ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              {(['native', 'styled'] as const).map((m) => (
                <button key={m} onClick={() => pickDock(m)} style={{ ...miniLinkBtnStyle, ...(dockMode === m ? { color: 'var(--accent)' } : null) }} title={m === 'native' ? 'bottom input area: the terminal’s own rows' : 'bottom input area: redrawn in the page’s style'}>{m}</button>
              ))}
            </span>
          ) : null}
          {split || readerOn ? null : (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <button onClick={() => widen(-10)} style={miniLinkBtnStyle} title="narrower (10 cols)">◂</button>
              <span onClick={() => setCols(ZEN_DEFAULT_COLS)} style={{ color: cols === ZEN_DEFAULT_COLS ? 'var(--text-dim)' : 'var(--warn)', fontSize: 11, cursor: cols === ZEN_DEFAULT_COLS ? 'default' : 'pointer' }} title={cols === ZEN_DEFAULT_COLS ? 'default width' : `click: back to ${ZEN_DEFAULT_COLS}`}>{cols} cols</span>
              <button onClick={() => widen(10)} style={miniLinkBtnStyle} title="wider (10 cols)">▸</button>
            </span>
          )}
          <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <button onClick={() => bump(-1)} style={miniLinkBtnStyle} title="smaller">A−</button>
            <span onClick={() => setDelta(0)} style={{ color: delta === 0 ? 'var(--text-dim)' : 'var(--warn)', fontSize: 11, minWidth: 18, textAlign: 'center', cursor: delta === 0 ? 'default' : 'pointer' }} title={delta === 0 ? 'same as the pane' : 'click: back to the pane size'}>{fontSize}</span>
            <button onClick={() => bump(1)} style={miniLinkBtnStyle} title="larger">A+</button>
            {side ? (
              <button onClick={onToggleSide} style={{ ...miniLinkBtnStyle, marginLeft: 8, ...(sideOpen ? { color: 'var(--accent)' } : null) }} title="viewer beside the terminal">
                {sideOpen ? 'viewer ▸' : '◂ viewer'}
              </button>
            ) : null}
            <button onClick={onExit} style={{ ...miniLinkBtnStyle, marginLeft: 8 }} title="exit zen · ⌘.">⌘. exit</button>
          </span>
        </div>
      </div>
      <div ref={stageRef} style={split ? { ...zenStageStyle, justifyContent: 'stretch', padding: '6px 0 0' } : zenStageStyle}>
        <div style={split ? { flex: `0 0 ${sideRatio * 100}%`, minWidth: 0, display: 'flex', overflow: 'hidden', padding: '0 6px' } : { display: 'contents' }}>
          {/* 뷰어는 옆에 따로 선다(side) — 본문에 덮지 않는다. 알약·검색·경로 open은 grid와 같다. */}
          <SessionBody
            sid={sid}
            viewerOverlay={false}
            onExit={onExit}
            terminal={{
              fontSize,
              fontFamily,
              geometry: 'borrow',
              // 나란히 볼 때는 고정 cols 대신 왼쪽 영역에 맞춘다 — splitter를 끌면 PTY도 따라온다.
              // borrow는 그대로라 zen을 나가면 서버가 이전 기하를 되돌린다.
              fixedCols,
              enableWebgl: true,
              // 100% 폭이면 wrapper(max-content)가 그 안 왼쪽에 붙어 가운데 정렬이 안 먹는다.
              style: split ? { width: '100%', height: '100%' } : { width: 'max-content', height: '100%' },
            }}
            wrapStyle={split ? { display: 'flex' } : { display: 'flex', justifyContent: 'center' }}
          />
        </div>
        {readerOn ? <WorkspaceReader sid={sid} state={transcript.state} error={transcript.error} working={working} layout={dock} dockMode={dockMode} flow fontSize={fontSize} onLoadEarlier={transcript.loadEarlier} loadingEarlier={transcript.loadingEarlier} /> : null}
        {split ? (
          <>
            <div className="viewer-splitter col" onPointerDown={startSideDrag} title="drag to resize" />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', borderLeft: '1px solid var(--line)' }}>{side}</div>
          </>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

const zenOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 60,
  background: 'var(--bg0)',
  display: 'flex',
  flexDirection: 'column',
};

/** 바(여백 5 + 높이 34 = 39px)보다 커야 한다. 34였을 때는 바 아래 5px에 마우스를
 *  두면 바가 도로 꺼졌다. absolute라 행을 잡아먹지 않으니 넉넉히. */
const zenTopZoneStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0, left: 0, right: 0,
  height: 48,
  zIndex: 1,
};

const zenBarStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  height: 34,
  padding: '0 14px',
  margin: '5px 6px 0',
  borderRadius: 7,
  background: 'var(--bg1)',
  border: '1px solid var(--line)',
  fontFamily: 'var(--mono)',
  fontSize: 12,
};

/** 스크롤은 xterm 자기 것 하나뿐이다 — 바깥 스크롤러를 두면 한 번의 휠에 두 번 움직인다.
 *
 *  여백은 글자가 화면 끝에 붙지 않을 만큼만. 이 높이가 그대로 rows라, 여백 1px이
 *  읽을 줄 수에서 빠져나간다. 바를 피하려고 위를 44px 비워뒀더니 900px 화면에서
 *  3줄을 그냥 버리고 있었다 — 바는 absolute라 자리를 안 차지하므로, 뜰 때 첫 줄을
 *  잠깐 덮는 편이 늘 비워두는 것보다 낫다. */
const zenStageStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  justifyContent: 'center',
  padding: '6px 0',
  overflow: 'hidden',
  // reader 덮개의 기준이자, 바(zIndex 1)보다 아래로 가두는 쌓임 맥락.
  position: 'relative',
  zIndex: 0,
};
