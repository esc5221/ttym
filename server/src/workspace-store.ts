import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';

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
  name: string;
  layout: LayoutNode;
  createdAt: number;
  updatedAt: number;
}

interface StoreFile {
  version: 1;
  workspaces: WorkspaceInfo[];
}

// ───── WorkspaceStore ─────

export class WorkspaceStore {
  private workspaces = new Map<string, WorkspaceInfo>();
  private readonly filePath: string;
  private dirty = false;

  constructor(runtimeDir: string) {
    this.filePath = resolve(runtimeDir, 'workspaces.json');
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const data: StoreFile = JSON.parse(raw);
      if (data.version !== 1 || !Array.isArray(data.workspaces)) return;
      for (const ws of data.workspaces) {
        this.workspaces.set(ws.id, ws);
      }
    } catch {}
  }

  async save(): Promise<void> {
    const data: StoreFile = {
      version: 1,
      workspaces: Array.from(this.workspaces.values()),
    };
    const tmpPath = this.filePath + '.tmp';
    await writeFile(tmpPath, JSON.stringify(data, null, 2));
    await rename(tmpPath, this.filePath);
    this.dirty = false;
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

  get(id: string): WorkspaceInfo | undefined {
    return this.workspaces.get(id);
  }

  create(id: string, name: string, layout: LayoutNode): WorkspaceInfo {
    const now = Date.now();
    const ws: WorkspaceInfo = { id, name, layout, createdAt: now, updatedAt: now };
    this.workspaces.set(id, ws);
    this.scheduleSave();
    return ws;
  }

  update(id: string, patch: { name?: string; layout?: LayoutNode }): WorkspaceInfo | null {
    const ws = this.workspaces.get(id);
    if (!ws) return null;
    if (patch.name !== undefined) ws.name = patch.name;
    if (patch.layout !== undefined) ws.layout = patch.layout;
    ws.updatedAt = Date.now();
    this.scheduleSave();
    return ws;
  }

  delete(id: string): boolean {
    const deleted = this.workspaces.delete(id);
    if (deleted) this.scheduleSave();
    return deleted;
  }

  /** Remap session IDs in all workspace layouts (for reboot restore) */
  remapSessionIds(idMap: Map<number, number>): void {
    if (idMap.size === 0) return;
    let changed = false;
    for (const ws of this.workspaces.values()) {
      if (remapLayout(ws.layout, idMap)) {
        ws.updatedAt = Date.now();
        changed = true;
      }
    }
    if (changed) this.scheduleSave();
  }
}

/** Recursively remap sessionIds in a layout tree. Returns true if anything changed. */
function remapLayout(node: LayoutNode, idMap: Map<number, number>): boolean {
  if (node.type === 'pane') {
    const newId = idMap.get(node.sessionId);
    if (newId !== undefined) {
      node.sessionId = newId;
      return true;
    }
    return false;
  }
  let changed = false;
  for (const child of node.children) {
    if (remapLayout(child, idMap)) changed = true;
  }
  return changed;
}
