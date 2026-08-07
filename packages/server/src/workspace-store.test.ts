import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore } from './workspace-store.js';

function runtimeDir() {
  return mkdtempSync(join(tmpdir(), 'ttym-ws-store-'));
}

function layoutIds(node: any): number[] {
  if (node.type === 'pane') return node.sessionId > 0 ? [node.sessionId] : [];
  return node.children.flatMap(layoutIds);
}

describe('WorkspaceStore', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('migrates legacy workspaces into default project with generated members', async () => {
    const dir = runtimeDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'workspaces.json'), JSON.stringify({
      version: 1,
      workspaces: [
        {
          id: 'ws1',
          name: 'workspace 1',
          layout: {
            type: 'split',
            axis: 'row',
            sizes: [0.5, 0.5],
            children: [
              { type: 'pane', sessionId: 11 },
              { type: 'pane', sessionId: 12 },
            ],
          },
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    }));

    const store = new WorkspaceStore(dir);
    await store.load();

    const [workspace] = store.list();
    expect(workspace.project).toBe('default');
    expect(workspace.members.map((member) => member.sessionId)).toEqual([11, 12]);
    expect(workspace.members.map((member) => member.name)).toEqual(['term-1', 'term-2']);
  });

  it('reconciles members when layout changes and preserves existing names', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    const created = store.create('ws1', 'workspace 1', {
      type: 'split',
      axis: 'row',
      sizes: [0.5, 0.5],
      children: [
        { type: 'pane', sessionId: 21 },
        { type: 'pane', sessionId: 22 },
      ],
    }, 'ttym', [
      { sessionId: 21, name: 'lead', createdAt: 1, updatedAt: 1 },
      { sessionId: 22, name: 'devserver', createdAt: 1, updatedAt: 1 },
    ]);

    const updated = store.update(created.id, {
      layout: {
        type: 'split',
        axis: 'row',
        sizes: [0.33, 0.33, 0.34],
        children: [
          { type: 'pane', sessionId: 21 },
          { type: 'pane', sessionId: 23 },
          { type: 'pane', sessionId: 22 },
        ],
      },
    });

    expect(updated?.members.map((member) => [member.sessionId, member.name])).toEqual([
      [21, 'lead'],
      [23, 'term-2'],
      [22, 'devserver'],
    ]);
    expect(store.listProjects()).toEqual([{ name: 'ttym', workspaceCount: 1, memberCount: 3 }]);
  });

  it('supports atomic member add, rename, and remove without clobbering siblings', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    const created = store.create('ws1', 'workspace 1', { type: 'pane', sessionId: 0 }, 'pilot', []);

    const first = store.addMember(created.id, { sessionId: 31, name: 'lead', role: 'agent', tags: [] });
    expect(first?.members.map((member) => member.name)).toEqual(['lead']);
    const second = store.addMember(created.id, { sessionId: 32, name: 'devserver', role: 'server', tags: [] });

    expect(second?.members.map((member) => member.name)).toEqual(['lead', 'devserver']);
    expect(second?.layout).toEqual({
      type: 'split',
      axis: 'row',
      sizes: [0.5, 0.5],
      children: [
        { type: 'pane', sessionId: 31 },
        { type: 'pane', sessionId: 32 },
      ],
    });

    const renamed = store.renameMember(created.id, 32, 'api');
    expect(renamed?.members.map((member) => [member.sessionId, member.name])).toEqual([
      [31, 'lead'],
      [32, 'api'],
    ]);

    const removed = store.removeMember(created.id, 31);
    expect(removed?.members.map((member) => [member.sessionId, member.name])).toEqual([[32, 'api']]);
    expect(removed?.layout).toEqual({ type: 'pane', sessionId: 32 });
  });

  it('inserts a new member immediately to the right of the target session', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    const created = store.create('ws1', 'workspace 1', {
      type: 'split',
      axis: 'row',
      sizes: [0.5, 0.5],
      children: [
        { type: 'pane', sessionId: 41 },
        { type: 'pane', sessionId: 42 },
      ],
    }, 'pilot', [
      { sessionId: 41, name: 'lead', createdAt: 1, updatedAt: 1 },
      { sessionId: 42, name: 'logs', createdAt: 1, updatedAt: 1 },
    ]);

    const updated = store.splitRight(created.id, 41, {
      sessionId: 43,
      name: 'worker',
      role: 'agent',
      tags: [],
    });

    expect(updated?.members.map((member) => member.name)).toEqual(['lead', 'worker', 'logs']);
    // Splitting along the row's own axis joins it as a sibling with an equal
    // share — a 50/50 row split again reads as thirds, not 50/25/25.
    expect(updated?.layout).toEqual({
      type: 'split',
      axis: 'row',
      sizes: [1 / 3, 1 / 3, 1 / 3],
      children: [
        { type: 'pane', sessionId: 41 },
        { type: 'pane', sessionId: 43 },
        { type: 'pane', sessionId: 42 },
      ],
    });
  });
  });


  it('splits downward into a column and upward before the target', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    const created = store.create('dir-ws', 'dir-ws', { type: 'pane', sessionId: 41 }, 'pilot',
      [{ sessionId: 41, name: 'lead', createdAt: 1, updatedAt: 1 }]);

    const down = store.splitRight(created.id, 41, { sessionId: 42, name: 'below', tags: [] }, 'down')!;
    expect(down.layout).toEqual({
      type: 'split', axis: 'col', sizes: [0.5, 0.5],
      children: [{ type: 'pane', sessionId: 41 }, { type: 'pane', sessionId: 42 }],
    });

    const up = store.splitRight(created.id, 41, { sessionId: 43, name: 'above', tags: [] }, 'up')!;
    // col[41,42] + up on 41 → same-axis sibling before the target: col[43,41,42].
    const col = up.layout as any;
    expect(col.axis).toBe('col');
    expect(col.children.map((c: any) => c.sessionId)).toEqual([43, 41, 42]);
    expect(col.sizes.every((v: number) => Math.abs(v - 1 / 3) < 1e-9)).toBe(true);
  });
  it('preserves nesting and sizes when a member is added', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    // The RFD's reproduction: row [0.7, 0.3] with a nested col [0.5, 0.5].
    const created = store.create('ws1', 'nested', {
      type: 'split',
      axis: 'row',
      sizes: [0.7, 0.3],
      children: [
        { type: 'pane', sessionId: 1 },
        {
          type: 'split',
          axis: 'col',
          sizes: [0.5, 0.5],
          children: [
            { type: 'pane', sessionId: 2 },
            { type: 'pane', sessionId: 3 },
          ],
        },
      ],
    }, 'proj', [
      { sessionId: 1, name: 'a', createdAt: 1, updatedAt: 1 },
      { sessionId: 2, name: 'b', createdAt: 1, updatedAt: 1 },
      { sessionId: 3, name: 'c', createdAt: 1, updatedAt: 1 },
    ]);

    const innerBefore = JSON.stringify((created.layout as any).children[1]);

    const updated = store.addMember(created.id, { sessionId: 4, name: 'd', tags: [] });
    const layout = updated!.layout as any;

    // The sibling subtree comes out byte for byte as it went in.
    expect(JSON.stringify(layout.children[1])).toBe(innerBefore);
    // 0.7 : 0.3 still holds between the original two slots.
    expect(Math.abs(layout.sizes[0] / layout.sizes[1] - 0.7 / 0.3)).toBeLessThan(1e-9);
    expect(Math.abs(layout.sizes.reduce((a: number, b: number) => a + b, 0) - 1)).toBeLessThan(1e-9);
    expect(layout.children.length).toBe(3);
  });

  it('preserves nesting and sizes when a member is removed', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    const created = store.create('ws1', 'nested', {
      type: 'split',
      axis: 'row',
      sizes: [0.6, 0.25, 0.15],
      children: [
        { type: 'pane', sessionId: 1 },
        { type: 'pane', sessionId: 2 },
        {
          type: 'split',
          axis: 'col',
          sizes: [0.5, 0.5],
          children: [
            { type: 'pane', sessionId: 3 },
            { type: 'pane', sessionId: 4 },
          ],
        },
      ],
    }, 'proj', [1, 2, 3, 4].map((id) => ({ sessionId: id, name: `m${id}`, createdAt: 1, updatedAt: 1 })));

    const innerBefore = JSON.stringify((created.layout as any).children[2]);

    const updated = store.removeMember(created.id, 2);
    const layout = updated!.layout as any;

    expect(JSON.stringify(layout.children[1])).toBe(innerBefore);
    // 0.6 : 0.15 survives the removal of the 0.25 slot.
    expect(Math.abs(layout.sizes[0] / layout.sizes[1] - 0.6 / 0.15)).toBeLessThan(1e-9);
    expect(layoutIds(layout)).toEqual([1, 3, 4]);
  });

  it('does not flatten across a long run of adds and removes', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    const created = store.create('ws1', 'nested', {
      type: 'split',
      axis: 'row',
      sizes: [0.7, 0.3],
      children: [
        { type: 'pane', sessionId: 1 },
        {
          type: 'split',
          axis: 'col',
          sizes: [0.8, 0.2],
          children: [
            { type: 'pane', sessionId: 2 },
            { type: 'pane', sessionId: 3 },
          ],
        },
      ],
    }, 'proj', [1, 2, 3].map((id) => ({ sessionId: id, name: `m${id}`, createdAt: 1, updatedAt: 1 })));

    let ws = created;
    for (const id of [10, 11, 12]) ws = store.addMember(ws.id, { sessionId: id, name: `n${id}`, tags: [] })!;
    for (const id of [11, 10]) ws = store.removeMember(ws.id, id)!;

    const layout = ws.layout as any;
    // Still nested, and the inner split still carries its own 0.8 : 0.2.
    expect(layout.children[1].type).toBe('split');
    expect(Math.abs(layout.children[1].sizes[0] / layout.children[1].sizes[1] - 4)).toBeLessThan(1e-9);
    expect(Math.abs(layout.sizes[0] / layout.sizes[1] - 0.7 / 0.3)).toBeLessThan(1e-9);
    expect(layoutIds(layout)).toEqual([1, 2, 3, 12]);
  });

  it('keeps a member the layout does not place, and reports it', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);

    // layout mentions only 41; 42 is a member the layout does not show.
    const created = store.create('ws1', 'w', { type: 'pane', sessionId: 41 }, 'proj', [
      { sessionId: 41, name: 'lead', role: 'agent', createdAt: 1, updatedAt: 1 },
      { sessionId: 42, name: 'logs', role: 'shell', createdAt: 1, updatedAt: 1 },
    ]);

    const names = created.members.map((m) => m.name);
    expect(names).toContain('lead');
    expect(names).toContain('logs'); // used to disappear without a word
    const logs = created.members.find((m) => m.sessionId === 42);
    expect(logs?.role).toBe('shell'); // role survived too
    expect(store.diagnostics(created.id).join(' ')).toContain('not placed in the layout');
  });

  it('renames a duplicate instead of dropping the member', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);

    const created = store.create('ws1', 'w', {
      type: 'split', axis: 'row', sizes: [0.5, 0.5],
      children: [{ type: 'pane', sessionId: 1 }, { type: 'pane', sessionId: 2 }],
    }, 'proj', [
      { sessionId: 1, name: 'claude', createdAt: 1, updatedAt: 1 },
      { sessionId: 2, name: 'claude', createdAt: 1, updatedAt: 1 },
    ]);

    // Both sessions are still members; the collision is resolved by renaming.
    expect(created.members.map((m) => m.sessionId).sort()).toEqual([1, 2]);
    expect(new Set(created.members.map((m) => m.name)).size).toBe(2);
    expect(store.diagnostics(created.id).join(' ')).toContain('duplicate name');
  });

  it('reports nothing when the layout and members agree', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    const created = store.create('ws1', 'w', { type: 'pane', sessionId: 7 }, 'proj', [
      { sessionId: 7, name: 'only', createdAt: 1, updatedAt: 1 },
    ]);
    expect(store.diagnostics(created.id)).toEqual([]);
  });

  it('stays consistent across the normal mutation paths', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    let ws = store.create('ws1', 'w', { type: 'pane', sessionId: 1 }, 'proj', [
      { sessionId: 1, name: 'a', createdAt: 1, updatedAt: 1 },
    ]);

    ws = store.addMember(ws.id, { sessionId: 2, name: 'b', tags: [] })!;
    ws = store.splitRight(ws.id, 1, { sessionId: 3, name: 'c', tags: [] })!;
    ws = store.removeMember(ws.id, 2)!;

    // Members and layout describe the same set, so nothing is reported.
    expect(layoutIds(ws.layout).sort()).toEqual(ws.members.map((m) => m.sessionId).sort());
    expect(store.diagnostics(ws.id)).toEqual([]);
  });

  // ───── Load edge cases ─────

  it('loads v2 format correctly', async () => {
    const dir = runtimeDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'workspaces.json'), JSON.stringify({
      version: 2,
      workspaces: [
        {
          id: 'ws1',
          project: 'myproj',
          name: 'workspace 1',
          layout: { type: 'pane', sessionId: 42 },
          members: [{ sessionId: 42, name: 'lead', role: 'agent', tags: ['ai'], createdAt: 1, updatedAt: 2 }],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    }));

    const store = new WorkspaceStore(dir);
    await store.load();

    const ws = store.get('ws1');
    expect(ws).toBeDefined();
    expect(ws!.project).toBe('myproj');
    expect(ws!.members[0].name).toBe('lead');
    expect(ws!.members[0].role).toBe('agent');
  });

  it('handles missing file gracefully (empty store)', async () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    await store.load();
    expect(store.list()).toEqual([]);
  });

  it('handles corrupted JSON gracefully', async () => {
    const dir = runtimeDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'workspaces.json'), '{invalid json!!!');
    const store = new WorkspaceStore(dir);
    await store.load();
    expect(store.list()).toEqual([]);
  });

  it('handles file with unknown version (no crash, empty store)', async () => {
    const dir = runtimeDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'workspaces.json'), JSON.stringify({ version: 99, workspaces: [] }));
    const store = new WorkspaceStore(dir);
    await store.load();
    expect(store.list()).toEqual([]);
  });

  it('handles file with missing workspaces array', async () => {
    const dir = runtimeDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'workspaces.json'), JSON.stringify({ version: 2 }));
    const store = new WorkspaceStore(dir);
    await store.load();
    expect(store.list()).toEqual([]);
  });

  // ───── Save / debounce ─────

  it('save() writes atomic file (tmp + rename)', async () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    store.create('ws1', 'test', { type: 'pane', sessionId: 1 });
    await store.save();

    const raw = readFileSync(join(dir, 'workspaces.json'), 'utf8');
    const data = JSON.parse(raw);
    expect(data.version).toBe(2);
    expect(data.workspaces).toHaveLength(1);
    expect(data.workspaces[0].id).toBe('ws1');
    // tmp file should not remain
    expect(existsSync(join(dir, 'workspaces.json.tmp'))).toBe(false);
  });

  it('serializes overlapping saves onto a single tmp file path', async () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    store.create('ws1', 'one', { type: 'pane', sessionId: 1 });
    store.create('ws2', 'two', { type: 'pane', sessionId: 2 });

    await Promise.all([store.save(), store.save(), store.save()]);

    const raw = readFileSync(join(dir, 'workspaces.json'), 'utf8');
    const data = JSON.parse(raw);
    expect(data.workspaces.map((workspace: { id: string }) => workspace.id)).toEqual(['ws1', 'ws2']);
    expect(existsSync(join(dir, 'workspaces.json.tmp'))).toBe(false);
  });

  it('scheduleSave batches rapid mutations into a single write', async () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    const saveSpy = vi.spyOn(store, 'save');

    store.create('ws1', 'a', { type: 'pane', sessionId: 1 });
    store.create('ws2', 'b', { type: 'pane', sessionId: 2 });
    store.create('ws3', 'c', { type: 'pane', sessionId: 3 });

    // Wait for microtask to flush
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    // One extra tick to let the save microtask run
    await new Promise((resolve) => setTimeout(resolve, 0));

    // scheduleSave should batch: only 1 save despite 3 creates
    expect(saveSpy).toHaveBeenCalledTimes(1);
    saveSpy.mockRestore();
  });

  it('save persists data that can be reloaded', async () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store1 = new WorkspaceStore(dir);
    store1.create('ws1', 'roundtrip', { type: 'pane', sessionId: 7 }, 'proj');
    await store1.save();

    const store2 = new WorkspaceStore(dir);
    await store2.load();
    const ws = store2.get('ws1');
    expect(ws).toBeDefined();
    expect(ws!.name).toBe('roundtrip');
    expect(ws!.project).toBe('proj');
  });

  // ───── get / delete / list ─────

  it('get returns undefined for non-existing workspace', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    expect(store.get('nope')).toBeUndefined();
  });

  it('delete returns false for non-existing workspace', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    expect(store.delete('nope')).toBe(false);
  });

  it('delete removes workspace and returns true', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    store.create('ws1', 'test', { type: 'pane', sessionId: 1 });
    expect(store.delete('ws1')).toBe(true);
    expect(store.get('ws1')).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it('list returns empty array for fresh store', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    expect(store.list()).toEqual([]);
  });

  // ───── listProjects ─────

  it('listProjects aggregates across multiple projects sorted by name', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    store.create('ws1', 'a', { type: 'pane', sessionId: 1 }, 'bravo');
    store.create('ws2', 'b', {
      type: 'split', axis: 'row', sizes: [0.5, 0.5],
      children: [{ type: 'pane', sessionId: 2 }, { type: 'pane', sessionId: 3 }],
    }, 'alpha');
    store.create('ws3', 'c', { type: 'pane', sessionId: 4 }, 'bravo');

    expect(store.listProjects()).toEqual([
      { name: 'alpha', workspaceCount: 1, memberCount: 2 },
      { name: 'bravo', workspaceCount: 2, memberCount: 2 },
    ]);
  });

  it('listProjects returns empty array for empty store', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    expect(store.listProjects()).toEqual([]);
  });

  // ───── create edge cases ─────

  it('create defaults project to "default" when omitted', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    const ws = store.create('ws1', 'test', { type: 'pane', sessionId: 1 });
    expect(ws.project).toBe('default');
  });

  it('create normalizes workspace with missing members to empty array', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    const ws = store.create('ws1', 'test', { type: 'pane', sessionId: 5 });
    // reconcile should auto-generate member from layout
    expect(ws.members).toHaveLength(1);
    expect(ws.members[0].sessionId).toBe(5);
    expect(ws.members[0].name).toBe('term-1');
  });

  // ───── update edge cases ─────

  it('update returns null for non-existing workspace', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    expect(store.update('nope', { name: 'x' })).toBeNull();
  });

  it('update can change project', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    store.create('ws1', 'test', { type: 'pane', sessionId: 1 }, 'old');
    const updated = store.update('ws1', { project: 'new' });
    expect(updated!.project).toBe('new');
  });

  // ───── addMember edge cases ─────

  it('addMember returns null for non-existing workspace', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    expect(store.addMember('nope', { sessionId: 1, name: 'x' })).toBeNull();
  });

  it('addMember updates existing member when sessionId matches', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    store.create('ws1', 'test', { type: 'pane', sessionId: 0 }, 'proj', []);
    store.addMember('ws1', { sessionId: 50, name: 'first', role: 'agent', tags: ['a'] });
    const ws = store.addMember('ws1', { sessionId: 50, name: 'updated', role: 'executor' });
    // Should not duplicate — still one member with that sessionId
    expect(ws!.members.filter((m) => m.sessionId === 50)).toHaveLength(1);
    expect(ws!.members.find((m) => m.sessionId === 50)!.name).toBe('updated');
    expect(ws!.members.find((m) => m.sessionId === 50)!.role).toBe('executor');
  });

  it('addMember throws on duplicate member name', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    store.create('ws1', 'test', { type: 'pane', sessionId: 0 }, 'proj', []);
    store.addMember('ws1', { sessionId: 50, name: 'lead' });
    expect(() => store.addMember('ws1', { sessionId: 51, name: 'lead' }))
      .toThrow('member name already exists: lead');
  });

  it('addMember is idempotent for same sessionId (no layout duplication)', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    store.create('ws1', 'test', { type: 'pane', sessionId: 0 }, 'proj', []);
    store.addMember('ws1', { sessionId: 60, name: 'worker' });
    const ws = store.addMember('ws1', { sessionId: 60, name: 'worker-v2' });
    // sessionId 60 should appear only once in layout
    const paneCount = JSON.stringify(ws!.layout).split('"sessionId":60').length - 1;
    expect(paneCount).toBe(1);
  });

  // ───── renameMember edge cases ─────

  it('renameMember returns null for non-existing workspace', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    expect(store.renameMember('nope', 1, 'x')).toBeNull();
  });

  it('renameMember returns null for non-existing member', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    store.create('ws1', 'test', { type: 'pane', sessionId: 1 });
    expect(store.renameMember('ws1', 999, 'x')).toBeNull();
  });

  it('renameMember throws on duplicate name', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    store.create('ws1', 'test', {
      type: 'split', axis: 'row', sizes: [0.5, 0.5],
      children: [{ type: 'pane', sessionId: 1 }, { type: 'pane', sessionId: 2 }],
    }, 'proj', [
      { sessionId: 1, name: 'alpha', createdAt: 1, updatedAt: 1 },
      { sessionId: 2, name: 'beta', createdAt: 1, updatedAt: 1 },
    ]);
    expect(() => store.renameMember('ws1', 2, 'alpha')).toThrow('member name already exists: alpha');
  });

  // ───── removeMember edge cases ─────

  it('removeMember returns null for non-existing workspace', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    expect(store.removeMember('nope', 1)).toBeNull();
  });

  it('removeMember produces empty pane when last member removed', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    store.create('ws1', 'test', { type: 'pane', sessionId: 1 });
    const ws = store.removeMember('ws1', 1);
    expect(ws!.members).toEqual([]);
    expect(ws!.layout).toEqual({ type: 'pane', sessionId: 0 });
  });

  // ───── reconcileWorkspace: auto-name collision ─────

  it('reconcile auto-renames members when names collide', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    // Two members with the same name — reconcile should de-dup
    const ws = store.create('ws1', 'test', {
      type: 'split', axis: 'row', sizes: [0.5, 0.5],
      children: [{ type: 'pane', sessionId: 1 }, { type: 'pane', sessionId: 2 }],
    }, 'proj', [
      { sessionId: 1, name: 'dupe', createdAt: 1, updatedAt: 1 },
      { sessionId: 2, name: 'dupe', createdAt: 1, updatedAt: 1 },
    ]);
    const names = ws.members.map((m) => m.name);
    // All names should be unique
    expect(new Set(names).size).toBe(names.length);
  });

  // ───── Layout helpers: empty, single pane, zero-filtered ─────

  it('layout with sessionId 0 is filtered (placeholder pane)', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    // sessionId: 0 is treated as placeholder — should produce no members
    const ws = store.create('ws1', 'test', { type: 'pane', sessionId: 0 });
    expect(ws.members).toEqual([]);
  });

  it('removing all members from a split produces empty pane layout', () => {
    const dir = runtimeDir();
    dirs.push(dir);
    const store = new WorkspaceStore(dir);
    store.create('ws1', 'test', {
      type: 'split', axis: 'row', sizes: [0.5, 0.5],
      children: [{ type: 'pane', sessionId: 10 }, { type: 'pane', sessionId: 20 }],
    });
    store.removeMember('ws1', 10);
    const ws = store.removeMember('ws1', 20)!;
    expect(ws.layout).toEqual({ type: 'pane', sessionId: 0 });
    expect(ws.members).toEqual([]);
  });

  // ───── normalizeWorkspace: missing/null members ─────

  it('load handles workspace with null members field', async () => {
    const dir = runtimeDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'workspaces.json'), JSON.stringify({
      version: 2,
      workspaces: [{
        id: 'ws1', project: 'p', name: 'test',
        layout: { type: 'pane', sessionId: 3 },
        members: null,
        createdAt: 1, updatedAt: 2,
      }],
    }));
    const store = new WorkspaceStore(dir);
    await store.load();
    const ws = store.get('ws1')!;
    // Should auto-generate member from layout
    expect(ws.members).toHaveLength(1);
    expect(ws.members[0].sessionId).toBe(3);
  });
});
