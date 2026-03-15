import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore } from './workspace-store.js';

function runtimeDir() {
  return mkdtempSync(join(tmpdir(), 'ttym-ws-store-'));
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
});
