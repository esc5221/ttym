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
