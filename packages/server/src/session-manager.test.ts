import { afterEach, describe, expect, it } from 'vitest';
import { MAX_SESSION_ID, SessionManager, pickSessionId } from './session-manager.js';
import { resolve } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const TEST_RUNTIME_DIR = resolve('/tmp', `ttym-mgr-test-${process.pid}`);
const managers: SessionManager[] = [];

function createManager(): SessionManager {
  const manager = new SessionManager(TEST_RUNTIME_DIR);
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

  it('wraps after 9999 and skips a number whose meta is still on disk', async () => {
    mkdirSync(TEST_RUNTIME_DIR, { recursive: true });
    writeFileSync(resolve(TEST_RUNTIME_DIR, 'next-id'), '9999');
    writeFileSync(resolve(TEST_RUNTIME_DIR, 'meta-1.json'), '{"cwd":"/old"}');
    const manager = createManager();
    await manager.boot();

    const a = await manager.create(['/bin/sh', '-lc', 'stty -echo; exec cat'], 80, 24);
    const b = await manager.create(['/bin/sh', '-lc', 'stty -echo; exec cat'], 80, 24);

    expect([a.id, b.id]).toEqual([9999, 2]);
    expect((await manager.getMeta(2)).cwd).not.toBe('/old');
  });
});

describe('pickSessionId', () => {
  const none = () => false;

  it('takes the next number while there is room', () => {
    expect(pickSessionId(1317, MAX_SESSION_ID, none)).toBe(1317);
  });

  it('never goes past four digits: after 9999 it wraps to 1', () => {
    expect(pickSessionId(9999, MAX_SESSION_ID, none)).toBe(9999);
    expect(pickSessionId(10000, MAX_SESSION_ID, none)).toBe(1);
  });

  it('skips numbers that are still taken, across the wrap', () => {
    const taken = new Set([9998, 9999, 1, 2]);
    expect(pickSessionId(9998, MAX_SESSION_ID, (id) => taken.has(id))).toBe(3);
  });

  it('returns null when every number is taken', () => {
    expect(pickSessionId(5, 10, () => true)).toBeNull();
  });

  it('treats a stray start (0, negative) as 1', () => {
    expect(pickSessionId(0, MAX_SESSION_ID, none)).toBe(1);
  });
});
