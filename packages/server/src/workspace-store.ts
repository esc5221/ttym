import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  insertPane,
  splitPane,
  removePane,
  presetLayout,
  isLayoutPreset,
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

/** 작업 지도에서의 배치 — 요약기가 쓰고 지도 뷰가 읽는다. 없으면 미분류. */
export interface WorkspaceMapAnnotation {
  stream?: string;
  column?: number;
  order?: number;
  updatedAt?: number;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  layout: LayoutNode;
  members: WorkspaceMemberInfo[];
  map?: WorkspaceMapAnnotation;
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
  version: 3;
  workspaces: WorkspaceInfo[];
}

/** v2 시절 파일: project 필드가 있었다 — 로드 시 폐기된다. */
interface V2WorkspaceInfo extends WorkspaceInfo {
  project?: string;
}

interface V2StoreFile {
  version: 2;
  workspaces: V2WorkspaceInfo[];
}

// ───── WorkspaceStore ─────


export interface WorkspaceChangeEvent {
  generation: number;
  workspace?: WorkspaceInfo;
  deletedId?: string;
  /** 탭 재배치: 전체 id 순열. 부분 diff가 아니라 순서 전체를 다시 말한다. */
  order?: string[];
}

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
      const data = JSON.parse(raw) as StoreFile | V2StoreFile;
      let entries: Array<WorkspaceInfo & { project?: string }> = [];
      if ((data as StoreFile).version === 3 && Array.isArray((data as StoreFile).workspaces)) {
        entries = (data as StoreFile).workspaces;
      } else if ((data as V2StoreFile).version === 2 && Array.isArray((data as V2StoreFile).workspaces)) {
        entries = (data as V2StoreFile).workspaces; // project 필드는 아래에서 폐기
        this.dirty = true; // 첫 save가 v3로 승격
      }
      for (const entry of entries) {
        const { project: _dropped, ...ws } = entry;
        // 이름이 곧 주소다(project 소멸의 대가) — 파일에 중복이 있으면 뒤의 것이
        // -2, -3…을 받고 경고를 남긴다. 조용히 한쪽을 삼키지 않는다.
        let name = ws.name;
        for (let n = 2; this.hasName(name); n++) name = `${ws.name}-${n}`;
        if (name !== ws.name) {
          console.warn(`[ws ${ws.id}] duplicate name "${ws.name}" → "${name}"`);
          this.dirty = true;
        }
        this.workspaces.set(ws.id, this.normalizeWorkspace({ ...ws, name }));
      }
      // 구버전 파일은 다음 변경을 기다리지 않고 부팅 즉시 승격한다.
      if (this.dirty) void this.save();
    } catch {}
  }

  private hasName(name: string, exceptId?: string): boolean {
    for (const ws of this.workspaces.values()) {
      if (ws.id !== exceptId && ws.name === name) return true;
    }
    return false;
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
          version: 3,
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

  private changeListeners = new Set<(event: WorkspaceChangeEvent) => void>();
  private changeGeneration = 0;

  /** Every mutation announces the whole workspace — full tree, never a diff.
   *  A diff protocol desynchronizes forever after one missed frame; the tree
   *  is small enough to resend whole with a generation to order by. */
  onChange(listener: (event: WorkspaceChangeEvent) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private emitChange(change: { workspace?: WorkspaceInfo; deletedId?: string; order?: string[] }): void {
    const event: WorkspaceChangeEvent = { generation: ++this.changeGeneration, ...change };
    for (const listener of this.changeListeners) {
      try { listener(event); } catch {}
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

  /**
   * 탭 순서 = Map 삽입순 = workspaces.json 배열순. 재배치는 순열 전체를 받아
   * Map을 다시 짓는다 — id 집합이 현재와 정확히 일치하지 않으면 거부
   * (동시 생성/삭제와 교차한 낡은 순열이 workspace를 증발시키는 사고 방지).
   */
  reorder(ids: string[]): boolean {
    const current = new Set(this.workspaces.keys());
    if (ids.length !== current.size || !ids.every((id) => current.has(id))) return false;
    const rebuilt = new Map<string, WorkspaceInfo>();
    for (const id of ids) rebuilt.set(id, this.workspaces.get(id)!);
    this.workspaces = rebuilt;
    this.scheduleSave();
    this.emitChange({ order: ids });
    return true;
  }


  get(id: string): WorkspaceInfo | undefined {
    return this.workspaces.get(id);
  }

  create(
    id: string,
    name: string,
    layout: LayoutNode,
    members: WorkspaceMemberInfo[] = [],
  ): WorkspaceInfo {
    if (this.hasName(name)) throw new Error(`workspace name already exists: ${name}`);
    const now = Date.now();
    const ws = this.normalizeWorkspace({
      id,
      name,
      layout,
      members,
      createdAt: now,
      updatedAt: now,
    });
    this.workspaces.set(id, ws);
    this.scheduleSave();
    this.emitChange({ workspace: ws });
    return ws;
  }

  update(
    id: string,
    patch: { name?: string; layout?: LayoutNode; members?: WorkspaceMemberInfo[]; preset?: string; map?: WorkspaceMapAnnotation | null },
  ): WorkspaceInfo | null {
    const ws = this.workspaces.get(id);
    if (!ws) return null;
    if (patch.name !== undefined) {
      if (this.hasName(patch.name, id)) throw new Error(`workspace name already exists: ${patch.name}`);
      ws.name = patch.name;
    }
    if (patch.layout !== undefined) ws.layout = patch.layout;
    if (patch.preset !== undefined && isLayoutPreset(patch.preset)) {
      // tmux select-layout: re-attach the same members to a fresh tree —
      // membership order decides who gets the main pane, sessions untouched.
      ws.layout = presetLayout(patch.preset, ws.members.map((m) => m.sessionId));
    }
    if (patch.members !== undefined) ws.members = patch.members;
    if (patch.map !== undefined) ws.map = patch.map === null ? undefined : { ...patch.map, updatedAt: Date.now() };
    this.reconcileWorkspace(ws);
    ws.updatedAt = Date.now();
    this.scheduleSave();
    this.emitChange({ workspace: ws });
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
    this.emitChange({ workspace: ws });
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
    this.emitChange({ workspace: ws });
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
    this.emitChange({ workspace: ws });
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
    this.emitChange({ workspace: ws });
    return ws;
  }

  delete(id: string): boolean {
    const deleted = this.workspaces.delete(id);
    if (deleted) {
      this.scheduleSave();
      this.emitChange({ deletedId: id });
    }
    return deleted;
  }

  private normalizeWorkspace(ws: WorkspaceInfo): WorkspaceInfo {
    const normalized: WorkspaceInfo = {
      ...ws,
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
      console.warn(`[ws ${ws.name}] ${problems.join('; ')}`);
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


