import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from './session-manager.js';
import { resolve } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_RUNTIME_DIR = resolve('/tmp', `ttym-mgr-test-${process.pid}`);
const managers: SessionManager[] = [];

function createManager(detachedTtl?: number): SessionManager {
  const manager = new SessionManager(TEST_RUNTIME_DIR, detachedTtl);
  managers.push(manager);
  return manager;
}

afterEach(async () => {
  while (managers.length > 0) {
    managers.pop()!.destroyAll();
  }
  await new Promise((r) => setTimeout(r, 200));
  try { rmSync(TEST_RUNTIME_DIR, { recursive: true }); } catch {}
});

describe('SessionManager', () => {
  it('creates sessions and lists them', async () => {
    const manager = createManager();
    await manager.boot();

    const session = await manager.create(['/bin/sh', '-lc', 'stty -echo; exec cat'], 80, 24);

    expect(manager.has(session.id)).toBe(true);
    expect(manager.list().map((e) => e.id)).toEqual([session.id]);
  });

  it('detaches viewer and marks session detached', async () => {
    const manager = createManager();
    await manager.boot();

    const session = await manager.create(['/bin/sh', '-lc', 'stty -echo; exec cat'], 80, 24);
    session.addViewer('v1', () => {});

    manager.detachViewer('v1', new Set([session.id]));
    expect(session.status).toBe('detached');
  });

  it('destroys all sessions', async () => {
    const manager = createManager();
    await manager.boot();

    const s1 = await manager.create(['/bin/sh', '-lc', 'stty -echo; exec cat'], 80, 24);
    const s2 = await manager.create(['/bin/sh', '-lc', 'stty -echo; exec cat'], 80, 24);

    manager.destroyAll();

    expect(manager.has(s1.id)).toBe(false);
    expect(manager.has(s2.id)).toBe(false);
  });
});
