import { afterEach, describe, expect, it } from 'vitest';
import { Session } from './session.js';

function waitFor<T>(fn: () => T | undefined, timeoutMs = 5_000, intervalMs = 25): Promise<T> {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const tick = () => {
      const value = fn();
      if (value !== undefined) {
        resolve(value);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('Timed out waiting for condition'));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function createEchoSession(id: number, initial = 'ready'): Session {
  return new Session(id, ['/bin/sh', '-lc', `printf '${initial}\\n'; stty -echo; exec cat`], 80, 24);
}

const sessions: Session[] = [];

afterEach(() => {
  while (sessions.length > 0) {
    sessions.pop()!.kill();
  }
});

describe('Session', () => {
  it('captures PTY output in the ring and snapshot', async () => {
    const session = createEchoSession(1, 'hello');
    sessions.push(session);

    await waitFor(() => session.snapshot().includes('hello') ? true : undefined);

    expect(session.ring.nextSeq).toBeGreaterThan(1);
    expect(session.snapshot()).toContain('hello');
    expect(session.info().lastSeq).toBe(session.ring.nextSeq - 1);
  });

  it('keeps buffering while detached and resumes delivery when reattached', async () => {
    const session = createEchoSession(2, 'boot');
    sessions.push(session);

    const received: string[] = [];
    session.addViewer('v1', (data: Buffer) => {
      received.push(data.toString());
    });

    await waitFor(() => received.some((chunk) => chunk.includes('boot')) ? true : undefined);

    session.write(Buffer.from('alpha\n'));
    await waitFor(() => received.some((chunk) => chunk.includes('alpha')) ? true : undefined);

    const beforeDetachCount = received.length;
    const beforeDetachSeq = session.ring.nextSeq;

    session.removeViewer('v1');
    session.write(Buffer.from('beta\n'));

    await waitFor(() => session.ring.nextSeq > beforeDetachSeq ? true : undefined);
    expect(received).toHaveLength(beforeDetachCount);

    session.addViewer('v2', (data: Buffer) => {
      received.push(data.toString());
    });
    session.write(Buffer.from('gamma\n'));

    await waitFor(() => received.some((chunk) => chunk.includes('gamma')) ? true : undefined);
    expect(session.status).toBe('attached');
  });

  it('transitions to dead on exit and notifies exit listeners', async () => {
    const session = new Session(3, ['/bin/sh', '-lc', 'exit 7'], 80, 24);
    sessions.push(session);

    const exitCode = await new Promise<number>((resolve) => {
      session.onExit(resolve);
    });

    expect(exitCode).toBe(7);
    expect(session.status).toBe('dead');
    expect(session.isDead).toBe(true);
  });

  it('broadcasts to multiple viewers', async () => {
    const session = createEchoSession(4, 'multi');
    sessions.push(session);

    const received1: string[] = [];
    const received2: string[] = [];

    session.addViewer('v1', (data: Buffer) => received1.push(data.toString()));
    session.addViewer('v2', (data: Buffer) => received2.push(data.toString()));

    await waitFor(() =>
      received1.some((c) => c.includes('multi')) && received2.some((c) => c.includes('multi'))
        ? true
        : undefined,
    );

    expect(session.viewerCount).toBe(2);
  });

  it('paused viewer does not receive output', async () => {
    const session = createEchoSession(5, 'pause');
    sessions.push(session);

    const received: string[] = [];
    session.addViewer('v1', (data: Buffer) => received.push(data.toString()));

    await waitFor(() => received.some((c) => c.includes('pause')) ? true : undefined);

    session.pauseViewer('v1');
    const countBefore = received.length;
    session.write(Buffer.from('hidden\n'));

    // Wait for ring to advance (output happened but viewer didn't get it)
    const seqBefore = session.ring.nextSeq;
    await waitFor(() => session.ring.nextSeq > seqBefore ? true : undefined);
    expect(received).toHaveLength(countBefore);

    session.resumeViewer('v1');
    session.write(Buffer.from('visible\n'));
    await waitFor(() => received.some((c) => c.includes('visible')) ? true : undefined);
  });
});
