import { readdir, readFile, readlink, unlink, mkdir, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Session, SessionInfo, HolderManifest, getRuntimeDir , ControllerHeldError } from './session.js';

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
  /** Holder incarnation this screen belongs to; a mismatch invalidates it. */
  generation?: string;
  /** Stream offset the screen has been advanced through. */
  appliedThroughOffset?: number;
  /** Per-row soft-wrap bits, base64. Stored so a resize can reflow later. */
  wrapFlags?: string;
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
  private _busUrl: string | null = null;

  constructor(runtimeDir?: string) {
    this.runtimeDir = runtimeDir ?? getRuntimeDir();
    this.reapTimer = setInterval(() => this.reap(), REAP_INTERVAL);
    this.persistTimer = setInterval(() => this.checkPersist(), 1000);
  }

  get ready(): boolean { return this._ready; }

  /** Set bus URL — injected by server after port is known */
  setBusUrl(url: string): void { this._busUrl = url; }

  /**
   * Boot: create runtime dir, recover existing holders, then mark ready.
   * If `restoreAllowlist` is provided, only sessions whose IDs are in the set
   * will be restored from snapshots; others stay on disk untouched.
   */
  async boot(restoreAllowlist?: Set<number>): Promise<void> {
    await mkdir(this.runtimeDir, { recursive: true });

    // Load persisted next-id
    const idFile = resolve(this.runtimeDir, 'next-id');
    try {
      const raw = await readFile(idFile, 'utf8');
      this.nextId = parseInt(raw.trim(), 10) || 1;
    } catch {}

    // Discover and recover holders
    await this.recover();

    // Always attempt snapshot-based restore: holders may cover some sessions,
    // remaining snapshots fill the gaps. Both code paths preserve original IDs.
    await this.restoreWorkspace(restoreAllowlist);

    this._ready = true;
  }

  private async recover(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(this.runtimeDir);
    } catch { return; }

    const manifests = files.filter((f) => f.startsWith('session-') && f.endsWith('.json'));

    // Recover concurrently. A holder that never answers its handshake blocks
    // for 10s (session.ts), and recovering in sequence made every later session
    // queue behind it — worst case scaled with session count. Now the whole
    // pass costs one timeout, not one per stuck holder.
    await Promise.all(manifests.map((filename) => this.recoverOne(filename)));
  }

  private async recoverOne(filename: string): Promise<void> {
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
        return;
      }

      // A checkpoint for this same holder covers far more scrollback than the
      // ring does, so hand it over rather than letting the ring alone rebuild
      // the screen.
      const checkpoint = await this.readCheckpoint(manifest.id);
      const session = await Session.recover(manifest, this.runtimeDir, false, checkpoint);
      this.sessions.set(session.id, session);
      this.nextId = Math.max(this.nextId, session.id + 1);

      // Load persisted meta
      await this.getMeta(session.id);
      console.log(
        `[mgr] recovered session=${session.id} pid=${manifest.childPid}` +
        (checkpoint ? ` via checkpoint@${checkpoint.offset}${session.recoveryGap ? ' GAP' : ''}` : ''),
      );

      // Wire exit cleanup (check identity to avoid deleting a replaced session)
      session.onExit(() => {
        const sid = session.id;
        setTimeout(() => { if (this.sessions.get(sid) === session) this.sessions.delete(sid); }, 30_000);
      });
    } catch (e) {
      if (e instanceof ControllerHeldError) {
        // Another server is driving this session. Its manifest is correct and
        // must survive — deleting it here is how a losing server used to strand
        // a live holder.
        console.log(`[mgr] ${filename} held by another server, leaving it alone`);
        return;
      }
      console.error(`[mgr] failed to recover ${filename}:`, e);
      await unlink(manifestPath).catch(() => {});
    }
  }

  // ───── Workspace Restore (reboot recovery) ─────

  private async restoreWorkspace(allowlist?: Set<number>): Promise<void> {
    // Prefer workspace.json (graceful shutdown index). If missing or unreadable,
    // fall back to scanning snapshot-*.json directly — this is what saves us
    // when shutdown was killed before the index could be written.
    const wsPath = resolve(this.runtimeDir, 'workspace.json');
    let snapshotFiles: string[] = [];

    if (existsSync(wsPath)) {
      try {
        const ws: WorkspaceState = JSON.parse(await readFile(wsPath, 'utf8'));
        if (ws.version === 1 && Array.isArray(ws.sessions)) {
          snapshotFiles = ws.sessions.map((e) => e.snapshotFile);
        }
      } catch {
        /* fall through to directory scan */
      }
    }

    if (snapshotFiles.length === 0) {
      try {
        const files = await readdir(this.runtimeDir);
        snapshotFiles = files.filter((f) => /^snapshot-\d+\.json$/.test(f));
      } catch {
        return;
      }
    }

    // Filter to allowlist if provided — restore only sessions that some
    // workspace actually cares about. Untouched snapshots stay on disk so
    // they can be revived later by adding them back to a workspace.
    if (allowlist) {
      snapshotFiles = snapshotFiles.filter((f) => {
        const m = f.match(/^snapshot-(\d+)\.json$/);
        return m ? allowlist.has(parseInt(m[1], 10)) : false;
      });
    }

    if (snapshotFiles.length === 0) {
      await unlink(wsPath).catch(() => {});
      return;
    }

    console.log(`[mgr] restoring workspace: ${snapshotFiles.length} snapshot(s)`);

    for (const filename of snapshotFiles) {
      const snapPath = resolve(this.runtimeDir, filename);
      let snap: SessionSnapshot;
      try {
        snap = JSON.parse(await readFile(snapPath, 'utf8'));
      } catch {
        console.log(`[mgr] snapshot unreadable: ${filename}, skipping`);
        continue;
      }

      // Holder already brought this session back, and recovery seeded the
      // terminal from this very checkpoint. Keep the file: it is the larger and
      // more accurate record of the screen, and deleting it here is what forced
      // every swap to rebuild from the smaller raw ring instead.
      if (this.sessions.has(snap.id)) {
        continue;
      }

      const cwd = snap.cwd && existsSync(snap.cwd) ? snap.cwd : process.env.HOME || '/tmp';

      try {
        // Preserve original sessionId so URLs and workspace layouts keep working.
        const session = await Session.create(
          snap.id, snap.cmd, snap.cols, snap.rows, this.runtimeDir, cwd,
        );
        this.sessions.set(session.id, session);
        this.nextId = Math.max(this.nextId, snap.id + 1);

        if (snap.screen) {
          session.seedSnapshot(snap.screen + '\r\n\x1b[90m── restored ──\x1b[0m\r\n');
        }

        if (snap.meta && Object.keys(snap.meta).length > 0) {
          await this.setMeta(snap.id, snap.meta);
        }

        session.onExit(() => {
          const sid = session.id;
          setTimeout(() => { if (this.sessions.get(sid) === session) this.sessions.delete(sid); }, 30_000);
        });

        console.log(`[mgr] restored session=${snap.id} cwd=${cwd}`);
      } catch (e) {
        console.error(`[mgr] failed to restore session=${snap.id}:`, e);
      }

      // Drop the snapshot once consumed; persistAll will rewrite a fresh one.
      await unlink(snapPath).catch(() => {});
    }

    await this.persistNextId();
    await unlink(wsPath).catch(() => {});

    // Clean stale socket files belonging to no live session
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

    // Read the child shell's live cwd so `cd` inside the PTY survives restore.
    // Falls back to meta.cwd (recorded at create time) if the lookup fails.
    let liveCwd: string | undefined;
    if (session.childPid > 0) {
      liveCwd = await readPidCwd(session.childPid).catch(() => undefined);
    }
    const cwd = liveCwd || (meta.cwd as string) || undefined;
    if (liveCwd && liveCwd !== meta.cwd) {
      await this.setMeta(id, { cwd: liveCwd }).catch(() => {});
    }

    const snap: SessionSnapshot = {
      version: 1,
      // Where this screen sits in the holder's byte stream, and which holder
      // incarnation it belongs to. Recovery seeds from here and replays only
      // what came after.
      generation: session.generation,
      appliedThroughOffset: session.appliedOffset,
      wrapFlags: session.wrapFlags(),
      id,
      cmd: session.info().cmd,
      cols: session.cols,
      rows: session.rows,
      cwd,
      createdAt: session.createdAt,
      savedAt: Date.now(),
      screen: session.snapshot(),
      meta: { ...meta, cwd: cwd ?? meta.cwd },
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

    const extraEnv: Record<string, string> = { TTYM_SESSION_ID: String(id) };
    if (this._busUrl) extraEnv.TTYM_BUS_URL = this._busUrl;

    const resolvedCwd = cwd || process.env.HOME || '/tmp';
    const session = await Session.create(id, cmd, cols, rows, this.runtimeDir, resolvedCwd, extraEnv);
    this.sessions.set(id, session);
    await this.setMeta(id, { cwd: resolvedCwd });

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

  /**
   * Load a session's checkpoint if one is on disk. Returns undefined when there
   * is none or it predates offset tracking — recovery then replays the ring.
   */
  private async readCheckpoint(id: number): Promise<{ generation: string; offset: number; screen: string } | undefined> {
    try {
      const raw = await readFile(resolve(this.runtimeDir, `snapshot-${id}.json`), 'utf8');
      const snap = JSON.parse(raw) as SessionSnapshot;
      if (!snap.screen || typeof snap.appliedThroughOffset !== 'number') return undefined;
      return { generation: snap.generation ?? '', offset: snap.appliedThroughOffset, screen: snap.screen };
    } catch {
      return undefined;
    }
  }

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

/**
 * Resolve the live cwd of a running process by pid.
 * Linux: read /proc/<pid>/cwd symlink.
 * macOS: shell out to lsof (no /proc on Darwin).
 * Returns undefined if the lookup fails or the platform isn't supported.
 */
async function readPidCwd(pid: number): Promise<string | undefined> {
  if (!pid || pid <= 0) return undefined;
  if (process.platform === 'linux') {
    try { return await readlink(`/proc/${pid}/cwd`); } catch { return undefined; }
  }
  if (process.platform === 'darwin') {
    return await new Promise<string | undefined>((resolveCwd) => {
      let out = '';
      let settled = false;
      const finish = (val: string | undefined) => {
        if (settled) return;
        settled = true;
        resolveCwd(val);
      };
      try {
        const proc = spawn('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        proc.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
        proc.on('error', () => finish(undefined));
        proc.on('exit', () => {
          const match = out.match(/^n(.+)$/m);
          finish(match ? match[1].trim() : undefined);
        });
        // Belt-and-suspenders timeout in case lsof hangs
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} finish(undefined); }, 1500);
      } catch {
        finish(undefined);
      }
    });
  }
  return undefined;
}
