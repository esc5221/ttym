import { useCallback, useEffect, useRef, useState } from 'react';
import { TerminalMux, Terminal, getHost } from '@ttym/ui';
import { formatCwd } from '@ttym/shared';
import { AGENT_COLORS, AgentState, actionBtnStyle, emptyPaneStyle, miniLinkBtnStyle, stripBtnStyle } from './app-shared.js';
import { KeyBar } from './KeyBar.js';
import { useSwipe } from './useSwipe.js';
import { usePinchZoom } from './usePinchZoom.js';

/**
 * 폰의 workspace 화면. 두 모드로 나뉜다.
 *
 *   list   pane마다 카드 하나. 마지막 몇 줄 + 에이전트 상태. 읽기 전용.
 *   focus  pane 하나가 화면 전체. KeyBar 켜짐. 입력은 여기서만.
 *
 * 나눈 이유는 물리다. 6인치에서 80x24 두 개를 동시에 조작하는 건 안 된다.
 * 동시에 감시하는 건 된다. 그래서 감시와 조작을 다른 화면에 뒀다.
 *
 * 모드마다 스크롤할 물건이 하나뿐이라는 점이 중요하다. 이전의 stacked는
 * 페이지 스크롤 + pane 컨테이너 + xterm 셋이 같은 손가락을 두고 다퉜다.
 */

export interface PhoneWorkspaceProps {
  mux: TerminalMux;
  sessionIds: number[];
  memberNames: Record<number, string>;
  sessionCwds: Record<number, string>;
  agentStates: Record<number, AgentState>;
  deadSessions: Set<number>;
  bells: Set<number>;
  focusedSid: number | null;
  onFocusSid: (sid: number) => void;
  localEchoEnabled: boolean;
  onSearch: (sid: number) => void;
  onExit: (sid: number) => void;
  onBell: (sid: number) => void;
  onSplit: () => void;
  onRestart: (sid: number) => void;
  onDetach: (sid: number) => void;
}

type PhoneView = { mode: 'list' } | { mode: 'focus'; sid: number };

/** 핀치로 폰트를 키울 때 이 행수 밑으로는 못 내려간다. */
const MIN_ROWS = 8;

export function PhoneWorkspace(props: PhoneWorkspaceProps) {
  const { sessionIds, focusedSid } = props;
  const [view, setView] = useState<PhoneView>({ mode: 'list' });

  // 사라진 pane을 보고 있었다면 목록으로 돌아온다
  useEffect(() => {
    if (view.mode === 'focus' && !sessionIds.includes(view.sid)) setView({ mode: 'list' });
  }, [sessionIds.join(','), view]);

  // 안드로이드 뒤로가기와 브라우저 back이 목록으로 나가는 데 쓰이게 한다
  useEffect(() => {
    if (view.mode !== 'focus') return;
    history.pushState({ ttymFocus: true }, '');
    const onPop = () => setView({ mode: 'list' });
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [view.mode === 'focus' ? view.sid : null]);

  const openFocus = useCallback((sid: number) => {
    props.onFocusSid(sid);
    setView({ mode: 'focus', sid });
  }, [props.onFocusSid]);

  if (view.mode === 'focus' && sessionIds.includes(view.sid)) {
    return (
      <FocusView
        {...props}
        sid={view.sid}
        onBack={() => { if (history.state?.ttymFocus) history.back(); else setView({ mode: 'list' }); }}
        onMove={(sid) => { props.onFocusSid(sid); setView({ mode: 'focus', sid }); }}
      />
    );
  }

  return <ListView {...props} onOpen={openFocus} focusedSid={focusedSid} />;
}

// ───── 카드 목록 ─────

function ListView({
  mux, sessionIds, memberNames, sessionCwds, agentStates, deadSessions, bells,
  onOpen, onSplit, onRestart, onDetach,
}: PhoneWorkspaceProps & { onOpen: (sid: number) => void }) {
  if (sessionIds.length === 0) {
    return (
      <div style={emptyPaneStyle}>
        <button onClick={onSplit} style={actionBtnStyle}>start terminal</button>
      </div>
    );
  }

  return (
    <div style={{
      height: '100%', overflowY: 'auto', WebkitOverflowScrolling: 'touch',
      overscrollBehavior: 'contain',
      padding: '6px 6px calc(12px + env(safe-area-inset-bottom))',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      {sessionIds.map((sid) => {
        const dead = deadSessions.has(sid);
        const agent = agentStates[sid];
        const color = agent?.kind ? AGENT_COLORS[agent.kind] : undefined;
        const cwd = sessionCwds[sid];
        return (
          <div
            key={sid}
            onClick={() => !dead && onOpen(sid)}
            style={{
              borderRadius: 4, overflow: 'hidden',
              border: dead ? '1px solid var(--err)' : '1px solid var(--line)',
              background: 'var(--bg1)',
              // 세션이 적으면 카드가 남는 세로를 나눠 갖고, 많아지면 minHeight에
              // 물려 스크롤로 넘어간다. 높이를 못박아 두면 3개짜리 workspace에서
              // 화면 3분의 1이 그냥 빈다(411x891에서 299px을 실측).
              display: 'flex', flexDirection: 'column',
              ...(dead ? { flex: '0 0 auto' } : { flex: '1 1 0', minHeight: 132 }),
            }}
          >
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px', height: 30,
              borderBottom: '1px solid var(--line)', minWidth: 0,
            }}>
              {color ? (
                <span
                  className={agent?.active ? 'agent-dot-run' : undefined}
                  style={{ width: 5, height: 5, borderRadius: '50%', background: color, opacity: agent?.active ? 1 : 0.4, flexShrink: 0 }}
                />
              ) : null}
              <span style={{ color: color ?? 'var(--text)', fontSize: 11, fontFamily: 'var(--mono)', fontWeight: 700, flexShrink: 0 }}>
                {memberNames[sid] || `#${sid}`}
              </span>
              {bells.has(sid) ? (
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--warn)', boxShadow: '0 0 6px var(--warn)', flexShrink: 0 }} />
              ) : null}
              {cwd ? (
                <span style={{
                  color: 'var(--cwd)', fontSize: 10, fontFamily: 'var(--mono)', minWidth: 0,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{formatCwd(cwd)}</span>
              ) : null}
              {dead ? (
                <span style={{ marginLeft: 'auto', color: 'var(--err)', fontSize: 10, fontFamily: 'var(--mono)', flexShrink: 0 }}>ended</span>
              ) : null}
            </div>

            {dead ? (
              <div style={{ display: 'flex', gap: 8, padding: 12 }}>
                <button onClick={(e) => { e.stopPropagation(); onRestart(sid); }} style={actionBtnStyle}>restart</button>
                <button onClick={(e) => { e.stopPropagation(); onDetach(sid); }} style={{ ...actionBtnStyle, background: 'var(--line)', color: 'var(--text-soft)' }}>close</button>
              </div>
            ) : (
              // 카드는 훑어보는 자리다. 입력도, GPU도 여기 쓸 이유가 없다.
              //
              // 아래에 붙이는 게 핵심이다. follow는 서버 행 수만큼 자연 높이를
              // 갖는데(40행이면 폰트10에 520px쯤), 위 정렬로 자르면 한참 전에
              // 지나간 화면이 박제된다. 카드가 답해야 할 질문은 "지금 뭐 하는
              // 중인가"라서 아래를 보여준다.
              // 배경을 xterm과 같은 면으로 맞춘다. follow는 서버 cols만큼만 넓어서
              // 카드보다 좁게 끝나는데, 카드 면(bg1)이 그대로 드러나면 터미널이
              // 반쪽만 그려진 것처럼 보인다.
              <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', pointerEvents: 'none', position: 'relative', background: 'var(--bg0)' }}>
                {/* bottom에 못박아 위로 자라게 한다. Terminal 루트가 height:100%라
                    flex로는 밀리지 않는다 — 이미 컨테이너를 꽉 채우고 있어서. */}
                <Terminal
                  mux={mux} attachId={sid} mode="readonly" fontSize={10}
                  enableWebgl={false} geometry="follow"
                  style={{ position: 'absolute', left: 6, bottom: 4, width: 'auto', height: 'auto' }}
                />
              </div>
            )}
          </div>
        );
      })}
      {/* 데스크톱 탭 스트립의 + split 과 같은 물건이다. 폰에선 스트립이 좁아
          목록 끝으로 내려왔을 뿐, 문법까지 바꿀 이유는 없다. */}
      <button onClick={onSplit} style={{ ...stripBtnStyle, alignSelf: 'flex-start', marginTop: 2 }}>+ split</button>
    </div>
  );
}

// ───── 전체화면 ─────

function FocusView({
  mux, sid, sessionIds, memberNames, sessionCwds, agentStates, deadSessions,
  localEchoEnabled, onSearch, onExit, onBell, onBack, onMove, onRestart, onDetach,
}: PhoneWorkspaceProps & { sid: number; onBack: () => void; onMove: (sid: number) => void }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const at = sessionIds.indexOf(sid);
  const prev = at > 0 ? sessionIds[at - 1] : undefined;
  const next = at < sessionIds.length - 1 ? sessionIds[at + 1] : undefined;
  const [fontSize, setFontSize] = useState(14);

  // 가로만 우리가 잡는다. 세로 scrollback은 xterm이 이미 한다 —
  // touch-action:none 으로 브라우저를 물린 뒤에야 살아났다(pan-y일 때는 브라우저가
  // "세로 팬은 내 몫"이라 여겨 죽어 있었다). 우리가 같이 처리하면 한 번의 스와이프에
  // 스크롤이 두 번 걸린다(-16행 요청에 280행 이동을 실측).
  // 왼쪽으로 밀면 다음 pane으로, 책장 넘기는 방향과 같다.
  const scrollAnchor = useRef(0);
  useSwipe(bodyRef, {
    onLeft: () => { if (next !== undefined) onMove(next); },
    onRight: () => { if (prev !== undefined) onMove(prev); },
    onScrollStart: () => { scrollAnchor.current = getHost(sid)?.term.buffer.active.viewportY ?? 0; },
    // 실제로 움직였는지 돌려준다. 맨 위·맨 아래에 닿으면 false가 되고,
    // 그때 관성이 선다 — 안 그러면 경계에서 rAF가 계속 헛돈다.
    onScrollTo: (delta) => {
      const h = getHost(sid);
      if (!h) return false;
      const before = h.term.buffer.active.viewportY;
      h.term.scrollToLine(Math.max(0, scrollAnchor.current + delta));
      return h.term.buffer.active.viewportY !== before;
    },
    lineHeight: fontSize * 1.08,
  });

  // 핀치로 폰트. 8~28로 물리고, 키울 때는 최소 행수도 지킨다 — borrow는 폰트가
  // 커진 만큼 행을 줄이므로 그냥 두면 터미널이 두세 줄만 남는다. 행높이는 폰트의
  // 1.08배로 잡았다(폰트 14에서 15.1px 실측).
  usePinchZoom(bodyRef, (delta) => {
    setFontSize((v) => {
      const next = Math.min(28, Math.max(8, v + delta));
      if (delta > 0) {
        const h = bodyRef.current?.clientHeight ?? 0;
        if (h > 0 && h / (next * 1.08) < MIN_ROWS) return v;
      }
      return next;
    });
  });

  const dead = deadSessions.has(sid);
  const agent = agentStates[sid];
  const color = agent?.kind ? AGENT_COLORS[agent.kind] : undefined;
  const cwd = sessionCwds[sid];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px', height: 30,
        flexShrink: 0, borderBottom: '1px solid var(--line)', background: 'var(--bg1)',
      }}>
        <button onClick={onBack} style={{ ...miniLinkBtnStyle, padding: '1px 5px 1px 0' }}>‹ list</button>
        {color ? (
          <span
            className={agent?.active ? 'agent-dot-run' : undefined}
            style={{ width: 5, height: 5, borderRadius: '50%', background: color, opacity: agent?.active ? 1 : 0.4, flexShrink: 0 }}
          />
        ) : null}
        <span style={{ color: color ?? 'var(--text)', fontSize: 11, fontFamily: 'var(--mono)', fontWeight: 700, flexShrink: 0 }}>
          {memberNames[sid] || `#${sid}`}
        </span>
        {cwd ? (
          <span style={{
            color: 'var(--cwd)', fontSize: 10, fontFamily: 'var(--mono)', minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{formatCwd(cwd)}</span>
        ) : null}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <button onClick={() => prev !== undefined && onMove(prev)} disabled={prev === undefined} style={{ ...miniLinkBtnStyle, fontSize: 11, opacity: prev === undefined ? 0.3 : 1 }}>‹</button>
          <span style={{ color: 'var(--text-dim)', fontSize: 10, fontFamily: 'var(--mono)' }}>{at + 1}/{sessionIds.length}</span>
          <button onClick={() => next !== undefined && onMove(next)} disabled={next === undefined} style={{ ...miniLinkBtnStyle, fontSize: 11, opacity: next === undefined ? 0.3 : 1 }}>›</button>
        </span>
      </div>

      {/* 스크롤할 물건은 여기 하나도 없다. 아래 Terminal이 borrow로 이 상자에
          꼭 맞게 PTY를 빌리므로, 넘칠 것이 없어 컨테이너 스크롤이 생기지 않는다.
          세로로 훑으면 xterm scrollback 하나만 움직인다.

          KeyBar(4+30+4)와 홈 인디케이터만큼은 패딩으로 비운다 — fixed라 flex
          계산에 안 들어가고, borrow는 이 패딩을 뺀 content box를 기준으로
          빌리므로 마지막 줄이 키바 뒤로 숨지 않는다. */}
      <div
        ref={bodyRef}
        style={{
          flex: 1, minHeight: 0, background: 'var(--bg0)', overflow: 'hidden',
          paddingBottom: dead ? 0 : 'calc(38px + env(safe-area-inset-bottom))',
          // none 이어야 xterm이 터치를 온전히 받는다. 루트의 pan-y를 물려받으면
          // 브라우저가 "세로 팬은 내 몫"이라 여겨 xterm의 scrollback 스크롤이 죽는다
          // (실측: viewportY가 baseY에서 한 칸도 안 움직였다). 여기는 스크롤할
          // 컨테이너가 없으니 브라우저에게 넘길 것도 없다.
          touchAction: 'none',
        }}
      >
        {dead ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12 }}>
            <span style={{ color: 'var(--err)', fontSize: 11, fontFamily: 'var(--mono)' }}>session ended</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => onRestart(sid)} style={actionBtnStyle}>restart</button>
              <button onClick={() => onDetach(sid)} style={{ ...actionBtnStyle, background: 'var(--line)', color: 'var(--text-soft)' }}>close</button>
            </div>
          </div>
        ) : (
          // borrow: 폰 크기로 PTY를 빌려 쓰고, 목록으로 나가면 서버가 이전 기하를
          // 되돌린다. follow로 두면 터미널이 서버 기하 그대로(실측 909px) 그려져
          // 화면(341px)을 넘치고, 그 컨테이너 스크롤이 xterm scrollback과 겹쳐
          // 손가락 하나에 스크롤이 두 번 걸린다. 빌려 쓰면 넘칠 것이 없다.
          <Terminal
            mux={mux}
            attachId={sid}
            fontSize={fontSize}
            geometry="borrow"
            enableWebgl={false}
            localEcho={localEchoEnabled}
            onExit={() => onExit(sid)}
            onBell={() => onBell(sid)}
          />
        )}
      </div>

      {!dead ? <KeyBar sid={sid} onSearch={() => onSearch(sid)} /> : null}
    </div>
  );
}

// ───── 스타일 ─────

/** 카드를 탭했을 때 터미널이 바로 반응하도록 포커스를 넘긴다. */
export function focusPaneTerminal(sid: number) {
  getHost(sid)?.focusTerminal();
}
