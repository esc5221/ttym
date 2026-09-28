import type { Session, TerminalMarker } from './session.js';
import { agentKindOf, claudeTranscriptPath } from './agent-providers.js';
import { isTranscriptPath, lastText, readTurn, summarize, type TurnEvent, type TurnSummary } from './agent-turn.js';

/**
 * One prompt and the output it produced.
 *
 * The state lives here rather than in session meta so that writing a user key
 * cannot break request/response tracking — the old `seq` / `stopSeq` pair sat
 * in the same namespace as `ttym meta --set`, where anyone could stall an
 * await by resetting it.
 */
export type InteractionStatus = 'pending' | 'completed' | 'timed_out' | 'failed';

export interface InteractionView {
  id: string;
  sessionId: number;
  prompt: string;
  status: InteractionStatus;
  transcript: string | null;
  /** Where the transcript came from: the agent's own record, or the screen. */
  transcriptSource?: 'structured' | 'screen';
  /** Screen quality at extraction time — 'degraded' means approximate. */
  integrity?: 'healthy' | 'degraded';
  /** 이 턴을 다시 읽을 곳 — `ttym turn`이 outline·full을 여기서 만든다. structured일 때만. */
  turnPath?: string;
  /** Codex의 turn_id. 있으면 turnPath 안에서 이 턴만 자른다. */
  turnId?: string;
  /** 턴 크기: 걸린 시간·도구 횟수·수정한 파일. await 결과 아래 한 줄. */
  summary?: TurnSummary;
  createdAt: number;
  completedAt: number | null;
}

interface InteractionRecord extends InteractionView {
  marker: TerminalMarker | null;
  waiters: Array<() => void>;
}

/** 턴의 시간 범위. 앞쪽 여유는 claudeStructuredTranscript와 같다(프롬프트 직전 생성). */
export function turnRange(rec: { turnPath?: string; turnId?: string; createdAt: number }, endedAt: number | null) {
  return { path: rec.turnPath ?? '', turnId: rec.turnId, sinceMs: rec.createdAt - 2_000, untilMs: endedAt === null ? undefined : endedAt + 2_000 };
}

/**
 * Stop 훅이 넘겨주는 것. Claude Code와 Codex의 Stop 입력이 같은 이름을 쓴다
 * (transcript_path, last_assistant_message; Codex는 turn_id도). 옛 훅은 아무것도 안 넘긴다.
 */
export interface StopReport {
  reply?: string | null;
  transcriptPath?: string;
  turnId?: string;
}

let counter = 0;

function newId(): string {
  counter = (counter + 1) % 0xffff;
  const stamp = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0xffff).toString(36);
  return `int_${stamp}${counter.toString(36)}${rand}`;
}

function view(rec: InteractionRecord): InteractionView {
  const { marker: _m, waiters: _w, ...rest } = rec;
  return { ...rest };
}

export class InteractionStore {
  /** transcript가 훅보다 늦을 때 다시 읽는 횟수. 테스트는 0. */
  constructor(private transcriptRetries = 3) {}

  private byId = new Map<string, InteractionRecord>();
  /** At most one in flight per session: agents answer one prompt at a time. */
  private pendingBySession = new Map<number, InteractionRecord>();

  /**
   * Begin an interaction and mark where its output will start.
   *
   * Any interaction already in flight for this session is settled as `failed`
   * — a second prompt means the caller stopped waiting on the first, and
   * leaving it pending would let a later Stop complete the wrong one.
   */
  start(session: Session, prompt: string): InteractionView {
    const previous = this.pendingBySession.get(session.id);
    if (previous) this.settle(previous, 'failed');

    const rec: InteractionRecord = {
      id: newId(),
      sessionId: session.id,
      prompt,
      status: 'pending',
      transcript: null,
      createdAt: Date.now(),
      completedAt: null,
      marker: session.markCursor(),
      waiters: [],
    };
    this.byId.set(rec.id, rec);
    this.pendingBySession.set(session.id, rec);
    return view(rec);
  }

  /**
   * Settle the interaction in flight for a session.
   *
   * `status` is what the agent reported: a Stop hook maps to 'completed', a
   * StopFailure or SessionEnd to 'failed'. Both end the wait — an agent that
   * died is not going to answer, and blocking until timeout would be a lie.
   */
  async finish(
    session: Session,
    status: 'completed' | 'failed' = 'completed',
    meta?: Record<string, unknown>,
    report: StopReport = {},
  ): Promise<InteractionView | null> {
    const rec = this.pendingBySession.get(session.id);
    if (!rec) return null;
    const now = Date.now();

    // 이 턴이 기록된 파일. 훅이 알려준 경로가 우선이고, 옛 Claude 훅이면 meta로 찾는다.
    // The Stop hook clears claudeSessionId into claudeLastSessionId BEFORE
    // reporting the stop — by the time we run, the live id has already moved.
    const claudeSid = (meta?.claudeSessionId ?? meta?.claudeLastSessionId) as unknown;
    if (isTranscriptPath(report.transcriptPath)) rec.turnPath = report.transcriptPath;
    else if (meta && agentKindOf(meta) === 'claude-code' && typeof claudeSid === 'string' && typeof meta.cwd === 'string') {
      rec.turnPath = claudeTranscriptPath(meta.cwd, claudeSid);
    }
    if (typeof report.turnId === 'string' && report.turnId) rec.turnId = report.turnId;

    let events: TurnEvent[] | null = null;
    if (status === 'completed' && rec.turnPath) {
      events = await this.readWithRetry(turnRange(rec, now), report.reply);
    }

    // 답: 에이전트가 이 턴에 마지막으로 한 말. 훅이 준 값 → transcript의 마지막 text → 화면 구간.
    // 화면은 렌더링이라 TUI가 답 뒤에 그린 것까지 섞인다. 마지막 수단이고, 그렇다고 표시한다.
    const reply = typeof report.reply === 'string' && report.reply.trim() ? report.reply.trim() : (events ? lastText(events) : null);
    if (status === 'completed' && reply !== null) {
      rec.transcript = reply;
      rec.transcriptSource = 'structured';
      if (events) rec.summary = summarize(events, rec.createdAt, now);
    } else if (rec.marker) {
      rec.transcript = session.transcriptSince(rec.marker);
      if (rec.transcript !== null) rec.transcriptSource = 'screen';
    }
    if (rec.transcriptSource !== 'structured') { rec.turnPath = undefined; rec.turnId = undefined; }
    // Extraction quality rides along: a transcript read off a degraded screen
    // must not be indistinguishable from a faithful one.
    rec.integrity = session.integrity;
    return this.settle(rec, status);
  }

  /**
   * transcript는 Stop 훅보다 조금 늦게 디스크에 닿는다. 답을 훅이 이미 줬으면 요약만
   * 필요하니 한 번 읽고, 답을 여기서 찾아야 하면 마지막 text가 보일 때까지 몇 번 더 읽는다.
   */
  private async readWithRetry(range: ReturnType<typeof turnRange>, hookReply: unknown): Promise<TurnEvent[] | null> {
    const tries = typeof hookReply === 'string' && hookReply.trim() ? 1 : this.transcriptRetries + 1;
    for (let i = 0; i < tries; i++) {
      const events = await readTurn(range).catch(() => null);
      if (events && (tries === 1 || lastText(events) !== null)) return events;
      if (i + 1 < tries) await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  }

  /** Mark as timed out but keep it resolvable: the agent may still answer. */
  timeout(id: string): InteractionView | null {
    const rec = this.byId.get(id);
    if (!rec || rec.status !== 'pending') return null;
    rec.status = 'timed_out';
    return view(rec);
  }

  /** Wake anyone waiting, and unlink the session's in-flight slot. */
  private settle(rec: InteractionRecord, status: InteractionStatus): InteractionView {
    rec.status = status;
    rec.completedAt = Date.now();
    rec.marker?.dispose();
    rec.marker = null;
    if (this.pendingBySession.get(rec.sessionId) === rec) {
      this.pendingBySession.delete(rec.sessionId);
    }
    const waiters = rec.waiters;
    rec.waiters = [];
    for (const wake of waiters) wake();
    return view(rec);
  }

  get(id: string): InteractionView | null {
    const rec = this.byId.get(id);
    return rec ? view(rec) : null;
  }

  pending(sessionId: number): InteractionView | null {
    const rec = this.pendingBySession.get(sessionId);
    return rec ? view(rec) : null;
  }

  /**
   * Resolve once the interaction settles, or when `timeoutMs` elapses.
   * Resolving on timeout leaves the interaction pending so the caller can
   * resume it by id rather than losing the response.
   */
  wait(id: string, timeoutMs: number): Promise<InteractionView | null> {
    const rec = this.byId.get(id);
    if (!rec) return Promise.resolve(null);
    if (rec.status !== 'pending') return Promise.resolve(view(rec));

    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        rec.waiters = rec.waiters.filter((w) => w !== wake);
        resolve(view(rec));
      }, timeoutMs);

      const wake = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(view(rec));
      };
      rec.waiters.push(wake);
    });
  }

  /** A dead session answers nothing further. */
  hasPending(sessionId: number): boolean {
    return this.pendingBySession.get(sessionId)?.status === 'pending';
  }

  abandonSession(sessionId: number): void {
    const rec = this.pendingBySession.get(sessionId);
    if (rec) this.settle(rec, 'failed');
  }

  /** Drop settled records older than `maxAgeMs` so the map cannot grow forever. */
  prune(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const [id, rec] of this.byId) {
      if (rec.status === 'pending') continue;
      if ((rec.completedAt ?? rec.createdAt) > cutoff) continue;
      this.byId.delete(id);
      removed++;
    }
    return removed;
  }
}
