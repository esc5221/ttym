import { createContext, useContext } from 'react';
import type { ViewItem, ViewerState } from '@ttym/api';
import type { TerminalMux } from '@ttym/ui';
import type { AgentState } from '../app-shared.js';
import type { ViewerHook } from '../viewer/useViewerState.js';
import type { SelectionTarget } from '../viewer/SelectionOpen.js';
import type { ViewerFocus } from '../route.js';

/**
 * 워크스페이스 한 화면이 세션마다 공유하는 상태와 동작.
 *
 * 세션 하나를 보여주는 화면이 세 벌 있다 — grid의 pane, zen, 폰의 전체화면. 이 값들을
 * 프롭으로 따로 내려보내던 동안 기능이 화면마다 따로 붙었다: 뷰어는 grid와 zen에만,
 * sleep 알약·경로 open·파일 드롭은 grid에만, 폰의 find 버튼은 그릴 곳 없는 검색 상태만
 * 바꿨다. 셋이 같은 곳에서 꺼내 쓰게 하려고 여기 모은다. 소유자는 WorkspacePage다.
 */
export interface WorkspaceSessions {
  mux: TerminalMux;
  localEchoEnabled: boolean;
  touch: boolean;
  agentStates: Record<number, AgentState>;
  lastAgentIds: Record<number, { claude?: string; codex?: string }>;
  deadSessions: Set<number>;
  markDead: (sid: number) => void;
  focusedSid: number | null;
  /** pane을 누르면: 포커스, 떠 있던 경로 open 버튼 닫기, 벨 지우기. */
  focusSid: (sid: number) => void;
  bells: Set<number>;
  /** 벨 — 보고 있는 pane이 아니면 표시를 남긴다. 터치 기기는 진동도. */
  ringBell: (sid: number) => void;

  viewer: ViewerHook;
  /** `--full`로 workspace를 덮고 있는 탭. 그 세션의 pane 안에서는 같은 탭을 또 그리지 않는다. */
  open: ViewerFocus | null;
  openFull: (sid: number, vid: string) => void;
  viewerReload: Record<number, number>;
  reloadViewer: (sid: number) => void;

  selOpen: SelectionTarget | null;
  setSelOpen: React.Dispatch<React.SetStateAction<SelectionTarget | null>>;
  offerSelection: (sid: number, e: React.MouseEvent<HTMLDivElement>) => void;

  search: { sid: number; query: string; index: number; count: number } | null;
  setSearch: React.Dispatch<React.SetStateAction<{ sid: number; query: string; index: number; count: number } | null>>;

  fileDropSid: number | null;
  setFileDropSid: React.Dispatch<React.SetStateAction<number | null>>;
  insertPathsIntoPane: (sid: number, paths: string[]) => void;

  sleepAgent: (sid: number) => Promise<void>;
  wakeAgent: (sid: number) => Promise<void>;
  restoreAgent: (sid: number) => void;
  sleepNote: { sid: number; text: string } | null;

  restartAt: (sid: number) => Promise<void>;
  detachMember: (sid: number) => Promise<void>;
}

export const WorkspaceSessionsContext = createContext<WorkspaceSessions | null>(null);

export function useWorkspaceSessions(): WorkspaceSessions {
  const ctx = useContext(WorkspaceSessionsContext);
  if (!ctx) throw new Error('useWorkspaceSessions outside WorkspacePage');
  return ctx;
}

/**
 * 이 세션에서 지금 무엇이 앞에 있나 — 'term' 이거나 뷰어 탭 하나.
 *
 * `--full`로 나가 있는 세션은 pane 안에서 탭을 안 그린다(같은 탭을 두 번 마운트하지 않는다).
 * 폰은 full이 따로 없어서 그 탭을 제자리에서 보여준다 — `showFullInPlace`.
 */
export function paneView(ctx: WorkspaceSessions, sid: number, showFullInPlace = false): {
  state: ViewerState | null;
  tab: string;
  item: ViewItem | null;
} {
  const hidden = !showFullInPlace && ctx.open?.sid === sid;
  const state = hidden ? null : (ctx.viewer.states[sid] ?? null);
  const active = ctx.viewer.active[sid];
  const item = state && active ? state.items.find((i) => i.id === active) ?? null : null;
  return { state, tab: item ? item.id : 'term', item };
}
