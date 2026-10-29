import { useMemo, useRef, useState, type ReactNode } from 'react';
import { emptyPaneStyle, actionBtnStyle } from '../app-shared.js';
import { PaneCard } from './PaneCard.js';
import { useWorkspaceSessions } from './session-context.js';
import { ROSTER_ENDED_STORAGE_KEY, rosterState, sortRoster } from './roster-state.js';

/**
 * 데스크톱의 목록 모드. 왼쪽에 멤버 카드, 오른쪽에 고른 pane 하나.
 *
 * 칸이 너무 좁아지면(12명이 한 줄이면 칸당 140px쯤) 배치를 그리는 대신 이걸 쓴다.
 * 이 브라우저의 보기 방식일 뿐이라 서버의 layout 트리는 건드리지 않는다 — 다른 사람의
 * 화면이나 CLI에는 영향이 없다. 폰의 카드 목록과 집중 화면을 한 화면에 나란히 둔 모양이다.
 *
 * 고른 pane은 workspace의 focusedSid다. 따로 상태를 두면 ⌘←→ 포커스 순환과 어긋난다.
 */
export function DesktopRoster({ sessionIds, memberNames, sessionCwds, hostedSids, renderFocus, onSplit }: {
  sessionIds: number[];
  memberNames: Record<number, string>;
  sessionCwds: Record<number, string>;
  /** 터미널 호스트가 이미 다른 곳에 가 있는 세션(zen). 카드에서 또 붙이지 않는다. */
  hostedSids: Set<number>;
  renderFocus: (sid: number) => ReactNode;
  onSplit: () => void;
}) {
  const { agentStates, deadSessions, focusedSid, focusSid } = useWorkspaceSessions();
  const [endedOpen, setEndedOpen] = useState<boolean>(() => { try { return localStorage.getItem(ROSTER_ENDED_STORAGE_KEY) === '1'; } catch { return false; } });
  const toggleEnded = () => setEndedOpen((v) => { try { localStorage.setItem(ROSTER_ENDED_STORAGE_KEY, v ? '0' : '1'); } catch {} return !v; });
  const listRef = useRef<HTMLDivElement>(null);

  const stateOf = (sid: number) => rosterState(agentStates[sid], deadSessions.has(sid));
  const order = useMemo(() => sortRoster(sessionIds, stateOf),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionIds.join(','), sessionIds.map((sid) => stateOf(sid)).join(',')]);
  const live = order.filter((sid) => stateOf(sid) !== 'ended');
  const ended = order.filter((sid) => stateOf(sid) === 'ended');
  const shown = endedOpen ? [...live, ...ended] : live;
  const needs = live.filter((sid) => stateOf(sid) === 'needs').length;
  const working = live.filter((sid) => stateOf(sid) === 'working').length;
  const selected = focusedSid !== null && sessionIds.includes(focusedSid) ? focusedSid : sessionIds[0] ?? null;

  const move = (delta: number) => {
    if (shown.length === 0) return;
    const at = selected === null ? -1 : shown.indexOf(selected);
    const next = shown[Math.min(shown.length - 1, Math.max(0, (at === -1 ? 0 : at + delta)))]!;
    if (next !== selected && !deadSessions.has(next)) focusSid(next);
  };

  if (sessionIds.length === 0) {
    return (
      <div style={emptyPaneStyle}>
        <button onClick={onSplit} style={actionBtnStyle}>start terminal</button>
      </div>
    );
  }

  const pill = (text: string, warn = false) => (
    <span style={{
      border: `1px solid ${warn ? 'var(--warn)' : 'var(--line)'}`, color: warn ? 'var(--warn)' : 'var(--text-soft)',
      borderRadius: 10, padding: '0 7px', fontSize: 10,
    }}>{text}</span>
  );

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '340px minmax(0, 1fr)', height: '100%', minHeight: 0 }}>
      <div style={{ borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg0)' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--line)',
          fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-soft)',
        }}>
          <span>{sessionIds.length}</span>
          {needs > 0 ? pill(`${needs} needs you`, true) : null}
          {pill(`${working} working`)}
        </div>
        <div
          ref={listRef}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); move(1); }
            else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); move(-1); }
          }}
          style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 6, display: 'flex', flexDirection: 'column', gap: 6, outline: 'none' }}
        >
          {live.map((sid) => (
            <PaneCard
              key={sid} sid={sid} name={memberNames[sid]} cwd={sessionCwds[sid]} variant="roster"
              selected={sid === selected} hostedElsewhere={sid === selected || hostedSids.has(sid)}
              onOpen={(next) => { focusSid(next); listRef.current?.focus({ preventScroll: true }); }}
            />
          ))}
          {ended.length > 0 ? (
            <>
              <div
                onClick={toggleEnded}
                style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer', userSelect: 'none', padding: '6px 4px 0', color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 10 }}
              >
                <span>{endedOpen ? '▾' : '▸'} ended {ended.length}</span>
                {endedOpen ? null : (
                  <span style={{ opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                    {ended.map((sid) => memberNames[sid] || `%${sid}`).join(' · ')}
                  </span>
                )}
              </div>
              {endedOpen ? ended.map((sid) => (
                <PaneCard
                  key={sid} sid={sid} name={memberNames[sid]} cwd={sessionCwds[sid]} variant="roster"
                  selected={sid === selected} hostedElsewhere onOpen={focusSid}
                />
              )) : null}
            </>
          ) : null}
        </div>
      </div>
      <div style={{ display: 'flex', minWidth: 0, minHeight: 0 }}>
        {selected !== null ? renderFocus(selected) : null}
      </div>
    </div>
  );
}
