import { readdir, readFile, unlink, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Session, SessionInfo, HolderManifest, getRuntimeDir } from './session.js';

const DEFAULT_DETACHED_TTL = 5 * 60 * 1000;
const REAP_INTERVAL = 30 * 1000;
const DEFAULT_SHELL = process.env.SHELL || '/bin/bash';

export class SessionManager {
  private sessions = new Map<number, Session>();
  private nextId = 1;
  private reapTimer: NodeJS.Timeout | null = null;
  private readonly detachedTtl: number;
  readonly runtimeDir: string;
  private _ready = false;

  constructor(runtimeDir?: string, detachedTtl = DEFAULT_DETACHED_TTL) {
    this.runtimeDir = runtimeDir ?? getRuntimeDir();
    this.detachedTtl = detachedTtl;
    this.reapTimer = setInterval(() => this.reap(), REAP_INTERVAL);
  }

  get ready(): boolean { return this._ready; }

  /** Boot: create runtime dir, recover existing holders, then mark ready */
  async boot(): Promise<void> {
    await mkdir(this.runtimeDir, { recursive: true });

    // Load persisted next-id
    const idFile = resolve(this.runtimeDir, 'next-id');
    try {
      const raw = await readFile(idFile, 'utf8');
      this.nextId = parseInt(raw.trim(), 10) || 1;
    } catch {}

    // Discover and recover holders
    await this.recover();
    this._ready = true;
  }

  private async recover(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(this.runtimeDir);
    } catch { return; }

    const manifests = files.filter((f) => f.startsWith('session-') && f.endsWith('.json'));

    for (const filename of manifests) {
      const manifestPath = resolve(this.runtimeDir, filename);
      try {
        const raw = await readFile(manifestPath, 'utf8');
        const manifest: HolderManifest = JSON.parse(raw);

        // Check holder process alive
        try {
          process.kill(manifest.pid, 0);
        } catch {
          console.log(`[mgr] stale holder pid=${manifest.pid} session=${manifest.id}, cleaning`);
          await unlink(manifestPath).catch(() => {});
          await unlink(manifest.socket).catch(() => {});
          continue;
        }

        // Connect to holder
        const session = await Session.recover(manifest, this.runtimeDir);
        this.sessions.set(session.id, session);
        this.nextId = Math.max(this.nextId, session.id + 1);

        console.log(`[mgr] recovered session=${session.id} pid=${manifest.childPid}`);

        // Wire exit cleanup
        session.onExit(() => {
          setTimeout(() => this.sessions.delete(session.id), 30_000);
        });
      } catch (e) {
        console.error(`[mgr] failed to recover ${filename}:`, e);
        await unlink(manifestPath).catch(() => {});
      }
    }
  }

  async create(cmd: string[], cols: number, rows: number): Promise<Session> {
    const id = this.nextId++;
    await this.persistNextId();

    const session = await Session.create(id, cmd, cols, rows, this.runtimeDir);
    this.sessions.set(id, session);

    session.onExit(() => {
      setTimeout(() => this.sessions.delete(id), 30_000);
    });

    return session;
  }

  private async persistNextId(): Promise<void> {
    const idFile = resolve(this.runtimeDir, 'next-id');
    await writeFile(idFile, String(this.nextId)).catch(() => {});
  }

  get(id: number): Session | undefined {
    return this.sessions.get(id);
  }

  has(id: number): boolean {
    return this.sessions.has(id);
  }

  list(): SessionInfo[] {
    const result: SessionInfo[] = [];
    for (const s of this.sessions.values()) {
      if (!s.isDead) result.push(s.info());
    }
    return result;
  }

  detachViewer(viewerId: string, sessionIds: Set<number>): void {
    for (const id of sessionIds) {
      const session = this.sessions.get(id);
      if (session && !session.isDead) {
        session.removeViewer(viewerId);
      }
    }
  }

  destroy(id: number): void {
    const session = this.sessions.get(id);
    if (session) {
      session.kill();
      this.sessions.delete(id);
    }
  }

  /** Server shutdown: disconnect from holders but DON'T kill them */
  shutdown(): void {
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }
    // Don't call session.kill() — holders should survive server restart
  }

  /** Kill all sessions and holders (full cleanup) */
  destroyAll(): void {
    for (const session of this.sessions.values()) session.kill();
    this.sessions.clear();
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }
  }

  private reap(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.status === 'detached' && session.detachedAt !== null) {
        if (now - session.detachedAt > this.detachedTtl) {
          console.log(`[mgr] reaping detached session=${id} (TTL expired)`);
          session.kill();
          this.sessions.delete(id);
        }
      }
      if (session.isDead) {
        const age = now - session.createdAt;
        if (age > 60_000) {
          this.sessions.delete(id);
        }
      }
    }
  }
}
