export interface PaneNode {
  type: 'pane';
  sessionId: number;
}

export interface SplitNode {
  type: 'split';
  axis: 'row' | 'col';
  sizes: number[];
  children: LayoutNode[];
}

export type LayoutNode = PaneNode | SplitNode;

export interface WorkspaceMemberLike {
  sessionId: number;
  name: string;
}

export interface WorkspaceLike<TMember extends WorkspaceMemberLike = WorkspaceMemberLike> {
  id: string;
  name: string;
  layout: LayoutNode;
  members: TMember[];
}

/** 새 workspace에 붙일 이름 — 아직 안 쓰인 첫 번호.
 *
 *  개수로 짓던 시절(`workspace ${count + 1}`)에는 만들고 지우기를 반복한 뒤
 *  살아남은 큰 번호와 정면으로 부딪쳤다: 19개가 있는데 "workspace 20"이 그중
 *  하나여서, + 버튼이 매번 409를 받고 아무 일도 안 일어났다. 개수는 이름의
 *  최대값과 아무 관계가 없다 — 쓰인 번호를 직접 봐야 한다.
 *
 *  유일성의 최종 판정은 여전히 서버다. 이건 첫 시도를 맞히기 위한 것이고,
 *  다른 창이 같은 번호를 동시에 집으면 호출부가 다음 번호로 재시도한다. */
export function nextWorkspaceName(taken: Iterable<string>): string {
  const used = new Set<number>();
  for (const name of taken) {
    const match = /^workspace (\d+)$/.exec(name.trim());
    if (match) used.add(Number(match[1]));
  }
  let n = 1;
  while (used.has(n)) n += 1;
  return `workspace ${n}`;
}

export interface BasePanelState {
  key: string;
  sessionId?: number;
  memberName?: string;
  cwd?: string;
}

export function shouldBootstrapWorkspacePanels<TPanel extends BasePanelState>(options: {
  initialized: boolean;
  hydrated: boolean;
  panels: TPanel[];
}): boolean {
  const { initialized, hydrated, panels } = options;
  if (!initialized || !hydrated) return false;
  if (panels.length !== 1) return false;
  return panels[0]?.sessionId === undefined;
}

export function layoutToSessionIds(node: LayoutNode): number[] {
  if (node.type === 'pane') return [node.sessionId];
  return node.children.flatMap(layoutToSessionIds);
}

export function sessionIdsToLayout(ids: number[]): LayoutNode {
  if (ids.length === 0) return { type: 'pane', sessionId: 0 };
  if (ids.length === 1) return { type: 'pane', sessionId: ids[0] };
  return {
    type: 'split',
    axis: 'row',
    sizes: ids.map(() => 1 / ids.length),
    children: ids.map((id) => ({ type: 'pane' as const, sessionId: id })),
  };
}

export function memberNameBySession<TMember extends WorkspaceMemberLike>(members: TMember[]): Map<number, string> {
  return new Map(members.map((member) => [member.sessionId, member.name]));
}

export function workspaceLabel(name: string): string {
  return name;
}

export function formatCwd(cwd?: string | null): string | null {
  if (!cwd) return null;
  return cwd.replace(/^\/Users\/[^/]+\b/, '~');
}

export function reconcileSessionPanels<TPanel extends BasePanelState>(
  prevPanels: TPanel[],
  sessionIds: number[],
  options: {
    createEmpty: () => TPanel;
    createForSession: (sessionId: number) => TPanel;
    decorateSession?: (panel: TPanel, sessionId: number) => TPanel;
    clearUnassigned?: (panel: TPanel) => TPanel;
  },
): TPanel[] {
  const {
    createEmpty,
    createForSession,
    decorateSession = (panel) => panel,
    clearUnassigned = (panel) => panel,
  } = options;

  const unusedPrev = [...prevPanels];
  const nextPanels = (sessionIds.length > 0 ? sessionIds : [undefined]).map((sessionId) => {
    if (sessionId !== undefined) {
      const matchedIndex = unusedPrev.findIndex((panel) => panel.sessionId === sessionId);
      if (matchedIndex >= 0) {
        const [matched] = unusedPrev.splice(matchedIndex, 1);
        return decorateSession({ ...matched, sessionId }, sessionId);
      }
    }

    const fallback = unusedPrev.shift();
    if (fallback) {
      if (sessionId === undefined) return clearUnassigned({ ...fallback, sessionId: undefined });
      return decorateSession({ ...fallback, sessionId }, sessionId);
    }

    if (sessionId === undefined) return createEmpty();
    return decorateSession(createForSession(sessionId), sessionId);
  });

  const pendingPanels = unusedPrev.filter((panel) => panel.sessionId === undefined);
  if (pendingPanels.length > 0 && nextPanels.every((panel) => panel.sessionId !== undefined)) {
    return [...nextPanels, ...pendingPanels];
  }

  return nextPanels;
}

export class MutationBarrier {
  private pending = 0;
  private unlockAt = 0;

  constructor(private readonly settleMs = 1200) {}

  begin(): () => void {
    this.pending += 1;
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.pending = Math.max(0, this.pending - 1);
      this.unlockAt = Date.now() + this.settleMs;
    };
  }

  blockFor(ms = this.settleMs): void {
    this.unlockAt = Math.max(this.unlockAt, Date.now() + ms);
  }

  isLocked(): boolean {
    return this.pending > 0 || Date.now() < this.unlockAt;
  }
}
