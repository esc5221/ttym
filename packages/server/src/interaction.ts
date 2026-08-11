import type { Session, TerminalMarker } from './session.js';

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
  /** Screen quality at extraction time — 'degraded' means approximate. */
  integrity?: 'healthy' | 'degraded';
  createdAt: number;
  completedAt: number | null;
}

interface InteractionRecord extends InteractionView {
  marker: TerminalMarker | null;
  waiters: Array<() => void>;
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
  finish(session: Session, status: 'completed' | 'failed' = 'completed'): InteractionView | null {
    const rec = this.pendingBySession.get(session.id);
    if (!rec) return null;
    if (rec.marker) rec.transcript = session.transcriptSince(rec.marker);
    // Extraction quality rides along: a transcript read off a degraded screen
    // must not be indistinguishable from a faithful one.
    rec.integrity = session.integrity;
    return this.settle(rec, status);
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
