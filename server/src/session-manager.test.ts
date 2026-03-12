import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from './session-manager.js';

const managers: SessionManager[] = [];

function createManager(detachedTtl?: number): SessionManager {
  const manager = new SessionManager(detachedTtl);
  managers.push(manager);
  return manager;
}

afterEach(() => {
  while (managers.length > 0) {
    managers.pop()!.destroyAll();
  }
});

describe('SessionManager', () => {
  it('creates sessions, lists live sessions, and detaches viewers', () => {
    const manager = createManager();
    const session = manager.create(['/bin/sh', '-lc', 'stty -echo; exec cat'], 80, 24);

    session.addViewer('v1', () => {});

    expect(manager.has(session.id)).toBe(true);
    expect(manager.list().map((entry) => entry.id)).toEqual([session.id]);

    manager.detachViewer('v1', new Set([session.id]));

    expect(session.status).toBe('detached');
    expect(manager.list()).toHaveLength(1);
  });

  it('reaps detached sessions whose TTL has expired', () => {
    const manager = createManager(5);
    const session = manager.create(['/bin/sh', '-lc', 'stty -echo; exec cat'], 80, 24);

    session.addViewer('v1', () => {});
    session.removeViewer('v1');
    (session as any)._detachedAt = Date.now() - 10;

    (manager as any).reap();

    expect(manager.has(session.id)).toBe(false);
  });

  it('destroys all sessions and stops tracking them', () => {
    const manager = createManager();
    const first = manager.create(['/bin/sh', '-lc', 'stty -echo; exec cat'], 80, 24);
    const second = manager.create(['/bin/sh', '-lc', 'stty -echo; exec cat'], 80, 24);

    manager.destroyAll();

    expect(manager.has(first.id)).toBe(false);
    expect(manager.has(second.id)).toBe(false);
    expect(manager.list()).toEqual([]);
  });

  it('detachViewer only removes the specified viewer, not others', () => {
    const manager = createManager();
    const session = manager.create(['/bin/sh', '-lc', 'stty -echo; exec cat'], 80, 24);

    session.addViewer('v1', () => {});
    session.addViewer('v2', () => {});

    manager.detachViewer('v1', new Set([session.id]));

    expect(session.viewerCount).toBe(1);
    expect(session.hasViewer('v2')).toBe(true);
    expect(session.status).toBe('attached');
  });
});
