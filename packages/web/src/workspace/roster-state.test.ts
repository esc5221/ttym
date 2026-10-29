import { describe, expect, it } from 'vitest';
import { rosterState, sortRoster, wantsRoster, ROSTER_CELL_PX, type RosterState } from './roster-state.js';

describe('rosterState', () => {
  it('a dead session is ended whatever the agent says', () => {
    expect(rosterState({ kind: 'claude-code', active: true, waiting: 'Bash' }, true)).toBe('ended');
  });

  it('waiting beats working', () => {
    expect(rosterState({ kind: 'claude-code', active: true, waiting: 'Bash' }, false)).toBe('needs');
  });

  it('a sleeping agent hides its waiting mark, like the pane header', () => {
    expect(rosterState({ kind: 'claude-code', active: false, waiting: 'Bash', sleep: { state: 'sleeping', since: 0, rssBefore: 0, reason: 'idle' } }, false)).toBe('asleep');
  });

  it('active without waiting is working; an agent that is not active, or a shell, is idle', () => {
    expect(rosterState({ kind: 'codex', active: true }, false)).toBe('working');
    expect(rosterState({ kind: 'codex', active: false }, false)).toBe('idle');
    expect(rosterState(undefined, false)).toBe('idle');
  });
});

describe('sortRoster', () => {
  it('puts waiting first and keeps layout order inside a state', () => {
    const states: Record<number, RosterState> = { 1: 'idle', 2: 'working', 3: 'needs', 4: 'working', 5: 'asleep' };
    expect(sortRoster([1, 2, 3, 4, 5], (sid) => states[sid]!)).toEqual([3, 2, 4, 1, 5]);
  });
});

describe('wantsRoster', () => {
  it('auto switches when the narrowest cell is under the threshold and there are 3+ panes', () => {
    expect(wantsRoster('auto', 12, 141)).toBe(true);
    expect(wantsRoster('auto', 12, ROSTER_CELL_PX)).toBe(false);
  });

  it('auto never switches for two panes or before the width is known', () => {
    expect(wantsRoster('auto', 2, 200)).toBe(false);
    expect(wantsRoster('auto', 12, null)).toBe(false);
  });

  it('a manual choice wins over the width', () => {
    expect(wantsRoster('list', 1, 2000)).toBe(true);
    expect(wantsRoster('grid', 12, 100)).toBe(false);
  });
});
