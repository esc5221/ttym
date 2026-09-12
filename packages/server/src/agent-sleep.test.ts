import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSleeper, findAgentProcess, isPassiveInput, parseSleepAfter, resumeArgsFrom, type ProcInfo, type SleepState } from './agent-sleep.js';
import type { Session } from './session.js';

/**
 * The sleeper against a stand-in session and a scripted process table.
 * What matters: the order of writes to the shell, that input never reaches
 * the shell while asleep but comes out in order once awake, that viewers
 * are frozen and re-snapshotted, and every refusal.
 */

const SHELL = 100;
const AGENT = 101;
const claudeProc = (rss = 300 * 1048576): ProcInfo => ({ pid: AGENT, ppid: SHELL, rss, command: '/Users/x/.local/share/claude/versions/2.1.269 --dangerously-skip-permissions' });

class FakeSession {
  id: number;
  childPid = SHELL;
  isDead = false;
  inputGate: ((data: Buffer) => boolean) | null = null;
  lastInputAt = 0;
  lastOutputAt = 0;
  frozen: { snapshot: string; seq: number } | null = null;
  writes: string[] = [];   // through write() — user input
  raw: string[] = [];      // through writeRaw() — the sleeper's own commands
  resyncs = 0;
  screen = 'claude screen';
  constructor(id: number) { this.id = id; }
  write(data: Buffer) { if (this.inputGate && this.inputGate(data)) return; this.lastInputAt = Date.now(); this.writes.push(data.toString('latin1')); }
  writeRaw(data: Buffer) { this.raw.push(data.toString('latin1')); }
  viewerSnapshot() { return this.screen; }
  freeze(snapshot?: string) { this.frozen = { snapshot: snapshot ?? this.screen, seq: 7 }; }
  thaw() { this.frozen = null; }
  get isFrozen() { return this.frozen !== null; }
  frozenView() { return this.frozen; }
  resyncAll() { this.resyncs++; }
  /** Output arriving from the PTY (only the clock matters here). */
  output() { this.lastOutputAt = Date.now(); }
}

function harness(opts: { procs?: () => ProcInfo[]; meta?: Record<string, unknown>; pending?: boolean; config?: Record<string, string> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ttym-sleep-'));
  const session = new FakeSession(1);
  const metas = new Map<number, Record<string, unknown>>([[1, { claudeLastSessionId: 'abc-123', ...(opts.meta ?? {}) }]]);
  const events: Array<{ id: number; sleep: SleepState | null; pin: boolean }> = [];
  const killed: Array<{ pid: number; signal: string }> = [];
  let procs = opts.procs ?? (() => [claudeProc()]);
  const logs: string[] = [];
  const sleeper = new AgentSleeper({
    sessions: {
      get: (id) => (id === 1 ? (session as unknown as Session) : undefined),
      ids: () => [1],
      getMeta: async (id) => metas.get(id) ?? {},
      setMeta: async (id, patch) => { metas.set(id, { ...(metas.get(id) ?? {}), ...patch }); },
    },
    hasPendingInteraction: () => opts.pending === true,
    listProcesses: async () => procs(),
    kill: (pid, signal) => killed.push({ pid, signal }),
    onState: (id, sleep, pin) => events.push({ id, sleep, pin }),
    resnapshot: () => session.resyncAll(),
    port: 7692,
    runtimeDir: dir,
    log: (m) => logs.push(m),
    timeScale: 0.01, // 250 ms → 2.5 ms
  });
  sleeper.configure(opts.config ?? {});
  return {
    dir, session, sleeper, events, killed, logs,
    meta: () => metas.get(1)!,
    setProcs: (f: () => ProcInfo[]) => { procs = f; },
    /** The pane's Claude came up: what the SessionStart hook does. */
    agentStarted: () => { sleeper.noteAgentStart(1); session.output(); },
    cleanup: () => { sleeper.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe('helpers', () => {
  it('parses the idle window like map-interval: minutes by default, under a minute is off', () => {
    expect(parseSleepAfter('30m')).toBe(30 * 60_000);
    expect(parseSleepAfter('2h')).toBe(2 * 3600_000);
    expect(parseSleepAfter('90s')).toBe(90_000);
    expect(parseSleepAfter('45')).toBe(45 * 60_000);
    expect(parseSleepAfter('0')).toBe(0);
    expect(parseSleepAfter('30s')).toBe(0);
    expect(parseSleepAfter(undefined)).toBe(0);
    expect(parseSleepAfter('soon')).toBe(0);
  });

  it('finds the agent as a child or grandchild of the shell, by the command path', () => {
    const procs: ProcInfo[] = [
      { pid: SHELL, ppid: 1, rss: 1, command: '/bin/zsh' },
      { pid: 200, ppid: SHELL, rss: 1, command: 'node /Users/x/.local/bin/ttym agent resume claude' },
      { pid: 201, ppid: 200, rss: 5, command: '/Users/x/.local/share/cc-fixer/patched/claude-2.1.267 --resume abc' },
      { pid: 300, ppid: 1, rss: 9, command: 'claude --dangerously-skip-permissions' },
    ];
    expect(findAgentProcess(procs, SHELL)).toMatchObject({ pid: 201, kind: 'claude' });
    expect(findAgentProcess(procs, 999)).toBeNull();
    expect(findAgentProcess([{ pid: 5, ppid: SHELL, rss: 1, command: 'codex --full-auto' }], SHELL)).toMatchObject({ kind: 'codex' });
    // A path that merely contains the word inside a folder name still counts (that is how the versioned binaries look).
    expect(findAgentProcess([{ pid: 6, ppid: SHELL, rss: 1, command: '/Users/x/.local/share/claude/versions/2.1.269' }], SHELL)).toMatchObject({ kind: 'claude' });
    expect(findAgentProcess([{ pid: 7, ppid: SHELL, rss: 1, command: '/usr/bin/vim notes-about-claude.md' }], SHELL)).toBeNull();
  });

  it('resume gets the flags the agent ran with, minus the ones that name a session', () => {
    expect(resumeArgsFrom('/x/claude --dangerously-skip-permissions --model opus')).toEqual(['--dangerously-skip-permissions', '--model', 'opus']);
    expect(resumeArgsFrom('claude --resume abc --dangerously-skip-permissions')).toEqual(['--dangerously-skip-permissions']);
    expect(resumeArgsFrom('claude -c')).toEqual([]);
    expect(resumeArgsFrom('claude --session-id x -r y --verbose')).toEqual(['--verbose']);
    expect(resumeArgsFrom('claude')).toEqual([]);
  });

  it('focus reports and mouse events are passive; keys are not', () => {
    expect(isPassiveInput(Buffer.from('\x1b[I'))).toBe(true);
    expect(isPassiveInput(Buffer.from('\x1b[O\x1b[I'))).toBe(true);
    expect(isPassiveInput(Buffer.from('\x1b[<64;10;5M'))).toBe(true);
    expect(isPassiveInput(Buffer.from('a'))).toBe(false);
    expect(isPassiveInput(Buffer.from('\r'))).toBe(false);
    expect(isPassiveInput(Buffer.from('\x1b[A'))).toBe(false); // arrow key
    expect(isPassiveInput(Buffer.from(''))).toBe(false);
  });
});

describe('sleep', () => {
  let h: ReturnType<typeof harness>;
  afterEach(() => h.cleanup());

  it('freezes the screen, then Ctrl-C · /exit · CR, and records the state once the process is gone', async () => {
    let alive = true;
    h = harness({ procs: () => (alive ? [claudeProc(256 * 1048576)] : []) });
    // The agent exits on /exit: drop it from the table once the CR is written.
    const origRaw = h.session.writeRaw.bind(h.session);
    h.session.writeRaw = (d) => { origRaw(d); if (d.toString('latin1') === '\r') alive = false; };

    const r = await h.sleeper.sleep(1, 'manual');
    expect(r).toEqual({ ok: true });
    expect(h.session.raw).toEqual(['\x03', '/exit', '\r']);
    expect(h.session.isFrozen).toBe(true);
    expect(h.session.frozen!.snapshot).toBe('claude screen');
    expect(existsSync(join(h.dir, 'sleep-1.ansi'))).toBe(true);
    expect(h.meta().agentSleep).toMatchObject({ state: 'sleeping', agentSessionId: 'abc-123', rssBefore: 256 * 1048576, reason: 'manual' });
    expect(h.events.at(-1)).toMatchObject({ sleep: { state: 'sleeping' }, pin: false });
    expect(h.killed).toEqual([]);
  });

  it('escalates to SIGTERM then SIGKILL when /exit is ignored, and gives up cleanly if even that fails', async () => {
    h = harness();
    const r = await h.sleeper.sleep(1, 'manual');
    expect(r).toEqual({ ok: false, error: 'agent did not exit' });
    expect(h.killed.map((k) => k.signal)).toEqual(['SIGTERM', 'SIGKILL']);
    // Undone: the agent is still there, so the pane behaves as before.
    expect(h.session.isFrozen).toBe(false);
    expect(h.session.inputGate).toBeNull();
    expect(h.meta().agentSleep).toBeNull();
    expect(h.events.at(-1)!.sleep).toBeNull();
  });

  it('refuses mid-turn, with a pending interaction, when pinned, without a process, without a session id', async () => {
    h = harness({ meta: { claudeTurnOpen: true } });
    expect(await h.sleeper.sleep(1, 'manual')).toEqual({ ok: false, error: 'agent is mid-turn' });
    h.cleanup();
    h = harness({ pending: true });
    expect(await h.sleeper.sleep(1, 'manual')).toEqual({ ok: false, error: 'an interaction is pending' });
    h.cleanup();
    h = harness({ meta: { agentPin: true } });
    expect(await h.sleeper.sleep(1, 'manual')).toEqual({ ok: false, error: 'pinned awake' });
    h.cleanup();
    h = harness({ procs: () => [] });
    expect(await h.sleeper.sleep(1, 'manual')).toEqual({ ok: false, error: 'no agent process under this pane' });
    h.cleanup();
    h = harness({ meta: { claudeLastSessionId: null } });
    expect(await h.sleeper.sleep(1, 'manual')).toEqual({ ok: false, error: 'no claude session id to resume from' });
    expect(h.session.isFrozen).toBe(false);
  });

  it('a freshly started agent (SessionStart says active, no turn yet) may sleep', async () => {
    let alive = true;
    h = harness({ meta: { claudeActive: true, claudeSource: 'startup' }, procs: () => (alive ? [claudeProc()] : []) });
    const origRaw = h.session.writeRaw.bind(h.session);
    h.session.writeRaw = (d) => { origRaw(d); if (d.toString('latin1') === '\r') alive = false; };
    expect(await h.sleeper.sleep(1, 'manual')).toEqual({ ok: true });
  });

  it('codex is recognised but not slept yet', async () => {
    h = harness({ procs: () => [{ pid: AGENT, ppid: SHELL, rss: 1, command: 'codex' }] });
    expect(await h.sleeper.sleep(1, 'manual')).toEqual({ ok: false, error: 'codex: not supported yet' });
  });
});

describe('wake', () => {
  let h: ReturnType<typeof harness>;
  afterEach(() => h.cleanup());

  async function asleep() {
    let alive = true;
    h = harness({ procs: () => (alive ? [claudeProc()] : []) });
    const origRaw = h.session.writeRaw.bind(h.session);
    h.session.writeRaw = (d) => { origRaw(d); if (d.toString('latin1') === '\r' && alive) alive = false; };
    expect(await h.sleeper.sleep(1, 'manual')).toEqual({ ok: true });
    h.session.raw = [];
    return { setAlive: (v: boolean) => { alive = v; } };
  }

  it('the first key queues, resumes through the CLI, and is written once the agent is up and quiet', async () => {
    await asleep();
    h.session.write(Buffer.from('hel'));
    h.session.write(Buffer.from('lo\r'));
    expect(h.session.writes).toEqual([]);                          // nothing reached the shell
    await tick(5);
    expect(h.session.raw).toEqual(['\x15', 'PORT=7692 ttym agent resume claude --dangerously-skip-permissions\r']);
    expect(h.meta().agentSleep).toMatchObject({ state: 'waking' });
    expect(h.session.isFrozen).toBe(true);                         // still frozen while the shell echoes
    // Input during the wake queues too.
    h.session.write(Buffer.from(' more'));
    h.agentStarted();
    await tick(60);
    expect(h.session.isFrozen).toBe(false);
    expect(h.session.resyncs).toBe(1);
    expect(h.session.writes).toEqual(['hel', 'lo\r', ' more']);   // in order, after the resync
    expect(h.session.inputGate).toBeNull();
    expect(h.meta().agentSleep).toBeNull();
    expect(existsSync(join(h.dir, 'sleep-1.ansi'))).toBe(false);
    expect(h.events.at(-1)!.sleep).toBeNull();
  });

  it('passive input (focus, mouse) neither wakes nor queues', async () => {
    await asleep();
    h.session.write(Buffer.from('\x1b[I'));
    h.session.write(Buffer.from('\x1b[<64;3;3M'));
    await tick(5);
    expect(h.session.raw).toEqual([]);
    expect(h.meta().agentSleep).toMatchObject({ state: 'sleeping' });
  });

  it('a manual wake with nothing queued just resumes', async () => {
    await asleep();
    const p = h.sleeper.wake(1, 'manual');
    await tick(5);
    h.agentStarted();
    expect(await p).toEqual({ ok: true });
    expect(h.session.writes).toEqual([]);
    expect(h.session.resyncs).toBe(1);
  });

  it('a resume that never starts is reported as failed, the pane is thawed so the shell is visible, the queue is dropped', async () => {
    await asleep();
    h.session.screen = 'zsh: command not found: claude\n~ ❯';
    h.session.write(Buffer.from('x'));
    // Wait past the 10 s (scaled) no-start window; no SessionStart arrives, no process appears.
    await tick(200);
    expect(h.meta().agentSleep).toMatchObject({ state: 'failed' });
    expect(String((h.meta().agentSleep as SleepState).error)).toContain('resume did not start');
    expect(String((h.meta().agentSleep as SleepState).error)).toContain('command not found');
    expect(h.session.isFrozen).toBe(false);
    expect(h.session.resyncs).toBe(1);
    expect(h.session.inputGate).toBeNull();
    expect(h.session.writes).toEqual([]);
    // A failed pane refuses a second wake and points at restore.
    expect(await h.sleeper.wake(1)).toEqual({ ok: false, error: 'resume failed earlier; use restore' });
  });
});

describe('auto sleep', () => {
  let h: ReturnType<typeof harness>;
  afterEach(() => h.cleanup());

  it('off by default: an idle pane is never touched', async () => {
    h = harness();
    expect(await h.sleeper.sleep(1, 'idle')).toEqual({ ok: false, error: 'auto-sleep is off (agent-sleep-after)' });
  });

  it('with a window set, sleeps only once input and output are both older than it', async () => {
    let alive = true;
    h = harness({ procs: () => (alive ? [claudeProc()] : []), config: { 'agent-sleep-after': '1m' } });
    const origRaw = h.session.writeRaw.bind(h.session);
    h.session.writeRaw = (d) => { origRaw(d); if (d.toString('latin1') === '\r') alive = false; };
    h.session.lastInputAt = Date.now();
    h.session.lastOutputAt = Date.now() - 120_000;
    expect(await h.sleeper.sleep(1, 'idle')).toEqual({ ok: false, error: 'input too recent' });
    h.session.lastInputAt = Date.now() - 120_000;
    h.session.lastOutputAt = Date.now();
    expect(await h.sleeper.sleep(1, 'idle')).toEqual({ ok: false, error: 'output too recent' });
    h.session.lastOutputAt = Date.now() - 120_000;
    expect(await h.sleeper.sleep(1, 'idle')).toEqual({ ok: true });
    expect(h.meta().agentSleep).toMatchObject({ reason: 'idle' });
  });

  it('a pane with no recorded activity counts from the sleeper boot, not from zero', async () => {
    h = harness({ config: { 'agent-sleep-after': '1m' } });
    expect(await h.sleeper.sleep(1, 'idle')).toEqual({ ok: false, error: 'input too recent' });
  });
});

describe('restart', () => {
  let h: ReturnType<typeof harness>;
  afterEach(() => h.cleanup());

  it('a sleeping pane comes back frozen on its saved screen with the gate installed; a mid-wake pane goes back to sleeping', async () => {
    let alive = true;
    h = harness({ procs: () => (alive ? [claudeProc()] : []) });
    const origRaw = h.session.writeRaw.bind(h.session);
    h.session.writeRaw = (d) => { origRaw(d); if (d.toString('latin1') === '\r') alive = false; };
    expect(await h.sleeper.sleep(1, 'manual')).toEqual({ ok: true });
    const saved = { ...(h.meta().agentSleep as SleepState), state: 'waking' as const };

    // "Restart": a new sleeper over the same dir and meta, a fresh session object.
    const session2 = new FakeSession(1);
    session2.screen = 'shell prompt after restart';
    const metas = new Map([[1, { claudeLastSessionId: 'abc-123', agentSleep: saved }]]);
    const sleeper2 = new AgentSleeper({
      sessions: { get: () => session2 as unknown as Session, ids: () => [1], getMeta: async () => metas.get(1)!, setMeta: async (_id, p) => { metas.set(1, { ...metas.get(1)!, ...p }); } },
      hasPendingInteraction: () => false, listProcesses: async () => [], kill: () => {}, onState: () => {}, resnapshot: () => {},
      port: 7692, runtimeDir: h.dir, log: () => {}, timeScale: 0.01,
    });
    await sleeper2.restore();
    expect(session2.isFrozen).toBe(true);
    expect(session2.frozen!.snapshot).toBe('claude screen');        // the saved screen, not the shell
    expect(session2.inputGate).not.toBeNull();
    expect(metas.get(1)!.agentSleep).toMatchObject({ state: 'sleeping' });
    const st = await sleeper2.status();
    expect(st.sleeping).toHaveLength(1);
    expect(st.reclaimedBytes).toBe(300 * 1048576);
    sleeper2.stop();
  });
});
