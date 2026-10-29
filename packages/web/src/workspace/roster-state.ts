import type { AgentState } from '../app-shared.js';

/** 목록 카드가 보여주는 멤버 상태. 순서가 곧 정렬 순위다. */
export type RosterState = 'needs' | 'working' | 'idle' | 'asleep' | 'ended';

export const ROSTER_RANK: Record<RosterState, number> = { needs: 0, working: 1, idle: 2, asleep: 3, ended: 4 };

export const ROSTER_LABEL: Record<RosterState, string> = {
  needs: 'needs you', working: 'working', idle: 'idle', asleep: 'asleep', ended: 'ended',
};

/** PaneHeader와 같은 판정이다: 자는 중이면 waiting 표시는 숨긴다(깨우기 전엔 답할 수 없다). */
export function rosterState(agent: AgentState | undefined, dead: boolean): RosterState {
  if (dead) return 'ended';
  const sleep = agent?.sleep?.state;
  if (sleep === 'sleeping' || sleep === 'waking') return 'asleep';
  if (agent?.waiting) return 'needs';
  if (agent?.active) return 'working';
  return 'idle';
}

/** 상태 순위로 정렬하되 같은 상태끼리는 원래(레이아웃) 순서를 지킨다 — 카드가 제자리에서 흔들리지 않게. */
export function sortRoster(sids: number[], stateOf: (sid: number) => RosterState): number[] {
  return sids
    .map((sid, index) => ({ sid, index, rank: ROSTER_RANK[stateOf(sid)] }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.sid);
}

/** 데스크톱 목록 모드로 들어가는 칸 폭 기준(px). 이보다 좁은 칸이 생기면 자동으로 바뀐다. */
export const ROSTER_CELL_PX = 360;
/** 자동 전환은 pane이 이만큼 이상일 때만. 2개짜리 좁은 창에서 배치가 사라지면 놀랍다. */
export const ROSTER_AUTO_MIN_PANES = 3;

export type RosterMode = 'auto' | 'list' | 'grid';
export const ROSTER_MODE_STORAGE_KEY = 'ttym-roster-mode';
export const ROSTER_ENDED_STORAGE_KEY = 'ttym-roster-ended-open';

export function readRosterMode(): RosterMode {
  try {
    const v = localStorage.getItem(ROSTER_MODE_STORAGE_KEY);
    return v === 'list' || v === 'grid' ? v : 'auto';
  } catch { return 'auto'; }
}

export function writeRosterMode(mode: RosterMode): void {
  try {
    if (mode === 'auto') localStorage.removeItem(ROSTER_MODE_STORAGE_KEY);
    else localStorage.setItem(ROSTER_MODE_STORAGE_KEY, mode);
  } catch {}
}

/** 지금 목록으로 그릴지. 수동 선택이 자동 판정보다 앞선다. */
export function wantsRoster(mode: RosterMode, paneCount: number, narrowestPx: number | null): boolean {
  if (mode === 'list') return true;
  if (mode === 'grid') return false;
  return paneCount >= ROSTER_AUTO_MIN_PANES && narrowestPx !== null && narrowestPx < ROSTER_CELL_PX;
}
