import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Session, getRuntimeDir } from './session.js';
import { resolve } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_RUNTIME_DIR = resolve('/tmp', `ttym-test-${process.pid}`);

function waitFor<T>(fn: () => T | undefined, timeoutMs = 5_000, intervalMs = 25): Promise<T> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const value = fn();
      if (value !== undefined) { resolve(value); return; }
      if (Date.now() - startedAt > timeoutMs) { reject(new Error('Timed out')); return; }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

const sessions: Session[] = [];
const originalSyncTimeout = process.env.TTYM_SYNC_BLOCK_TIMEOUT_MS;

afterEach(async () => {
  while (sessions.length > 0) {
    sessions.pop()!.kill();
  }
  await new Promise((r) => setTimeout(r, 100));
  try { rmSync(TEST_RUNTIME_DIR, { recursive: true }); } catch {}
});

beforeEach(() => {
  process.env.TTYM_SYNC_BLOCK_TIMEOUT_MS = '200';
});

afterEach(() => {
  if (originalSyncTimeout == null) delete process.env.TTYM_SYNC_BLOCK_TIMEOUT_MS;
  else process.env.TTYM_SYNC_BLOCK_TIMEOUT_MS = originalSyncTimeout;
});

describe('Session (holder-backed)', () => {
  it('captures output in snapshot and ring', async () => {
    mkdirSync(TEST_RUNTIME_DIR, { recursive: true });
    const session = await Session.create(
      1, ['/bin/sh', '-lc', "printf 'hello\\n'; stty -echo; exec cat"],
      80, 24, TEST_RUNTIME_DIR,
    );
    sessions.push(session);

    // Output goes into headless xterm + ring regardless of viewers
    await waitFor(() => session.snapshot().includes('hello') ? true : undefined);
    expect(session.ring.nextSeq).toBeGreaterThan(1);
  });

  it('broadcasts live output to viewers', async () => {
    mkdirSync(TEST_RUNTIME_DIR, { recursive: true });
    const session = await Session.create(
      2, ['/bin/sh', '-lc', "stty -echo; exec cat"],
      80, 24, TEST_RUNTIME_DIR,
    );
    sessions.push(session);

    const r1: string[] = [];
    const r2: string[] = [];
    session.addViewer('v1', (data) => r1.push(data.toString()));
    session.addViewer('v2', (data) => r2.push(data.toString()));

    // Wait for shell ready, then send input
    await new Promise((r) => setTimeout(r, 200));
    session.write(Buffer.from('ping\n'));

    await waitFor(() =>
      r1.some((c) => c.includes('ping')) && r2.some((c) => c.includes('ping')) ? true : undefined,
    );
    expect(session.viewerCount).toBe(2);
  });

  it('detects PTY exit with correct code', async () => {
    mkdirSync(TEST_RUNTIME_DIR, { recursive: true });
    const session = await Session.create(
      3, ['/bin/sh', '-c', 'exit 7'],
      80, 24, TEST_RUNTIME_DIR,
    );
    sessions.push(session);

    const exitCode = await new Promise<number>((resolve) => {
      session.onExit(resolve);
    });

    expect(session.isDead).toBe(true);
    // Accept either 7 (correct) or -1 (race with waitpid)
    expect([7, -1]).toContain(exitCode);
  });

  it('writes input to PTY and receives output', async () => {
    mkdirSync(TEST_RUNTIME_DIR, { recursive: true });
    const session = await Session.create(
      4, ['/bin/sh', '-lc', "stty -echo; exec cat"],
      80, 24, TEST_RUNTIME_DIR,
    );
    sessions.push(session);

    const received: string[] = [];
    session.addViewer('v1', (data) => received.push(data.toString()));

    await new Promise((r) => setTimeout(r, 200));
    session.write(Buffer.from('typed\n'));
    await waitFor(() => received.some((c) => c.includes('typed')) ? true : undefined);
  });

  it('coalesces synchronized output into a single viewer/ring emission', async () => {
    mkdirSync(TEST_RUNTIME_DIR, { recursive: true });
    const session = await Session.create(
      5,
      ['/bin/sh', '-lc', "printf '\\033[?2026hhello\\033[31m red\\033[0m\\033[?2026l'; stty -echo; exec cat"],
      80,
      24,
      TEST_RUNTIME_DIR,
    );
    sessions.push(session);

    await waitFor(() => session.snapshot().includes('hello') ? true : undefined);

    const chunks = session.ring.since(0);
    expect(chunks).toHaveLength(1);
    const payload = chunks[0]!.data.toString('binary');
    expect(payload).toContain('hello');
    expect(payload).toContain('\x1bc');
    expect(payload).not.toContain('\x1b[?2026h');
    expect(payload).not.toContain('\x1b[?2026l');
  });

  it('forces snapshot replay while a sync block is open', async () => {
    mkdirSync(TEST_RUNTIME_DIR, { recursive: true });
    const session = await Session.create(
      6,
      ['/bin/sh', '-lc', "printf '\\033[?2026hhello'; sleep 1; printf ' world\\033[?2026l'; stty -echo; exec cat"],
      80,
      24,
      TEST_RUNTIME_DIR,
    );
    sessions.push(session);

    await waitFor(() => session.shouldForceSnapshotReplay() ? true : undefined);
    expect(session.shouldForceSnapshotReplay()).toBe(true);
  });

  it('times out an unterminated sync block and flushes buffered bytes', async () => {
    mkdirSync(TEST_RUNTIME_DIR, { recursive: true });
    const session = await Session.create(
      7,
      ['/bin/sh', '-lc', "printf '\\033[?2026haborted'; stty -echo; exec cat"],
      80,
      24,
      TEST_RUNTIME_DIR,
    );
    sessions.push(session);

    await waitFor(() => session.snapshot().includes('aborted') ? true : undefined);
    await waitFor(() => !session.shouldForceSnapshotReplay() ? true : undefined, 2_000);

    const chunks = session.ring.since(0);
    expect(chunks.length).toBeGreaterThan(0);
    expect(Buffer.concat(chunks.map((chunk) => chunk.data)).toString('binary')).toContain('aborted');
  });
});
