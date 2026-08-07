import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  insertPane,
  splitPane,
  removePane,
  layoutSessionIds,
  layoutFromSessionIds,
} from '@ttym/shared';

// ───── Layout Tree Types ─────

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

export interface WorkspaceInfo {
  id: string;
  project: string;
  name: string;
  layout: LayoutNode;
  members: WorkspaceMemberInfo[];
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceMemberInfo {
  sessionId: number;
  name: string;
  role?: string;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
}

interface StoreFile {
  version: 2;
  workspaces: WorkspaceInfo[];
}

interface LegacyWorkspaceInfo {
  id: string;
  name: string;
  layout: LayoutNode;
  createdAt: number;
  updatedAt: number;
}

interface LegacyStoreFile {
  version: 1;
  workspaces: LegacyWorkspaceInfo[];
}

// ───── WorkspaceStore ─────

export class WorkspaceStore {
  private workspaces = new Map<string, WorkspaceInfo>();
  /** Runtime only: never written to workspaces.json, so the format is unchanged. */
  private lastDiagnostics = new Map<string, string[]>();
  private readonly filePath: string;
  private dirty = false;
  private savePromise: Promise<void> | null = null;
  private saveQueued = false;

  constructor(runtimeDir: string) {
    this.filePath = resolve(runtimeDir, 'workspaces.json');
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const data = JSON.parse(raw) as StoreFile | LegacyStoreFile;
      if ((data as StoreFile).version === 2 && Array.isArray((data as StoreFile).workspaces)) {
        for (const ws of (data as StoreFile).workspaces) {
          this.workspaces.set(ws.id, this.normalizeWorkspace(ws));
        }
        return;
      }
      if ((data as LegacyStoreFile).version === 1 && Array.isArray((data as LegacyStoreFile).workspaces)) {
        for (const ws of (data as LegacyStoreFile).workspaces) {
          this.workspaces.set(ws.id, this.normalizeWorkspace({
            ...ws,
            project: 'default',
            members: [],
          }));
        }
      }
    } catch {}
  }

  async save(): Promise<void> {
    if (this.savePromise) {
      this.saveQueued = true;
      await this.savePromise;
      if (!this.dirty) return;
    }

    this.savePromise = (async () => {
      do {
        this.saveQueued = false;
        const data: StoreFile = {
          version: 2,
          workspaces: Array.from(this.workspaces.values()),
        };
        const tmpPath = this.filePath + '.tmp';
        await writeFile(tmpPath, JSON.stringify(data, null, 2));
        await rename(tmpPath, this.filePath);
        this.dirty = false;
      } while (this.saveQueued || this.dirty);
    })();

    try {
      await this.savePromise;
    } finally {
      this.savePromise = null;
    }
  }

  private scheduleSave(): void {
    if (!this.dirty) {
      this.dirty = true;
      // Debounce: save on next tick to batch rapid changes
      queueMicrotask(() => {
        if (this.dirty) this.save().catch(() => {});
      });
    }
  }

  list(): WorkspaceInfo[] {
    return Array.from(this.workspaces.values());
  }

  listProjects(): Array<{ name: string; workspaceCount: number; memberCount: number }> {
    const stats = new Map<string, { workspaceCount: number; memberCount: number }>();
    for (const workspace of this.workspaces.values()) {
      const entry = stats.get(workspace.project) ?? { workspaceCount: 0, memberCount: 0 };
      entry.workspaceCount += 1;
      entry.memberCount += workspace.members.length;
      stats.set(workspace.project, entry);
    }
    return Array.from(stats.entries())
      .map(([name, entry]) => ({ name, ...entry }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): WorkspaceInfo | undefined {
    return this.workspaces.get(id);
  }

  create(
    id: string,
    name: string,
    layout: LayoutNode,
    project = 'default',
    members: WorkspaceMemberInfo[] = [],
  ): WorkspaceInfo {
    const now = Date.now();
    const ws = this.normalizeWorkspace({
      id,
      project,
      name,
      layout,
      members,
      createdAt: now,
      updatedAt: now,
    });
    this.workspaces.set(id, ws);
    this.scheduleSave();
    return ws;
  }

  update(
    id: string,
    patch: { project?: string; name?: string; layout?: LayoutNode; members?: WorkspaceMemberInfo[] },
  ): WorkspaceInfo | null {
    const ws = this.workspaces.get(id);
    if (!ws) return null;
    if (patch.project !== undefined) ws.project = patch.project;
    if (patch.name !== undefined) ws.name = patch.name;
    if (patch.layout !== undefined) ws.layout = patch.layout;
    if (patch.members !== undefined) ws.members = patch.members;
    this.reconcileWorkspace(ws);
    ws.updatedAt = Date.now();
    this.scheduleSave();
    return ws;
  }

  addMember(id: string, member: Omit<WorkspaceMemberInfo, 'createdAt' | 'updatedAt'>): WorkspaceInfo | null {
    const ws = this.workspaces.get(id);
    if (!ws) return null;
    for (const other of this.workspaces.values()) {
      if (other.id === id) continue;
      if (other.members.some((entry) => entry.sessionId === member.sessionId)) {
        throw new Error(`session ${member.sessionId} already belongs to workspace ${other.id}`);
      }
    }
    this.assertUniqueMemberName(ws, member.name, member.sessionId);

    const now = Date.now();
    const existing = ws.members.find((entry) => entry.sessionId === member.sessionId);
    if (existing) {
      existing.name = member.name;
      existing.role = member.role;
      existing.tags = member.tags ?? existing.tags ?? [];
      existing.updatedAt = now;
    } else {
      ws.members.push({
        sessionId: member.sessionId,
        name: member.name,
        role: member.role,
        tags: member.tags ?? [],
        createdAt: now,
        updatedAt: now,
      });
    }

    ws.layout = insertPane(ws.layout, member.sessionId);
    this.reconcileWorkspace(ws);
    ws.updatedAt = now;
    this.scheduleSave();
    return ws;
  }

  splitRight(
    id: string,
    targetSessionId: number | undefined,
    member: Omit<WorkspaceMemberInfo, 'createdAt' | 'updatedAt'>,
    direction: 'right' | 'left' | 'down' | 'up' = 'right',
  ): WorkspaceInfo | null {
    const ws = this.workspaces.get(id);
    if (!ws) return null;
    this.assertUniqueMemberName(ws, member.name, member.sessionId);

    const now = Date.now();
    ws.members.push({
      sessionId: member.sessionId,
      name: member.name,
      role: member.role,
      tags: member.tags ?? [],
      createdAt: now,
      updatedAt: now,
    });

    // A real split now: the target pane is replaced by a two-way split and
    // keeps its slot size, so nothing else in the layout moves.
    const axis = direction === 'down' || direction === 'up' ? 'col' as const : 'row' as const;
    const before = direction === 'left' || direction === 'up';
    ws.layout = targetSessionId === undefined
      ? insertPane(ws.layout, member.sessionId)
      : splitPane(ws.layout, targetSessionId, member.sessionId, axis, 0.5, before);
    this.reconcileWorkspace(ws);
    ws.updatedAt = now;
    this.scheduleSave();
    return ws;
  }

  removeMember(id: string, sessionId: number): WorkspaceInfo | null {
    const ws = this.workspaces.get(id);
    if (!ws) return null;
    ws.members = ws.members.filter((entry) => entry.sessionId !== sessionId);
    ws.layout = removePane(ws.layout, sessionId);
    this.reconcileWorkspace(ws);
    ws.updatedAt = Date.now();
    this.scheduleSave();
    return ws;
  }

  renameMember(id: string, sessionId: number, name: string): WorkspaceInfo | null {
    const ws = this.workspaces.get(id);
    if (!ws) return null;
    this.assertUniqueMemberName(ws, name, sessionId);
    const member = ws.members.find((entry) => entry.sessionId === sessionId);
    if (!member) return null;
    member.name = name;
    member.updatedAt = Date.now();
    this.reconcileWorkspace(ws);
    ws.updatedAt = Date.now();
    this.scheduleSave();
    return ws;
  }

  delete(id: string): boolean {
    const deleted = this.workspaces.delete(id);
    if (deleted) this.scheduleSave();
    return deleted;
  }

  private normalizeWorkspace(ws: WorkspaceInfo): WorkspaceInfo {
    const normalized: WorkspaceInfo = {
      ...ws,
      project: ws.project || 'default',
      members: Array.isArray(ws.members) ? ws.members.map((member) => ({ ...member })) : [],
    };
    this.reconcileWorkspace(normalized);
    return normalized;
  }

  /**
   * Bring `members` in line with the layout without losing anything.
   *
   * This used to rebuild the list purely from the layout's leaves, so a member
   * the layout did not mention was dropped — name, role and tags with it, and
   * without a word. Two members holding the same name silently became one.
   *
   * Every mutation path now updates both sides together, so a mismatch means
   * something outside those paths wrote the file or a bug did. Either way the
   * answer is to report it, not to quietly pick a winner.
   */
  private reconcileWorkspace(ws: WorkspaceInfo): void {
    const placed = layoutSessionIds(ws.layout);
    const now = Date.now();
    const bySession = new Map(ws.members.map((member) => [member.sessionId, member]));
    const usedNames = new Set<string>();
    const reconciled: WorkspaceMemberInfo[] = [];
    const problems: string[] = [];

    const claimName = (preferred: string | undefined, ordinal: number): string => {
      if (preferred && !usedNames.has(preferred)) {
        usedNames.add(preferred);
        return preferred;
      }
      const fresh = this.nextMemberName(usedNames, ordinal);
      if (preferred) problems.push(`duplicate name "${preferred}" renamed to "${fresh}"`);
      usedNames.add(fresh);
      return fresh;
    };

    // Members the layout places, in layout order.
    placed.forEach((sessionId, index) => {
      const existing = bySession.get(sessionId);
      bySession.delete(sessionId);
      reconciled.push({
        sessionId,
        name: claimName(existing?.name, index + 1),
        role: existing?.role,
        tags: existing?.tags ?? [],
        createdAt: existing?.createdAt ?? now,
        updatedAt: existing?.updatedAt ?? now,
      });
    });

    // Anything left over is a member the layout does not show. Keep it — its
    // name and role are the only record that it exists.
    for (const orphan of bySession.values()) {
      problems.push(`member "${orphan.name}" (session ${orphan.sessionId}) is not placed in the layout`);
      reconciled.push({ ...orphan, name: claimName(orphan.name, reconciled.length + 1) });
    }

    ws.members = reconciled;

    if (problems.length > 0) {
      this.lastDiagnostics.set(ws.id, problems);
      console.warn(`[ws ${ws.project}/${ws.name}] ${problems.join('; ')}`);
    } else {
      this.lastDiagnostics.delete(ws.id);
    }
  }

  /** Problems the last reconcile found for a workspace, if any. Not persisted. */
  diagnostics(id: string): string[] {
    return this.lastDiagnostics.get(id) ?? [];
  }

  private nextMemberName(usedNames: Set<string>, start: number): string {
    let index = start;
    while (usedNames.has(`term-${index}`)) index += 1;
    return `term-${index}`;
  }

  private assertUniqueMemberName(ws: WorkspaceInfo, name: string, sessionId: number): void {
    const duplicate = ws.members.find((member) => member.name === name && member.sessionId !== sessionId);
    if (duplicate) throw new Error(`member name already exists: ${name}`);
  }
}


