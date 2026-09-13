/**
 * Agent sleep: put an idle Claude Code or Codex down, bring it back on the first key.
 *
 * A Claude Code process holds 200–600 MB whether or not anyone is talking to
 * it; 37 of them on one machine were 10 GB of swap. What a later `--resume`
 * needs is not the process but the session id, and ttym already has that
 * (the hooks write claudeLastSessionId every turn). So:
 *
 *   sleep   Ctrl-C ×3 to the agent (its own exit path, no transcript entry —
 *           /exit would be replayed as a turn on every resume); the shell
 *           underneath stays; viewers are frozen on the agent's last screen
 *           so the shell prompt never shows.
 *   wake    the first input (a key, `ttym send`, an await) is queued, not
 *           written; `ttym agent resume` runs in the shell; when the agent's
 *           SessionStart hook has fired and output has settled, viewers get
 *           a fresh snapshot and the queue is written in order.
 *
 * Never slept: anything Claude Code reports as alive (see whyBusy — a
 * background task, a scheduled wakeup, a permission prompt), a pending
 * interaction, output or input within the idle window. Auto-sleep is off
 * until `agent-sleep-after` is set.
 *
 * Process facts come from `ps`, not from the hooks: the Stop hook clears
 * claudeSessionId every turn, so "is there an agent" is a process-tree
 * question — the agent is a child (or grandchild, via `ttym agent resume`)
 * of the pane's shell.
 */
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Session } from './session.js';

export type SleepPhase = 'sleeping' | 'waking' | 'failed';
export type AgentKind = 'claude' | 'codex';
export interface SleepState {
  state: SleepPhase;
  since: number;
  agent: AgentKind;
  /** The agent's own session id — what `resume` will use. */
  agentSessionId: string;
  rssBefore: number;
  reason: 'idle' | 'manual';
  /** The flags the agent was running with (from its argv), passed again on resume. */
  args?: string[];
  error?: string;
  /** Bytes of input waiting to be written once awake (waking only). */
  queued?: number;
}

export interface ProcInfo { pid: number; ppid: number; rss: number; command: string }

/** ~/.claude/sessions/<pid>.json — written by Claude Code for `claude ps`. `waiting` names a permission prompt or dialog. */
export interface AgentStatusFile { status: 'busy' | 'idle' | 'waiting'; waitingFor?: string; updatedAt?: number }

/** What the Stop hook forwarded from Claude Code's payload; null on versions that do not send it. */
export interface InFlight {
  tasks: Array<{ type: string; status?: string; description?: string }>;
  crons: Array<{ schedule: string; recurring: boolean; prompt?: string }>;
  at: number;
}

export interface SleeperDeps {
  sessions: {
    get(id: number): Session | undefined;
    ids(): number[];
    getMeta(id: number): Promise<Record<string, unknown>>;
    setMeta(id: number, patch: Record<string, unknown>): Promise<unknown>;
  };
  hasPendingInteraction(sessionId: number): boolean;
  listProcesses(): Promise<ProcInfo[]>;
  /** Claude Code's own status for a process (~/.claude/sessions/<pid>.json), or null when absent. */
  agentStatus(pid: number): Promise<AgentStatusFile | null>;
  kill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  /** Push the new state to clients (null = awake). */
  onState(sessionId: number, sleep: SleepState | null): void;
  /** Send every viewer of the session a fresh snapshot (after thaw). */
  resnapshot(sessionId: number): void;
  /** Port the pane's `ttym` must talk to — stamped into the resume command. */
  port: number;
  runtimeDir: string;
  log: (msg: string) => void;
  now?: () => number;
  /** Scales every internal delay; tests set it small. */
  timeScale?: number;
}

export const AGENT_RE = /(^|\/)(claude|codex)(\b|[-.\/])/;

/** What differs per agent: where its session id lives, and what resume needs on top of the agent's own flags. */
const KINDS: Record<AgentKind, { idKey: string; lastKey: string; resumeExtra: string[] }> = {
  claude: { idKey: 'claudeSessionId', lastKey: 'claudeLastSessionId', resumeExtra: [] },
  // Codex resume opens an "Update available?" dialog when one is out; the first
  // queued key would answer it (1 = run brew). The check is a config switch.
  codex: { idKey: 'codexSessionId', lastKey: 'codexLastSessionId', resumeExtra: ['-c', 'check_for_update_on_startup=false'] },
};
export const TICK_MS = 60_000;
const SLEEP_BATCH = 3;
const QUEUE_MAX_BYTES = 64 * 1024;

/** Auto-sleep when the config key was never written. On, at half an hour. */
export const SLEEP_AFTER_DEFAULT_MS = 30 * 60_000;

/**
 * Duration text from config: "30m" · "2h" · "90s". Unset means the default
 * (auto-sleep is on out of the box); "off" · "0" · "never" turn it off. Under
 * a minute is a misconfiguration, not a wish for a 30-second window → off.
 */
export function parseSleepAfter(raw: string | undefined): number {
  if (raw === undefined || raw === null || String(raw).trim() === '') return SLEEP_AFTER_DEFAULT_MS;
  const text = String(raw).trim().toLowerCase();
  if (text === 'off' || text === 'never' || text === 'no') return 0;
  const m = text.match(/^(\d+)\s*(s|m|h)?$/);
  if (!m) return 0;
  const n = parseInt(m[1]!, 10);
  const unit = m[2] === 'h' ? 3600 : m[2] === 's' ? 1 : 60;
  const seconds = n * unit;
  return seconds >= 60 ? seconds * 1000 : 0;
}

/** Focus reports and mouse events are the terminal talking, not the user; they must not wake anything. */
export function isPassiveInput(data: Buffer): boolean {
  const text = data.toString('latin1');
  return text.length > 0 && /^(\x1b\[(I|O)|\x1b\[<[\d;]+[Mm]|\x1b\[M...)*$/.test(text);
}

/**
 * The flags to hand `resume`: the agent's own argv minus the ones that name a
 * session (`--resume x`, `--continue`, `--session-id x`) — resume names one itself.
 */
export function resumeArgsFrom(command: string): string[] {
  const tokens = command.trim().split(/\s+/).slice(1);
  // Codex names the session as a subcommand: `codex resume <id> …`. Drop both.
  if (tokens[0] === 'resume') { tokens.shift(); if (tokens[0] && !tokens[0].startsWith('-')) tokens.shift(); }
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === '--resume' || t === '-r' || t === '--session-id') { i++; continue; }
    if (t === '--continue' || t === '--last') continue;
    // Claude's -c is --continue; Codex's -c is a config override that takes a value.
    if (t === '-c') { if (tokens[i + 1]?.includes('=')) { out.push(t, tokens[++i]!); } continue; }
    out.push(t);
  }
  return out;
}

function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The agent process under a shell: child or grandchild whose command names claude/codex. */
export function findAgentProcess(procs: ProcInfo[], shellPid: number): (ProcInfo & { kind: 'claude' | 'codex' }) | null {
  const byParent = new Map<number, ProcInfo[]>();
  for (const p of procs) {
    const list = byParent.get(p.ppid) ?? [];
    list.push(p);
    byParent.set(p.ppid, list);
  }
  const queue: Array<{ pid: number; depth: number }> = [{ pid: shellPid, depth: 0 }];
  while (queue.length > 0) {
    const { pid, depth } = queue.shift()!;
    for (const child of byParent.get(pid) ?? []) {
      const argv0 = child.command.trim().split(/\s+/)[0] ?? '';
      const m = AGENT_RE.exec(argv0);
      if (m) return { ...child, kind: m[2] as 'claude' | 'codex' };
      if (depth < 2) queue.push({ pid: child.pid, depth: depth + 1 });
    }
  }
  return null;
}

/**
 * A tool command still running under the agent. Claude Code runs every Bash
 * tool call as `zsh -c 'source ~/.claude/shell-snapshots/…'`, background ones
 * included, and holds `caffeinate` while one runs. Neither shows in the hooks
 * (Stop has fired, the turn is closed) nor on screen (the status line does not
 * repaint — measured: lastSeq flat for 20 s with `sleep 150` in the background),
 * so the process tree is the only signal. MCP servers are children too, but
 * they are not shells sourcing a snapshot.
 */
export function busyChildOf(procs: ProcInfo[], agentPid: number): ProcInfo | null {
  const byParent = new Map<number, ProcInfo[]>();
  for (const p of procs) { const l = byParent.get(p.ppid) ?? []; l.push(p); byParent.set(p.ppid, l); }
  const queue = [agentPid];
  let guard = 0;
  while (queue.length > 0 && guard++ < 500) {
    const pid = queue.shift()!;
    for (const child of byParent.get(pid) ?? []) {
      if (/shell-snapshots|(^|\/)caffeinate(\s|$)/.test(child.command)) return child;
      queue.push(child.pid);
    }
  }
  return null;
}

/** Default reader for ~/.claude/sessions/<pid>.json. */
export async function readAgentStatus(pid: number, home = process.env.CLAUDE_CONFIG_DIR || resolve(process.env.HOME || '/tmp', '.claude')): Promise<AgentStatusFile | null> {
  try {
    const raw = JSON.parse(await readFile(resolve(home, 'sessions', `${pid}.json`), 'utf8')) as Record<string, unknown>;
    const status = raw.status;
    if (status !== 'busy' && status !== 'idle' && status !== 'waiting') return null;
    return { status, waitingFor: typeof raw.waitingFor === 'string' ? raw.waitingFor : undefined, updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : undefined };
  } catch { return null; }
}

/** macOS/Linux `ps` → ProcInfo[]. RSS in bytes. */
export async function psProcesses(): Promise<ProcInfo[]> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolveList) => {
    execFile('ps', ['-axo', 'pid=,ppid=,rss=,command='], { maxBuffer: 16 << 20 }, (err, stdout) => {
      if (err) { resolveList([]); return; }
      const out: ProcInfo[] = [];
      for (const line of stdout.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (m) out.push({ pid: +m[1]!, ppid: +m[2]!, rss: +m[3]! * 1024, command: m[4]! });
      }
      resolveList(out);
    });
  });
}

interface Live {
  state: SleepState;
  queue: Buffer[];
  queuedBytes: number;
  /** Set by the SessionStart hook arriving while waking. */
  started: boolean;
  wakeStartedAt: number;
}

export class AgentSleeper {
  private live = new Map<number, Live>();
  private afterMs = 0;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = new Set<number>();
  private readonly bootAt: number;
  private readonly now: () => number;
  private readonly scale: number;

  constructor(private readonly deps: SleeperDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.scale = deps.timeScale ?? 1;
    this.bootAt = this.now();
  }

  /** Every duration in this class goes through here, so tests can run the whole dance in milliseconds. */
  private t(ms: number): number { return ms * this.scale; }
  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, Math.max(1, this.t(ms))));
  }
  private snapshotPath(id: number): string { return resolve(this.deps.runtimeDir, `sleep-${id}.ansi`); }

  /** Config: `agent-sleep-after`. Re-arms the idle sweep. */
  configure(values: Record<string, string | undefined>): void {
    this.afterMs = parseSleepAfter(values['agent-sleep-after']);
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.afterMs > 0) {
      this.timer = setInterval(() => void this.sweep(), Math.min(TICK_MS, Math.max(1000, this.afterMs / 4)) * this.scale);
      this.timer.unref();
      this.deps.log(`SLEEP auto: after ${Math.round(this.afterMs / 60000)}m`);
    }
  }

  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  stateOf(id: number): SleepState | null { return this.live.get(id)?.state ?? null; }
  isGated(id: number): boolean { return this.live.has(id) && this.live.get(id)!.state.state !== 'failed'; }

  /** Everything a status view needs. */
  async status(): Promise<{ sleeping: Array<{ sessionId: number } & SleepState>; reclaimedBytes: number; afterMs: number }> {
    const sleeping: Array<{ sessionId: number } & SleepState> = [];
    let reclaimed = 0;
    for (const [id, l] of this.live) {
      sleeping.push({ sessionId: id, ...l.state });
      if (l.state.state === 'sleeping') reclaimed += l.state.rssBefore;
    }
    return { sleeping, reclaimedBytes: reclaimed, afterMs: this.afterMs };
  }

  /** Restore gates and frozen screens after a server restart. */
  async restore(): Promise<void> {
    for (const id of this.deps.sessions.ids()) {
      const session = this.deps.sessions.get(id);
      if (!session || session.isDead) continue;
      const meta = await this.deps.sessions.getMeta(id);
      const saved = meta.agentSleep as SleepState | undefined;
      if (!saved || typeof saved !== 'object') continue;
      if (saved.state === 'failed') { this.live.set(id, { state: saved, queue: [], queuedBytes: 0, started: false, wakeStartedAt: 0 }); continue; }
      // 'waking' at the time of the crash → back to sleeping; the queue is gone with the old process.
      const state: SleepState = { ...saved, state: 'sleeping' };
      let snapshot: string | undefined;
      try { snapshot = await readFile(this.snapshotPath(id), 'utf8'); } catch {}
      session.freeze(snapshot);
      this.install(id, session, state);
      await this.deps.sessions.setMeta(id, { agentSleep: state });
      this.deps.log(`SLEEP restored session=${id} (${saved.state})`);
    }
  }

  // ── entry points ──────────────────────────────────────────────────────

  /** The SessionStart hook: an agent came up in this pane. Ends a wake's first phase. */
  noteAgentStart(id: number): void {
    const l = this.live.get(id);
    if (!l) return;
    if (l.state.state === 'waking') l.started = true;
    // An agent came up in a pane marked failed: the user fixed it themselves. Clear the mark.
    if (l.state.state === 'failed') {
      this.live.delete(id);
      void this.deps.sessions.setMeta(id, { agentSleep: null }).then(() => this.deps.onState(id, null));
    }
  }

  /**
   * Put one pane's agent to sleep. A manual request skips the idle clocks but
   * never the safety checks (mid-turn, pending interaction, pinned).
   */
  async sleep(id: number, reason: 'idle' | 'manual'): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.live.get(id)?.state.state === 'failed') this.live.delete(id); // a failed wake does not block a new sleep
    if (this.live.has(id) || this.inFlight.has(id)) return { ok: false, error: 'already sleeping' };
    const session = this.deps.sessions.get(id);
    if (!session || session.isDead) return { ok: false, error: 'not found' };
    const meta = await this.deps.sessions.getMeta(id);
    const refuse = await this.refusal(id, session, meta, reason === 'idle');
    if (refuse) return { ok: false, error: refuse };
    const procs = await this.deps.listProcesses();
    const agent = findAgentProcess(procs, session.childPid);
    if (!agent) return { ok: false, error: 'no agent process under this pane' };
    const kind = KINDS[agent.kind];
    const agentSessionId = (meta[kind.idKey] ?? meta[kind.lastKey]) as string | null | undefined;
    if (typeof agentSessionId !== 'string' || !agentSessionId) return { ok: false, error: `no ${agent.kind} session id to resume from` };
    const busy = await this.whyBusy(agent, procs, session, meta);
    if (busy) return { ok: false, error: busy };

    this.inFlight.add(id);
    try {
      const state: SleepState = { state: 'sleeping', since: this.now(), agent: agent.kind, agentSessionId, rssBefore: agent.rss, reason, args: resumeArgsFrom(agent.command) };
      // Freeze first: nothing that follows (Ctrl-C notices, the shell prompt) reaches a viewer.
      const snapshot = session.viewerSnapshot();
      session.freeze(snapshot);
      await writeFile(this.snapshotPath(id), snapshot).catch(() => {});
      this.install(id, session, state);
      await this.deps.sessions.setMeta(id, { agentSleep: state });
      this.deps.onState(id, state);
      this.deps.log(`SLEEP session=${id} reason=${reason} rss=${Math.round(agent.rss / 1048576)}MB agent=${agentSessionId.slice(0, 8)}`);

      // Ctrl-C, three times. `/exit` would do, but it is a command: the transcript
      // keeps it, and every resume then shows "❯ /exit ⎿ See ya!" in the middle
      // of the conversation. Ctrl-C leaves nothing behind. The first press clears
      // a half-typed line or shows the "press again" notice, the second exits or
      // shows the notice, the third exits; one extra reaches the shell, harmless.
      for (let i = 0; i < 3; i++) {
        session.writeRaw(Buffer.from([0x03]));
        await this.delay(220);
      }

      const gone = await this.waitGone(session.childPid, agent.pid, 8000);
      if (!gone) {
        this.deps.log(`SLEEP session=${id} /exit ignored → SIGTERM`);
        this.deps.kill(agent.pid, 'SIGTERM');
        if (!(await this.waitGone(session.childPid, agent.pid, 4000))) {
          this.deps.kill(agent.pid, 'SIGKILL');
          if (!(await this.waitGone(session.childPid, agent.pid, 3000))) {
            // Could not bring it down: undo everything, the agent is still there.
            this.uninstall(id, session);
            session.thaw();
            await this.deps.sessions.setMeta(id, { agentSleep: null });
            this.deps.onState(id, null);
            return { ok: false, error: 'agent did not exit' };
          }
        }
      }
      return { ok: true };
    } finally {
      this.inFlight.delete(id);
    }
  }

  /** Bring a sleeping pane's agent back. Input that arrives meanwhile is queued by the gate. */
  async wake(id: number, trigger: 'input' | 'manual' = 'manual'): Promise<{ ok: true } | { ok: false; error: string }> {
    const l = this.live.get(id);
    const session = this.deps.sessions.get(id);
    if (!l || !session || session.isDead) return { ok: false, error: 'not sleeping' };
    if (l.state.state === 'waking') return { ok: true };
    if (l.state.state === 'failed') return { ok: false, error: 'resume failed earlier; use restore' };
    // Flip before the first await: a second key arriving meanwhile must see 'waking', not start another wake.
    l.state = { ...l.state, state: 'waking', since: this.now(), queued: l.queuedBytes };
    l.started = false;
    l.wakeStartedAt = this.now();
    await this.deps.sessions.setMeta(id, { agentSleep: l.state });
    this.deps.onState(id, l.state);
    this.deps.log(`WAKE session=${id} trigger=${trigger} queued=${l.queuedBytes}B`);

    // Ctrl-U clears whatever sits on the shell line, then resume through the CLI so the
    // flag layering (config → env → argv) stays in one place. PORT= because the pane's
    // ttym may predate TTYM_PORT awareness — an env prefix is harmless everywhere.
    session.writeRaw(Buffer.from([0x15]));
    await this.delay(100);
    const extra = [...KINDS[l.state.agent].resumeExtra, ...(l.state.args ?? [])].map(shellQuote).join(' ');
    session.writeRaw(Buffer.from(`PORT=${this.deps.port} ttym agent resume ${l.state.agent}${extra ? ' ' + extra : ''}\r`));

    const ready = await this.waitReady(id, session);
    const cur = this.live.get(id);
    if (!cur) return { ok: true }; // removed meanwhile (session died)
    if (!ready.ok) {
      cur.state = { ...cur.state, state: 'failed', error: ready.error };
      cur.queue = []; cur.queuedBytes = 0;
      session.inputGate = null;
      session.thaw();
      await unlink(this.snapshotPath(id)).catch(() => {});
      this.deps.resnapshot(id);
      await this.deps.sessions.setMeta(id, { agentSleep: cur.state });
      this.deps.onState(id, cur.state);
      this.deps.log(`WAKE session=${id} failed: ${ready.error}`);
      return { ok: false, error: ready.error };
    }

    session.inputGate = null;
    session.thaw();
    this.live.delete(id);
    await unlink(this.snapshotPath(id)).catch(() => {});
    this.deps.resnapshot(id);
    await this.deps.sessions.setMeta(id, { agentSleep: null });
    this.deps.onState(id, null);
    // The queue, in order, with a beat between entries so a prompt and its CR are not
    // read as one paste (the same lottery the interactions path avoids).
    for (const chunk of cur.queue) {
      session.write(chunk);
      await this.delay(30);
    }
    this.deps.log(`WAKE session=${id} ready in ${Math.round((this.now() - cur.wakeStartedAt) / 100) / 10}s, wrote ${cur.queuedBytes}B`);
    return { ok: true };
  }

  /** A session ended: forget it. */
  forget(id: number): void {
    this.live.delete(id);
    void unlink(this.snapshotPath(id)).catch(() => {});
  }

  // ── internals ─────────────────────────────────────────────────────────

  private install(id: number, session: Session, state: SleepState): void {
    const l: Live = { state, queue: [], queuedBytes: 0, started: false, wakeStartedAt: 0 };
    this.live.set(id, l);
    session.inputGate = (data) => {
      const cur = this.live.get(id);
      if (!cur || cur.state.state === 'failed') return false;
      if (isPassiveInput(data)) return true; // swallowed, no wake
      if (cur.queuedBytes + data.length <= QUEUE_MAX_BYTES) { cur.queue.push(data); cur.queuedBytes += data.length; }
      if (cur.state.state === 'sleeping') void this.wake(id, 'input');
      return true;
    };
  }

  private uninstall(id: number, session: Session): void {
    this.live.delete(id);
    session.inputGate = null;
  }

  /**
   * Everything that means "not idle", most authoritative first.
   *
   * Claude Code says so itself, twice. Its Stop payload (2.1.269+) lists what
   * is still alive after the turn — background bash, agents, monitors, and the
   * session crons (CronCreate, ScheduleWakeup, /loop) that will wake it later;
   * the hook forwards that as claudeInFlight, and it holds until the next Stop
   * replaces it. And ~/.claude/sessions/<pid>.json carries busy / idle /
   * waiting, where waiting names a permission prompt or dialog — which a resume
   * cannot answer. Below those: a turn opened by a prompt and not yet stopped,
   * and the process tree (a snapshot shell or caffeinate under the agent) for
   * versions whose Stop payload has no task list.
   *
   * Codex has none of this; its only signal is output within the last 10 s.
   */
  private async whyBusy(agent: ProcInfo & { kind: AgentKind }, procs: ProcInfo[], session: Session, meta: Record<string, unknown>): Promise<string | null> {
    if (agent.kind === 'codex') {
      return this.now() - session.lastOutputAt < this.t(10_000) ? 'agent is mid-turn (output in the last 10 s)' : null;
    }
    const status = await this.deps.agentStatus(agent.pid);
    if (status?.status === 'waiting') return `agent is waiting for you (${status.waitingFor ?? 'input needed'})`;
    if (status?.status === 'busy') return 'agent is busy';
    if (meta.claudeTurnOpen === true) return 'agent is mid-turn';
    const inFlight = meta.claudeInFlight as InFlight | null | undefined;
    if (inFlight && typeof inFlight === 'object') {
      if (inFlight.tasks.length > 0) {
        const t = inFlight.tasks[0]!;
        return `${inFlight.tasks.length} background task${inFlight.tasks.length > 1 ? 's' : ''} running (${t.type}${t.description ? `: ${t.description}` : ''})`;
      }
      if (inFlight.crons.length > 0) {
        const c = inFlight.crons[0]!;
        return `a wakeup is scheduled (${c.schedule}${inFlight.crons.length > 1 ? ` +${inFlight.crons.length - 1}` : ''}) — sleeping would lose it`;
      }
      return null; // this Claude reports its tasks, and reports none
    }
    const busy = busyChildOf(procs, agent.pid);
    if (busy) return `a command is still running under the agent (${busy.command.split(/\s+/).slice(0, 2).join(' ')})`;
    return null;
  }

  private async refusal(id: number, session: Session, meta: Record<string, unknown>, checkIdle: boolean): Promise<string | null> {
    if (this.deps.hasPendingInteraction(id)) return 'an interaction is pending';
    if (checkIdle) {
      const idleFloor = this.afterMs > 0 ? this.afterMs : 0;
      if (idleFloor <= 0) return 'auto sleep is off (settings → agents)';
      const now = this.now();
      const lastIn = session.lastInputAt || this.bootAt;
      const lastOut = session.lastOutputAt || this.bootAt;
      if (now - lastIn < idleFloor) return 'input too recent';
      if (now - lastOut < idleFloor) return 'output too recent';
    }
    return null;
  }

  private async waitGone(shellPid: number, agentPid: number, ms: number): Promise<boolean> {
    const until = this.now() + this.t(ms);
    for (;;) {
      const procs = await this.deps.listProcesses();
      if (!procs.some((p) => p.pid === agentPid)) return true;
      if (findAgentProcess(procs, shellPid) === null) return true;
      if (this.now() >= until) return false;
      await this.delay(400);
    }
  }

  /**
   * Ready = the agent is up and output has been quiet for 500 ms. "Up" is the
   * SessionStart hook, or — if the hook never reaches this server (a pane
   * whose env names another port) — the agent process under the shell with
   * output quiet for 2 s. Failed = no agent process 10 s in with a quiet
   * shell, or 45 s.
   */
  private async waitReady(id: number, session: Session): Promise<{ ok: true } | { ok: false; error: string }> {
    const startedAt = this.now();
    let lastProcCheck = 0;
    for (;;) {
      await this.delay(250);
      const l = this.live.get(id);
      if (!l) return { ok: true };
      const now = this.now();
      const quietFor = now - (session.lastOutputAt || startedAt);
      if (l.started && quietFor >= this.t(500)) return { ok: true };
      const elapsed = now - startedAt;
      if (!l.started && elapsed >= this.t(1500) && quietFor >= this.t(2000) && now - lastProcCheck >= this.t(1000)) {
        lastProcCheck = now;
        const agent = findAgentProcess(await this.deps.listProcesses(), session.childPid);
        if (agent) {
          // Codex reports SessionStart on its first turn, not at boot — the process is the normal signal there.
          if (l.state.agent === 'claude') this.deps.log(`WAKE session=${id} agent process up (pid ${agent.pid}) but no SessionStart hook — proceeding; check the pane's TTYM_PORT`);
          l.started = true;
          continue;
        }
        if (elapsed >= this.t(10_000)) return { ok: false, error: `resume did not start: ${lastLines(session.viewerSnapshot())}` };
      }
      if (elapsed >= this.t(45_000)) return { ok: false, error: l.started ? 'agent started but never settled' : 'resume timed out' };
    }
  }

  private async sweep(): Promise<void> {
    if (this.afterMs <= 0) return;
    let put = 0;
    for (const id of this.deps.sessions.ids()) {
      if (put >= SLEEP_BATCH) break;
      if (this.live.has(id) || this.inFlight.has(id)) continue;
      const session = this.deps.sessions.get(id);
      if (!session || session.isDead) continue;
      const meta = await this.deps.sessions.getMeta(id);
      if (await this.refusal(id, session, meta, true)) continue;
      const r = await this.sleep(id, 'idle');
      if (r.ok) { put++; await this.delay(3000); }
    }
  }
}

/** The last few non-empty rows of a screen, plain text — for an error message. */
function lastLines(ansi: string, n = 3): string {
  const plain = ansi.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Za-z0-9]/g, '');
  const rows = plain.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  return rows.slice(-n).join(' | ').slice(0, 300);
}
