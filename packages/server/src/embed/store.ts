/**
 * Registered consumers (a file the CLI writes) and the grants they mint (memory only).
 *
 * The consumers file is re-read when its mtime changes, so `ttym embed consumer
 * add|remove|rotate` takes effect without a restart — and removing a consumer or
 * rotating its key ends every grant it minted.
 *
 * Grants live in memory, keyed by the hash of their token. A restart drops them
 * all; panels ask their consumer for a new one on reconnect.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { parseConsumers, type EmbedAccess, type EmbedConsumer, type EmbedConsumers } from '@ttym/protocol';

export const sha256 = (s: string) => 'sha256:' + createHash('sha256').update(s).digest('hex');

export class ConsumerStore {
  private consumers: EmbedConsumers = {};
  private mtimeMs = -1;
  constructor(readonly path: string, private readonly log: (...a: unknown[]) => void = () => {}) {}

  /** Current registrations. Cheap: a stat per call, a read only when the file changed. */
  all(): EmbedConsumers {
    let mtimeMs = 0;
    try { mtimeMs = statSync(this.path).mtimeMs; } catch { mtimeMs = 0; }
    if (mtimeMs !== this.mtimeMs) {
      this.mtimeMs = mtimeMs;
      if (mtimeMs === 0) { this.consumers = {}; return this.consumers; }
      try {
        const { consumers, problems } = parseConsumers(JSON.parse(readFileSync(this.path, 'utf8')));
        this.consumers = consumers;
        for (const p of problems) this.log(`EMBED consumers: skipped ${p}`);
      } catch (e) {
        this.consumers = {};
        this.log(`EMBED consumers: unreadable ${this.path}: ${(e as Error).message}`);
      }
    }
    return this.consumers;
  }

  get(id: string): EmbedConsumer | undefined { return this.all()[id]; }

  /** The consumer whose key this is. Constant-time on the hash so a timing probe learns nothing. */
  byKey(key: string): { id: string; consumer: EmbedConsumer } | null {
    const want = Buffer.from(sha256(key));
    for (const [id, consumer] of Object.entries(this.all())) {
      const have = Buffer.from(consumer.keyHash);
      if (have.length === want.length && timingSafeEqual(have, want)) return { id, consumer };
    }
    return null;
  }

  /** Every origin any consumer serves from — what may frame the panel before a grant is known. */
  allOrigins(): string[] {
    return [...new Set(Object.values(this.all()).flatMap((c) => c.origins))];
  }
}

export interface Grant {
  id: string;
  tokenHash: string;
  consumerId: string;
  /** The consumer's keyHash when minted: a rotated key ends the grant. */
  consumerKeyHash: string;
  subject: string;
  access: EmbedAccess[];
  createdAt: number;
  expiresAt: number;
}

export class GrantStore {
  private byHash = new Map<string, Grant>();
  private byId = new Map<string, Grant>();
  private timers = new Map<string, NodeJS.Timeout>();
  private endListeners = new Set<(grant: Grant, why: 'expired' | 'revoked') => void>();

  constructor(private readonly consumers: ConsumerStore, private readonly now: () => number = Date.now) {}

  mint(consumerId: string, consumer: EmbedConsumer, access: EmbedAccess[], ttlMs: number, subject: string): { token: string; grant: Grant } {
    const token = randomBytes(32).toString('base64url');
    const id = 'g_' + randomBytes(9).toString('base64url');
    const createdAt = this.now();
    const grant: Grant = { id, tokenHash: sha256(token), consumerId, consumerKeyHash: consumer.keyHash, subject, access, createdAt, expiresAt: createdAt + ttlMs };
    this.byHash.set(grant.tokenHash, grant);
    this.byId.set(id, grant);
    const timer = setTimeout(() => this.end(grant, 'expired'), ttlMs);
    timer.unref?.();
    this.timers.set(id, timer);
    return { token, grant };
  }

  /** The live grant for a token, or null — expired, revoked, or its consumer is gone or re-keyed. */
  lookup(token: unknown): Grant | null {
    if (typeof token !== 'string' || token.length < 16 || token.length > 128) return null;
    const grant = this.byHash.get(sha256(token));
    return grant && this.alive(grant) ? grant : null;
  }

  /** Checked on every frame and request, not only at connect. */
  alive(grant: Grant): boolean {
    if (!this.byId.has(grant.id)) return false;
    if (this.now() >= grant.expiresAt) { this.end(grant, 'expired'); return false; }
    const consumer = this.consumers.get(grant.consumerId);
    if (!consumer || consumer.keyHash !== grant.consumerKeyHash) { this.end(grant, 'revoked'); return false; }
    return true;
  }

  get(id: string): Grant | undefined { return this.byId.get(id); }

  revoke(id: string): boolean {
    const grant = this.byId.get(id);
    if (!grant) return false;
    this.end(grant, 'revoked');
    return true;
  }

  onEnd(listener: (grant: Grant, why: 'expired' | 'revoked') => void): () => void {
    this.endListeners.add(listener);
    return () => this.endListeners.delete(listener);
  }

  /**
   * Re-check every grant. Expiry has its own timer, but a removed consumer or a
   * rotated key is only noticed by alive() — a silent socket would keep its grant
   * until its next frame. server.ts runs this every few seconds.
   */
  sweep(): void {
    for (const grant of [...this.byId.values()]) this.alive(grant);
  }

  /** For tests and status. */
  size(): number { return this.byId.size; }

  private end(grant: Grant, why: 'expired' | 'revoked') {
    if (!this.byId.delete(grant.id)) return;
    this.byHash.delete(grant.tokenHash);
    const t = this.timers.get(grant.id);
    if (t) clearTimeout(t);
    this.timers.delete(grant.id);
    for (const l of this.endListeners) { try { l(grant, why); } catch {} }
  }

  close() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
