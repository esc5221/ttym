import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Session, buildSessionEnv } from './session.js';
import { resolve } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_RUNTIME_DIR = resolve('/tmp', `ttym-test-${process.pid}`);

function waitFor<T>(fn: () => T | undefined, timeoutMs = 15_000, intervalMs = 25): Promise<T> {
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
  it('normalizes child env to prefer color output', () => {
    const previous = {
      NO_COLOR: process.env.NO_COLOR,
      GIT_PAGER: process.env.GIT_PAGER,
      CLICOLOR: process.env.CLICOLOR,
      CLICOLOR_FORCE: process.env.CLICOLOR_FORCE,
      FORCE_COLOR: process.env.FORCE_COLOR,
      COLORTERM: process.env.COLORTERM,
    };
    process.env.NO_COLOR = '1';
    process.env.GIT_PAGER = 'cat';
    delete process.env.CLICOLOR;
    delete process.env.CLICOLOR_FORCE;
    delete process.env.FORCE_COLOR;
    delete process.env.COLORTERM;

    const env = buildSessionEnv();
    expect(env.NO_COLOR).toBeUndefined();
    expect(env.GIT_PAGER).toBeUndefined();
    expect(env.CLICOLOR).toBe('1');
    expect(env.CLICOLOR_FORCE).toBe('1');
    expect(env.FORCE_COLOR).toBe('1');
    expect(env.COLORTERM).toBe('truecolor');

    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('captures output in snapshot and ring', async () => {
    mkdirSync(TEST_RUNTIME_DIR, { recursive: true });
    const session = await Session.create(
      1, ['/bin/sh', '-lc', "printf 'hello\\n'; stty -echo; exec cat"],
      80, 24, TEST_RUNTIME_DIR,
    );
    sessions.push(session);

    // Output goes into headless xterm + ring regardless of viewers
    await waitFor(() => session.snapshot().includes('hello') ? true : undefined);
    // 부트 스코프 랜덤 베이스: 이전 부트의 seq와 수치가 겹칠 수 없게.
    expect(session.ring.baseSeq).toBeGreaterThanOrEqual(1_000_000);
    await waitFor(() => session.ring.nextSeq > session.ring.baseSeq ? true : undefined);

    // viewer가 0명인 동안의 라이브 출력도 ring에 쌓인다 — seq는 화면의 버전
    // 번호라서, 이걸 건너뛰면 화면은 변하는데 버전은 안 변해 재부착한
    // 클라이언트가 낡은 화면을 "최신"으로 믿게 된다. (예전엔 hello가 CREATE
    // 덤프에 실리느냐 라이브 프레임으로 오느냐의 타이밍 복권이었고, 그게
    // 이 테스트의 플레이크였다.)
    const seqBefore = session.ring.nextSeq;
    session.write(Buffer.from('UNWATCHED-LINE\n'));
    await waitFor(() => session.snapshot().includes('UNWATCHED-LINE') ? true : undefined);
    await waitFor(() => session.ring.nextSeq > seqBefore ? true : undefined);
  });

  it('creates sessions under a runtime dir far past sockaddr_un limits', async () => {
    // sockaddr_un은 경로를 ~104바이트로 제한한다. 소켓이 runtime dir 안에
    // 살던 시절엔 깊은 TTYM_RUNTIME_DIR가 holder bind를 panic시켰다 — 지금은
    // 소켓만 /tmp/ttym-<uid>/<해시>/ 네임스페이스로 나가 있어야 한다.
    const deep = resolve(TEST_RUNTIME_DIR,
      'a-very-deeply-nested-runtime-directory-path-segment-one',
      'segment-two-that-pushes-the-total-well-past-one-hundred-and-four-bytes');
    mkdirSync(deep, { recursive: true });
    expect(Buffer.byteLength(deep)).toBeGreaterThan(104);

    const session = await Session.create(
      8, ['/bin/sh', '-lc', "printf 'DEEP-OK\\n'; stty -echo; exec cat"],
      80, 24, deep,
    );
    sessions.push(session);
    await waitFor(() => session.snapshot().includes('DEEP-OK') ? true : undefined);
  });

  it('degraded integrity heals only on a stream-level RIS', async () => {
    mkdirSync(TEST_RUNTIME_DIR, { recursive: true });
    const session = await Session.create(
      7, ['/bin/sh', '-lc', 'stty -echo; exec cat'],
      80, 24, TEST_RUNTIME_DIR,
    );
    sessions.push(session);
    await new Promise((r) => setTimeout(r, 200));

    // gap 복구가 남긴 상태를 재현한다.
    (session as unknown as { _integrity: string })._integrity = 'degraded';
    expect(session.integrity).toBe('degraded');

    // 일반 출력으로는 낫지 않는다 — 화면의 중간이 비어있다는 사실은 그대로다.
    session.write(Buffer.from('plain output\n'));
    await waitFor(() => session.snapshot().includes('plain output') ? true : undefined);
    expect(session.integrity).toBe('degraded');

    // 스트림이 스스로 전체 재도색(RIS)을 하면 그때 낫는다.
    session.write(Buffer.from('\x1bc\n')); // 개행: canonical 모드에서 cat이 내보내게
    await waitFor(() => session.integrity === 'healthy' ? true : undefined);
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
    expect(payload).not.toContain('\x1b[?2026h');
    expect(payload).not.toContain('\x1b[?2026l');
    expect(payload).not.toContain('\x1bc');
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

describe('Session transcript marking', () => {
  it('returns only the rows written after the mark', async () => {
    mkdirSync(TEST_RUNTIME_DIR, { recursive: true });
    const session = await Session.create(
      20, ['/bin/sh', '-lc', 'stty -echo; exec cat'],
      80, 24, TEST_RUNTIME_DIR,
    );
    sessions.push(session);
    await new Promise((r) => setTimeout(r, 200));

    session.write(Buffer.from('BEFORE_MARK\n'));
    await waitFor(() => session.snapshot().includes('BEFORE_MARK') ? true : undefined);

    const mark = session.markCursor();
    expect(mark).not.toBeNull();

    session.write(Buffer.from('AFTER_MARK\n'));
    await waitFor(() => session.snapshot().includes('AFTER_MARK') ? true : undefined);

    const transcript = session.transcriptSince(mark!);
    expect(transcript).not.toBeNull();
    expect(transcript).toContain('AFTER_MARK');
    expect(transcript).not.toContain('BEFORE_MARK');
  });

  it('reports null once the marked row scrolls out of the buffer', async () => {
    mkdirSync(TEST_RUNTIME_DIR, { recursive: true });
    const session = await Session.create(
      21, ['/bin/sh', '-lc', 'stty -echo; exec cat'],
      80, 24, TEST_RUNTIME_DIR,
    );
    sessions.push(session);
    await new Promise((r) => setTimeout(r, 200));

    const mark = session.markCursor()!;
    expect(mark.line).toBeGreaterThanOrEqual(0);

    // Push past the 3000-row scrollback so the marked row is discarded.
    // The session runs `cat`, so write the rows rather than a shell loop.
    const flood = Array.from({ length: 4000 }, (_, i) => `flood ${i}`).join('\n') + '\n';
    session.write(Buffer.from(flood));
    await waitFor(() => mark.line < 0 ? true : undefined, 40_000);

    // A stale index would still be in range and would return unrelated output.
    expect(session.transcriptSince(mark)).toBeNull();
  }, 60_000);
});

describe('buildSessionEnv — parent agent markers', () => {
  it('scrubs the fossilized Claude markers and keeps user config', () => {
    const saved = { ...process.env };
    try {
      process.env.CLAUDECODE = '1';
      process.env.CLAUDE_CODE_CHILD_SESSION = '1';
      process.env.CLAUDE_CODE_SESSION_ID = 'dead-beef';
      process.env.CLAUDE_JOB_DIR = '/tmp/jobs/dead';
      process.env.CLAUDE_PID = '999999';
      process.env.CLAUDE_CODE_MESSAGING_SOCKET = '/tmp/sock';
      process.env.AI_AGENT = 'claude-code_agent';
      process.env.TRACEPARENT = '00-abc';
      // 고정 목록 시절 새어나간 신종들 — 접두사 스크럽이 잡아야 한다.
      process.env.CLAUDE_EFFORT = 'high';
      process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '65';
      process.env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY = '1';
      process.env.CLAUDE_CONFIG_DIR = '/Users/x/.claude-alt'; // 사용자 의도 설정은 보존
      process.env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = '1'; // 명시적 opt-in도 보존

      const env = buildSessionEnv({ TTYM_SESSION_ID: '7', TTYM_PORT: '7691' });
      for (const key of [
        'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID',
        'CLAUDE_JOB_DIR', 'CLAUDE_PID', 'CLAUDE_CODE_MESSAGING_SOCKET',
        'AI_AGENT', 'TRACEPARENT',
        'CLAUDE_EFFORT', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', 'CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY',
      ]) {
        expect(env[key], key).toBeUndefined();
      }
      expect(env.CLAUDE_CONFIG_DIR).toBe('/Users/x/.claude-alt');
      expect(env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE).toBe('1');
      expect(env.TTYM_SESSION_ID).toBe('7');
      expect(env.TTYM_PORT).toBe('7691');
    } finally {
      process.env = saved;
    }
  });
});
