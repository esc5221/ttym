import { Terminal } from '@ttym/ui';
import { formatCwd } from '@ttym/shared';
import { AGENT_COLORS, actionBtnStyle } from '../app-shared.js';
import { useWorkspaceSessions } from './session-context.js';
import { ROSTER_LABEL, rosterState } from './roster-state.js';

/**
 * pane 하나를 훑어보는 카드: 헤더 한 줄(이름·cwd) + 마지막 몇 줄. 읽기 전용이다.
 *
 * 폰의 카드 목록과 데스크톱의 목록 모드가 같이 쓴다. 두 곳이 갈라지는 지점만 variant로 둔다:
 *   phone   남는 세로를 카드가 나눠 갖는다(카드가 적을 때 화면이 비지 않게).
 *   roster  높이 고정. 상태 칩이 붙고, 고른 카드는 강조된다.
 */
export function PaneCard({ sid, name, cwd, onOpen, variant, selected = false, hostedElsewhere = false }: {
  sid: number;
  name?: string;
  cwd?: string;
  onOpen: (sid: number) => void;
  variant: 'phone' | 'roster';
  selected?: boolean;
  /** 이 세션의 터미널 호스트가 다른 곳(오른쪽 집중 pane, zen)에 가 있다. 호스트는 세션마다 하나라 여기서 또 붙이면 안 된다. */
  hostedElsewhere?: boolean;
}) {
  const { mux, agentStates, deadSessions, bells, restartAt, detachMember, viewer } = useWorkspaceSessions();
  const dead = deadSessions.has(sid);
  const agent = agentStates[sid];
  const color = agent?.kind ? AGENT_COLORS[agent.kind] : undefined;
  const roster = variant === 'roster';
  const state = rosterState(agent, dead);
  const needs = state === 'needs';

  return (
    <div
      data-roster-sid={roster ? sid : undefined}
      onClick={() => !dead && onOpen(sid)}
      style={{
        borderRadius: 4, overflow: 'hidden',
        // border 단축 속성에 borderColor를 덧씌우면 React가 갱신 때 단축 쪽을 지워서, 선택이 옮겨 간 뒤에도 옛 카드에 테두리 잔상이 남는다.
        border: `1px solid ${selected && !dead ? 'var(--accent)' : dead ? 'var(--err)' : needs && roster ? 'var(--warn)' : 'var(--line)'}`,
        ...(selected && !dead ? { boxShadow: '0 0 0 1px var(--accent) inset' } : null),
        background: 'var(--bg1)',
        cursor: dead ? 'default' : 'pointer',
        // 폰: 세션이 적으면 카드가 남는 세로를 나눠 갖고, 많아지면 minHeight에 물려 스크롤로 넘어간다.
        // 높이를 못박아 두면 3개짜리 workspace에서 화면 3분의 1이 그냥 빈다(411x891에서 299px을 실측).
        display: 'flex', flexDirection: 'column',
        ...(roster
          ? { flex: '0 0 auto', ...(state === 'ended' ? { opacity: 0.62 } : null) }
          : dead ? { flex: '0 0 auto' } : { flex: '1 1 0', minHeight: 132 }),
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
          {name || `%${sid}`}
        </span>
        {(viewer.states[sid]?.items.length ?? 0) > 0 ? (
          // 이 pane에 `ttym open`으로 열린 파일이 있다 — 열면 탭 줄에 선다.
          <span title="open files" style={{ color: 'var(--text-dim)', fontSize: 10, fontFamily: 'var(--mono)', flexShrink: 0 }}>
            ▤ {viewer.states[sid]!.items.length}
          </span>
        ) : null}
        {bells.has(sid) ? (
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--warn)', boxShadow: '0 0 6px var(--warn)', flexShrink: 0 }} />
        ) : null}
        {cwd ? (
          <span style={{
            color: 'var(--cwd)', fontSize: 10, fontFamily: 'var(--mono)', minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{formatCwd(cwd)}</span>
        ) : null}
        {roster ? (
          <span style={{
            marginLeft: 'auto', flexShrink: 0, fontSize: 10, fontFamily: 'var(--mono)', padding: '0 6px', borderRadius: 8,
            border: '1px solid var(--line)', color: 'var(--text-soft)',
            ...(needs ? { background: 'var(--warn)', borderColor: 'var(--warn)', color: '#1e1e1e', fontWeight: 700 } : null),
            ...(state === 'working' ? { color: 'var(--ok)', borderColor: 'var(--ok)' } : null),
            ...(state === 'ended' ? { color: 'var(--err)', borderColor: 'var(--err)' } : null),
          }}>
            {needs ? `needs you · ${agent?.waiting}` : ROSTER_LABEL[state]}
          </span>
        ) : dead ? (
          <span style={{ marginLeft: 'auto', color: 'var(--err)', fontSize: 10, fontFamily: 'var(--mono)', flexShrink: 0 }}>ended</span>
        ) : null}
      </div>

      {dead ? (
        <div style={{ display: 'flex', gap: 8, padding: 12 }}>
          <button onClick={(e) => { e.stopPropagation(); void restartAt(sid); }} style={actionBtnStyle}>restart</button>
          <button onClick={(e) => { e.stopPropagation(); void detachMember(sid); }} style={{ ...actionBtnStyle, background: 'var(--line)', color: 'var(--text-soft)' }}>close</button>
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
        <div style={{
          flex: roster ? '0 0 auto' : 1, minHeight: 0, overflow: 'hidden', pointerEvents: 'none', position: 'relative', background: 'var(--bg0)',
          ...(roster ? { height: 46 } : null),
        }}>
          {hostedElsewhere ? (
            <div style={{ padding: '6px 10px', color: 'var(--text-dim)', fontSize: 10, fontFamily: 'var(--mono)' }}>
              ▸ 오른쪽에서 보는 중
            </div>
          ) : (
            // bottom에 못박아 위로 자라게 한다. Terminal 루트가 height:100%라
            // flex로는 밀리지 않는다 — 이미 컨테이너를 꽉 채우고 있어서.
            <Terminal
              mux={mux} attachId={sid} mode="readonly" fontSize={10}
              enableWebgl={false} geometry="follow"
              style={{ position: 'absolute', left: 6, bottom: 4, width: 'auto', height: 'auto' }}
            />
          )}
        </div>
      )}
    </div>
  );
}
