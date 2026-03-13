import { readdir, readFile, unlink, mkdir, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Session, SessionInfo, HolderManifest, getRuntimeDir } from './session.js';

export type SessionMeta = Record<string, unknown>;

export interface SessionSnapshot {
  version: 1;
  id: number;
  cmd: string[];
  cols: number;
  rows: number;
  cwd?: string;
  createdAt: number;
  savedAt: number;
  screen: string; // xterm serialize output
  meta: SessionMeta;
}

export interface WorkspaceState {
  version: 1;
  savedAt: number;
  nextId: number;
  sessions: Array<{ id: number; snapshotFile: string }>;
}

const REAP_INTERVAL = 30 * 1000;
const PERSIST_IDLE_MS = 2000;   // flush after 2s idle
const PERSIST_MAX_MS = 30000;   // force flush every 30s
const DEFAULT_SHELL = process.env.SHELL || '/bin/bash';

export class SessionManager {
  private sessions = new Map<number, Session>();
  private metas = new Map<number, SessionMeta>();
  private nextId = 1;
  private reapTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private lastPersistAt = 0;
  readonly runtimeDir: string;
  private _ready = false;
  private _lastIdMap = new Map<number, number>(); // old → new (from last restore)

  constructor(runtimeDir?: string) {
    this.runtimeDir = runtimeDir ?? getRuntimeDir();
    this.reapTimer = setInterval(() => this.reap(), REAP_INTERVAL);
    this.persistTimer = setInterval(() => this.checkPersist(), 1000);
  }

  get ready(): boolean { return this._ready; }
  get lastIdMap(): Map<number, number> { return this._lastIdMap; }

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

    // If no holders recovered, try workspace restore
    if (this.sessions.size === 0) {
      await this.restoreWorkspace();
    }

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

        // Load persisted meta
        await this.getMeta(session.id);
        console.log(`[mgr] recovered session=${session.id} pid=${manifest.childPid}`);

        // Wire exit cleanup (check identity to avoid deleting a replaced session)
        session.onExit(() => {
          const sid = session.id;
          setTimeout(() => { if (this.sessions.get(sid) === session) this.sessions.delete(sid); }, 30_000);
        });
      } catch (e) {
        console.error(`[mgr] failed to recover ${filename}:`, e);
        await unlink(manifestPath).catch(() => {});
      }
    }
  }

  // ───── Workspace Restore (reboot recovery) ─────

  private async restoreWorkspace(): Promise<void> {
    const wsPath = resolve(this.runtimeDir, 'workspace.json');
    if (!existsSync(wsPath)) return;

    let ws: WorkspaceState;
    try {
      ws = JSON.parse(await readFile(wsPath, 'utf8'));
      if (ws.version !== 1 || !Array.isArray(ws.sessions)) return;
    } catch {
      return;
    }

    console.log(`[mgr] restoring workspace: ${ws.sessions.length} sessions`);
    const idMap = new Map<number, number>(); // old → new

    for (const entry of ws.sessions) {
      const snapPath = resolve(this.runtimeDir, entry.snapshotFile);
      let snap: SessionSnapshot;
      try {
        snap = JSON.parse(await readFile(snapPath, 'utf8'));
      } catch {
        console.log(`[mgr] snapshot not found: ${entry.snapshotFile}, skipping`);
        continue;
      }

      // Validate cwd
      const cwd = snap.cwd && existsSync(snap.cwd) ? snap.cwd : process.env.HOME || '/tmp';

      try {
        const session = await Session.create(
          this.nextId++, snap.cmd, snap.cols, snap.rows, this.runtimeDir, cwd,
        );
        this.sessions.set(session.id, session);
        idMap.set(snap.id, session.id);

        // Seed headless xterm with saved screen + separator
        if (snap.screen) {
          session.seedSnapshot(snap.screen + '\r\n\x1b[90m── restored ──\x1b[0m\r\n');
        }

        // Migrate meta (old ID → new ID)
        if (snap.meta && Object.keys(snap.meta).length > 0) {
          await this.setMeta(session.id, snap.meta);
        }

        session.onExit(() => {
          const sid = session.id;
          setTimeout(() => { if (this.sessions.get(sid) === session) this.sessions.delete(sid); }, 30_000);
        });

        console.log(`[mgr] restored session=${snap.id} → ${session.id} cwd=${cwd}`);
      } catch (e) {
        console.error(`[mgr] failed to restore session=${snap.id}:`, e);
      }

      // Clean up snapshot file
      await unlink(snapPath).catch(() => {});
    }

    this._lastIdMap = idMap;
    await this.persistNextId();

    // Clean up workspace file
    await unlink(wsPath).catch(() => {});

    // Clean stale socket files
    try {
      const files = await readdir(this.runtimeDir);
      for (const f of files) {
        if (f.endsWith('.sock') && !this.sessions.has(parseInt(f.match(/session-(\d+)/)?.[1] ?? '0', 10))) {
          await unlink(resolve(this.runtimeDir, f)).catch(() => {});
        }
      }
    } catch {}
  }

  // ───── Periodic Snapshot Persistence ─────

  private checkPersist(): void {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.isDead || !session.dirty) continue;

      const idleMs = now - session.lastDirtyAt;
      const sincePersist = now - this.lastPersistAt;

      // Flush after 2s idle or 30s max
      if (idleMs >= PERSIST_IDLE_MS || sincePersist >= PERSIST_MAX_MS) {
        this.persistSession(session.id).catch(() => {});
      }
    }
  }

  async persistSession(id: number): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || session.isDead) return;

    const meta = await this.getMeta(id);
    const snap: SessionSnapshot = {
      version: 1,
      id,
      cmd: session.info().cmd,
      cols: session.cols,
      rows: session.rows,
      cwd: (meta.cwd as string) || undefined,
      createdAt: session.createdAt,
      savedAt: Date.now(),
      screen: session.snapshot(),
      meta,
    };

    // Atomic write: temp → rename
    const snapPath = resolve(this.runtimeDir, `snapshot-${id}.json`);
    const tmpPath = snapPath + '.tmp';
    await writeFile(tmpPath, JSON.stringify(snap));
    await rename(tmpPath, snapPath);

    session.markClean();
    this.lastPersistAt = Date.now();
  }

  /** Persist all sessions + workspace index (for shutdown) */
  async persistAll(): Promise<void> {
    const entries: WorkspaceState['sessions'] = [];

    for (const session of this.sessions.values()) {
      if (session.isDead) continue;
      try {
        await this.persistSession(session.id);
        entries.push({ id: session.id, snapshotFile: `snapshot-${session.id}.json` });
      } catch (e) {
        console.error(`[mgr] persist session=${session.id} failed:`, e);
      }
    }

    if (entries.length === 0) return;

    const ws: WorkspaceState = {
      version: 1,
      savedAt: Date.now(),
      nextId: this.nextId,
      sessions: entries,
    };

    const wsPath = resolve(this.runtimeDir, 'workspace.json');
    const tmpPath = wsPath + '.tmp';
    await writeFile(tmpPath, JSON.stringify(ws, null, 2));
    await rename(tmpPath, wsPath);

    console.log(`[mgr] workspace saved: ${entries.length} sessions`);
  }

  // ───── Session CRUD ─────

  async create(cmd: string[], cols: number, rows: number, cwd?: string): Promise<Session> {
    const id = this.nextId++;
    await this.persistNextId();

    const session = await Session.create(id, cmd, cols, rows, this.runtimeDir, cwd);
    this.sessions.set(id, session);

    session.onExit(() => {
      setTimeout(() => { if (this.sessions.get(id) === session) this.sessions.delete(id); }, 30_000);
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
      this.metas.delete(id);
      unlink(this.metaPath(id)).catch(() => {});
      unlink(resolve(this.runtimeDir, `snapshot-${id}.json`)).catch(() => {});
    }
  }

  /** Server shutdown: persist all, then disconnect from holders */
  async shutdown(): Promise<void> {
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }

    // Persist before shutdown
    await this.persistAll();
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
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
  }

  // ───── Session Meta ─────

  private metaPath(id: number): string {
    return resolve(this.runtimeDir, `meta-${id}.json`);
  }

  async getMeta(id: number): Promise<SessionMeta> {
    const cached = this.metas.get(id);
    if (cached) return cached;
    try {
      const raw = await readFile(this.metaPath(id), 'utf8');
      const meta = JSON.parse(raw) as SessionMeta;
      this.metas.set(id, meta);
      return meta;
    } catch {
      return {};
    }
  }

  async setMeta(id: number, patch: SessionMeta): Promise<SessionMeta> {
    const current = await this.getMeta(id);
    const merged = { ...current, ...patch };
    this.metas.set(id, merged);
    await writeFile(this.metaPath(id), JSON.stringify(merged, null, 2)).catch(() => {});
    return merged;
  }

  private reap(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      // Only clean up dead sessions — holder owns the PTY,
      // so detached sessions must survive until holder exits.
      if (session.isDead && session.diedAt > 0) {
        if (now - session.diedAt > 60_000) {
          this.sessions.delete(id);
        }
      }
    }
  }
}
