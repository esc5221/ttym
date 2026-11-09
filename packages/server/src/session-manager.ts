import { readdir, readFile, readlink, unlink, mkdir, writeFile, rename, stat } from 'node:fs/promises';
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
  integrity?: 'healthy' | 'degraded';
  /** Per-row soft-wrap bits, base64. Stored so a resize can reflow later. */
  wrapFlags?: string;
  /** Cursor on the live screen (0-based). serialize() can leave it one cell short after trailing
   *  blanks; the restore puts it back here (2026-11-06: 2 of 232 prod screens). */
  cursor?: { x: number; y: number };
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
const PERSIST_CONCURRENCY = 2;   // 한 번에 저장하는 세션 수 (각 저장이 lsof와 3000줄 직렬화를 한다)
const RECOVER_CONCURRENCY = 24;  // 재시작 때 동시에 다시 붙는 holder 수
/** 이만큼 입력·출력이 없고 뷰어가 없으면 headless 터미널을 내린다(Session.goCold). TTYM_COLD_AFTER_MS=0이면 끔. */
const COLD_AFTER_MS = (() => {
  const raw = process.env.TTYM_COLD_AFTER_MS;
  if (raw === undefined || raw === '') return 5 * 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 5 * 60_000;
})();
const COLD_SWEEP_MS = Math.min(30_000, Math.max(1_000, COLD_AFTER_MS / 4 || 30_000));
const COLD_PER_SWEEP = 4; // 한 번에 내리는 수 — 각각 전체 직렬화(실측 p95 12ms)를 한다. 8개일 때 루프 최대 185ms(리허설)
const DEFAULT_SHELL = process.env.SHELL || '/bin/bash';

/** 세션 번호는 4자리를 넘지 않는다. 사람이 "%1297"처럼 부르고 적는 이름이라 짧아야 한다.
 *  9999 다음은 1로 돌아가 빈 번호를 찾는다. 하루 수십 개를 만들어도 한 바퀴에 몇 년이
 *  걸리므로, 돌아온 번호는 몇 년 전에 끝난 세션의 것이다. */
export const MAX_SESSION_ID = 9999;

/**
 * start부터 위로 훑어 첫 빈 번호를 고른다. max를 넘으면 1로 돌아가고, 한 바퀴를 다 돌아도
 * 없으면 null. 순수 함수 — 무엇이 "점유"인지는 taken이 정한다.
 */
export function pickSessionId(start: number, max: number, taken: (id: number) => boolean): number | null {
  let id = start >= 1 && start <= max ? start : 1;
  for (let i = 0; i < max; i++) {
    if (!taken(id)) return id;
    id = id >= max ? 1 : id + 1;
  }
  return null;
}

export class SessionManager {
  private sessions = new Map<number, Session>();
  private metas = new Map<number, SessionMeta>();
  private nextId = 1;
  private reapTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private lastPersistAt = 0;
  private persistSeq = 0;
  readonly runtimeDir: string;
  private _ready = false;
  private _busUrl: string | null = null;

  constructor(runtimeDir?: string) {
    this.runtimeDir = runtimeDir ?? getRuntimeDir();
    this.reapTimer = setInterval(() => this.reap(), REAP_INTERVAL);
    this.persistTimer = setInterval(() => this.checkPersist(), 1000);
    if (COLD_AFTER_MS > 0) {
      this.coldTimer = setInterval(() => { void this.coolIdle(); }, COLD_SWEEP_MS);
      this.coldTimer.unref?.();
    }
  }

  get ready(): boolean { return this._ready; }

  /** Set bus URL — injected by server after port is known */
  setBusUrl(url: string): void { this._busUrl = url; }

  /** 이 서버 밖의 장부가 아직 붙들고 있는 번호 — workspace 멤버, 뷰어 탭. 서버가 주입한다.
   *  번호가 돌아올 때 옛 세션을 가리키던 멤버·탭이 새 세션에 붙으면 안 된다. */
  private idReferenced: (id: number) => boolean = () => false;
  setIdReferenced(fn: (id: number) => boolean): void { this.idReferenced = fn; }

  /**
   * Boot: create runtime dir, recover existing holders, then mark ready.
   * If `restoreAllowlist` is provided, only sessions whose IDs are in the set
   * will be restored from snapshots; others stay on disk untouched.
   */
  async boot(restoreAllowlist?: Set<number>): Promise<void> {
    await this.bootPrepare();
    await this.bootFinish(restoreAllowlist);
  }

  /**
   * 복원 전에 끝내야 하는 것만: 다음 id와 복원할 세션 목록(자리표시). 서버는 이 뒤에 바로 listen하고
   * bootFinish를 기다리지 않는다 — 압박 중 재시작에서 세션 196개 복원이 2분 걸렸고(2026-11-08), 그동안
   * 포트가 닫혀 있어 웹도 CLI도 못 붙었다. 아직 안 돌아온 세션으로 온 요청은 whenRecovered로 기다린다.
   */
  async bootPrepare(): Promise<void> {
    await mkdir(this.runtimeDir, { recursive: true });

    // Load persisted next-id
    const idFile = resolve(this.runtimeDir, 'next-id');
    try {
      const raw = await readFile(idFile, 'utf8');
      this.nextId = parseInt(raw.trim(), 10) || 1;
    } catch {}

    // 복원이 끝나기 전에 새 세션이 생겨도 아직 안 돌아온 세션의 id를 받지 않게, 디스크에 있는 id를 먼저 센다.
    let files: string[] = [];
    try { files = await readdir(this.runtimeDir); } catch {}
    for (const f of files) {
      const m = /^(?:session|snapshot)-(\d+)\.json$/.exec(f);
      if (m) this.nextId = Math.max(this.nextId, parseInt(m[1]!, 10) + 1);
      if (!m || !f.startsWith('session-')) continue;
      try {
        const manifest = JSON.parse(await readFile(resolve(this.runtimeDir, f), 'utf8')) as HolderManifest;
        if (typeof manifest.id === 'number') this.pending.set(manifest.id, manifest);
      } catch {}
    }
  }

  /** holder 복원 + 스냅샷 복원. 끝나면 ready. 여러 번 불러도 한 번만 돈다. */
  bootFinish(restoreAllowlist?: Set<number>): Promise<void> {
    this.bootDone ??= (async () => {
      try {
        // Discover and recover holders
        await this.recover();
        // Always attempt snapshot-based restore: holders may cover some sessions,
        // remaining snapshots fill the gaps. Both code paths preserve original IDs.
        await this.restoreWorkspace(restoreAllowlist);
      } finally {
        this._ready = true;
        // 다시 시도 중인 것(recovering)만 자리표시로 남기고 나머지 대기는 푼다 — 없는 세션은 평소처럼 404.
        for (const id of [...this.pending.keys()]) if (!this.recovering.has(id)) this.settle(id);
      }
    })();
    return this.bootDone;
  }

  private bootDone: Promise<void> | null = null;
  /** 아직 다시 붙지 않은 holder 세션 — 목록에는 recovering으로 보인다. */
  private pending = new Map<number, HolderManifest>();
  private pendingWaiters = new Map<number, Array<() => void>>();

  isPending(id: number): boolean { return this.pending.has(id); }

  /**
   * 세션 하나가 돌아온 직후, 기다리던 요청을 놓기 전에 부르는 것(서버: 재우기 상태 되살리기). 서버가
   * expectRecoveredHook()을 불렀으면 훅이 놓일 때까지 복원된 세션도 기다린다 — 훅보다 입력이 먼저 가면 안 된다.
   */
  private recoveredHook: ((id: number) => Promise<void>) | null = null;
  private hookReady: Promise<void> = Promise.resolve();
  private releaseHook: () => void = () => {};
  expectRecoveredHook(): void {
    this.hookReady = new Promise((r) => { this.releaseHook = r; });
  }
  setRecoveredHook(fn: (id: number) => Promise<void>): void {
    this.recoveredHook = fn;
    this.releaseHook();
  }
  private async runRecoveredHook(id: number): Promise<void> {
    await this.hookReady;
    try { await this.recoveredHook?.(id); } catch (e) { console.error(`[mgr] recovered hook session=${id} failed:`, e); }
  }

  /** 그 세션이 복원을 마칠 때까지(또는 포기할 때까지, 최대 maxMs) 기다린다. 복원 대상이 아니면 바로 끝난다. */
  whenRecovered(id: number, maxMs = 60_000): Promise<void> {
    if (!this.pending.has(id)) return Promise.resolve();
    this.demand(id);
    return new Promise((resolveWait) => {
      const timer = setTimeout(done, maxMs);
      timer.unref?.();
      function done() { clearTimeout(timer); resolveWait(); }
      const list = this.pendingWaiters.get(id) ?? [];
      list.push(done);
      this.pendingWaiters.set(id, list);
    });
  }

  /** 그 id의 복원이 끝났다(성공이든 아니든) — 기다리던 요청을 놓아준다. */
  private settle(id: number): void {
    this.pending.delete(id);
    const waiters = this.pendingWaiters.get(id);
    this.pendingWaiters.delete(id);
    for (const w of waiters ?? []) w();
  }

  /** 모든 복원(재시도 제외)이 끝났을 때 */
  get recovered(): Promise<void> { return this.bootDone ?? Promise.resolve(); }

  private async recover(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(this.runtimeDir);
    } catch { return; }

    const manifests = files.filter((f) => f.startsWith('session-') && f.endsWith('.json'));
    // 최근에 쓰던 세션부터 — 체크포인트가 늦게 저장된 순. 재시작 직후 사람이 다시 여는 건 대개 이쪽이다.
    const touched = new Map<string, number>();
    await Promise.all(manifests.map(async (f) => {
      const id = /^session-(\d+)\.json$/.exec(f)?.[1];
      try { touched.set(f, (await stat(resolve(this.runtimeDir, `snapshot-${id}.json`))).mtimeMs); } catch { touched.set(f, 0); }
    }));
    manifests.sort((a, b) => (touched.get(b) ?? 0) - (touched.get(a) ?? 0));

    // Recover concurrently. A holder that never answers its handshake blocks
    // for 10s (session.ts), and recovering in sequence made every later session
    // queue behind it — worst case scaled with session count. Now the whole
    // pass costs one timeout, not one per stuck holder.
    // 동시에 RECOVER_CONCURRENCY개까지 — 187개를 한꺼번에 파싱하면 메모리가 튀고 handshake가 밀린다.
    // 기다리는 요청(입력·ATTACH·API)이 있는 세션은 줄 맨 앞으로(demand) — 압박 중 재시작에서 사람이 치던
    // pane이 191개 중 마지막에 돌아와 첫 키가 60초 걸렸다(2026-11-08 벤치).
    this.recoverQueue = manifests;
    this.queueBuilt = true;
    for (const id of this.demanded) this.demand(id);
    this.demanded.clear();
    const worker = async () => {
      let f: string | undefined;
      while ((f = this.recoverQueue.shift()) !== undefined) await this.recoverOne(f);
    };
    const n = Number(process.env.TTYM_TEST_RECOVER_CONCURRENCY || 0) || RECOVER_CONCURRENCY;
    await Promise.all(Array.from({ length: Math.min(n, manifests.length) }, worker));
  }

  /** 아직 시작 안 한 복원 줄 */
  private recoverQueue: string[] = [];
  /** 줄이 만들어지기 전에 요청이 온 id */
  private demanded = new Set<number>();
  private queueBuilt = false;
  /**
   * 다시 시도를 기다리는 세션 — 요청이 오면 예정보다 일찍 한 번 더 시도한다. 일찍 하는 시도는 예정된 재시도
   * 예산(RETRY_MS)을 쓰지 않고, 같은 세션에 EARLY_RETRY_MIN_MS보다 자주 하지 않는다. 그러지 않으면 요청 몇 개로
   * 몇 분짜리 재시도가 몇백 ms에 다 끝나, holder가 조금 뒤 돌아와도 포기한 상태로 남았다(2026-11-09 리뷰 재현).
   */
  private retryTimers = new Map<number, () => void>();
  private lastEarlyRetry = new Map<number, number>();
  private static readonly EARLY_RETRY_MIN_MS = 2_000;

  /** 그 세션을 기다리는 요청이 있다 — 아직 줄에 있으면 맨 앞으로, 다시 시도 대기 중이면 지금 시도. */
  private demand(id: number): void {
    const f = `session-${id}.json`;
    const i = this.recoverQueue.indexOf(f);
    if (i > 0) { this.recoverQueue.splice(i, 1); this.recoverQueue.unshift(f); }
    else if (i < 0 && !this.queueBuilt) this.demanded.add(id);
    this.retryTimers.get(id)?.();
  }

  /**
   * holder는 살아 있는데 handshake를 못 마친 세션. manifest를 지우지 않고 다시 시도한다.
   * 예전에는 manifest를 지웠고, 이어진 restoreWorkspace가 같은 id로 새 셸을 띄워 원래 holder(와 그 안의
   * claude)를 화면 밖 고아로 만들었다(2026-11-05 prod %1594~1603).
   */
  private recovering = new Set<number>();
  private static readonly RETRY_MS = [5_000, 15_000, 45_000, 120_000];

  /**
   * lease 거절로 건너뛴 세션 id들 — 다른 살아있는 서버의 소유물.
   * restoreWorkspace가 이 id를 '죽은 세션'으로 읽고 같은 id로 부활시키면
   * 사칭 holder가 세션 신원을 강탈한다(2026-08-13 dev 사고). 절대 금지.
   */
  private heldByOthers = new Set<number>();

  private async recoverOne(filename: string, attempt = 0): Promise<void> {
    const manifestPath = resolve(this.runtimeDir, filename);
    // 테스트 전용: 복원을 일부러 늦춰 '복원 중' 상태를 관찰한다(boot-early.test.ts).
    const testDelay = Number(process.env.TTYM_TEST_RECOVER_DELAY_MS || 0);
    if (testDelay > 0) await new Promise((r) => setTimeout(r, testDelay));
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
        this.settle(manifest.id);
        return;
      }

      // A checkpoint for this same holder covers far more scrollback than the
      // ring does, so hand it over rather than letting the ring alone rebuild
      // the screen.
      const checkpoint = await this.readCheckpoint(manifest.id);
      const session = await Session.recover(manifest, this.runtimeDir, false, checkpoint);
      this.sessions.set(session.id, session);
      this.recovering.delete(session.id);
      this.nextId = Math.max(this.nextId, session.id + 1);
      // 훅(재우기 상태)은 미뤄 둔 요청보다 먼저. bootFinish가 이 세션을 '끝남'으로 놓기 전에 마쳐야 한다.
      // Load persisted meta
      await this.getMeta(session.id);
      await this.runRecoveredHook(session.id);
      this.settle(session.id);
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
        const idMatch = filename.match(/session-(\d+)\.json$/);
        if (idMatch) { this.heldByOthers.add(parseInt(idMatch[1], 10)); this.settle(parseInt(idMatch[1], 10)); }
        console.log(`[mgr] ${filename} held by another server, leaving it alone`);
        return;
      }
      const idMatch = filename.match(/session-(\d+)\.json$/);
      const sid = idMatch ? parseInt(idMatch[1]!, 10) : NaN;
      let alive = false;
      try {
        const m: HolderManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        process.kill(m.pid, 0);
        alive = true;
      } catch {}
      if (alive && Number.isFinite(sid)) {
        this.recovering.add(sid);
        const delay = SessionManager.RETRY_MS[attempt];
        if (delay !== undefined) {
          console.error(`[mgr] recover ${filename} failed (attempt ${attempt + 1}): ${(e as Error)?.message ?? e} — holder alive, retry in ${delay}ms`);
          const scheduled = () => { this.retryTimers.delete(sid); void this.recoverOne(filename, attempt + 1); };
          const t = setTimeout(scheduled, delay);
          t.unref?.();
          // 요청이 앞당긴 시도: 같은 attempt로(예산을 안 씀). 실패하면 그 시도가 같은 간격으로 다시 예약한다.
          const early = () => {
            const now = Date.now();
            if (now - (this.lastEarlyRetry.get(sid) ?? 0) < SessionManager.EARLY_RETRY_MIN_MS) return;
            this.lastEarlyRetry.set(sid, now);
            clearTimeout(t);
            this.retryTimers.delete(sid);
            void this.recoverOne(filename, attempt);
          };
          this.retryTimers.set(sid, early);
        } else {
          console.error(`[mgr] recover ${filename} gave up after ${attempt + 1} attempts — holder alive, manifest kept`);
          this.settle(sid);
        }
        return;
      }
      console.error(`[mgr] failed to recover ${filename}:`, e);
      await unlink(manifestPath).catch(() => {});
      if (Number.isFinite(sid)) this.settle(sid);
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
      // 아직 다시 붙는 중인 holder — 새 셸로 부활시키면 원래 holder가 고아가 된다.
      if (this.recovering.has(snap.id)) {
        console.log(`[mgr] session=${snap.id} holder alive, recovery retrying — not resurrecting`);
        continue;
      }
      // 소유권이 다른 서버에 있는 id — 부재가 아니라 점유다. 부활은 강탈이 된다.
      if (this.heldByOthers.has(snap.id)) {
        console.log(`[mgr] session=${snap.id} held by another server — not resurrecting`);
        continue;
      }

      const cwd = snap.cwd && existsSync(snap.cwd) ? snap.cwd : process.env.HOME || '/tmp';

      try {
        // Preserve original sessionId so URLs and workspace layouts keep working.
        // The same env a fresh session gets: without TTYM_PORT here, a pane the
        // boot re-spawned had its agent hooks talking to whatever listens on 7690
        // — on a dev server that was production, and another server's session id.
        const session = await Session.create(
          snap.id, snap.cmd, snap.cols, snap.rows, this.runtimeDir, cwd,
          { ...this.extraSessionEnv, TTYM_SESSION_ID: String(snap.id) },
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

  private coldTimer: ReturnType<typeof setInterval> | null = null;

  private cooling = false;

  /** 쉬는 세션의 터미널을 내린다(하나씩, 각자 왕복 검증). 반환: 이번에 내린 수 */
  async coolIdle(now = Date.now(), idleMs = COLD_AFTER_MS): Promise<number> {
    if (this.cooling) return 0;
    this.cooling = true;
    let n = 0;
    try {
      for (const session of [...this.sessions.values()]) {
        if (n >= COLD_PER_SWEEP) break;
        if (!session.canGoCold(now, idleMs)) continue;
        try { if (await session.goCold()) n++; } catch (e) { console.error(`[mgr] cold session=${session.id} failed:`, e); }
      }
    } finally {
      this.cooling = false;
    }
    return n;
  }

  /** 저장 중인 세션 — 같은 세션의 저장을 겹쳐 시작하지 않는다(같은 .tmp를 두 번 쓰던 경쟁). */
  private persisting = new Set<number>();
  /** 세션별 마지막 저장 시각. 전역 하나였을 때는 30초가 지나면 모든 dirty 세션을 매초 다시 저장했다. */
  private persistedAt = new Map<number, number>();

  private checkPersist(): void {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (this.persisting.size >= PERSIST_CONCURRENCY) return;
      if (session.isDead || !session.dirty || this.persisting.has(session.id)) continue;

      const idleMs = now - session.lastDirtyAt;
      const sincePersist = now - (this.persistedAt.get(session.id) ?? 0);

      // Flush after 2s idle or 30s max
      if (idleMs >= PERSIST_IDLE_MS || sincePersist >= PERSIST_MAX_MS) {
        this.persisting.add(session.id);
        this.persistSession(session.id).catch(() => {}).finally(() => {
          this.persisting.delete(session.id);
          this.persistedAt.set(session.id, Date.now());
        });
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

    // 화면·offset·크기는 같은 틱에서 함께 읽는다(아래 객체 리터럴). rev는 그 순간의 것.
    const rev = session.rev;
    const snap: SessionSnapshot = {
      version: 1,
      // Where this screen sits in the holder's byte stream, and which holder
      // incarnation it belongs to. Recovery seeds from here and replays only
      // what came after.
      generation: session.generation,
      appliedThroughOffset: session.appliedOffset,
      wrapFlags: session.wrapFlags(),
      cursor: session.cursorPos() ?? undefined,
      id,
      cmd: session.info().cmd,
      cols: session.cols,
      rows: session.rows,
      cwd,
      createdAt: session.createdAt,
      savedAt: Date.now(),
      // A degraded screen may be checkpointed (offset continuity is still
      // real) but must never become the next recovery's trusted base.
      integrity: session.integrity,
      screen: session.snapshot(),
      meta: { ...meta, cwd: cwd ?? meta.cwd },
    };

    // Atomic write: temp → rename
    const snapPath = resolve(this.runtimeDir, `snapshot-${id}.json`);
    const tmpPath = `${snapPath}.${process.pid}.${++this.persistSeq}.tmp`;
    await writeFile(tmpPath, JSON.stringify(snap));
    await rename(tmpPath, snapPath);

    session.markCleanIf(rev);
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

  /** Values every session env carries, e.g. TTYM_PORT once the server is listening. */
  private extraSessionEnv: Record<string, string> = {};

  setExtraSessionEnv(env: Record<string, string>): void {
    this.extraSessionEnv = { ...this.extraSessionEnv, ...env };
  }

  async create(cmd: string[], cols: number, rows: number, cwd?: string): Promise<Session> {
    const id = await this.allocateId();

    const extraEnv: Record<string, string> = { ...this.extraSessionEnv, TTYM_SESSION_ID: String(id) };
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

  /**
   * 다음 번호를 고른다. 9999 안에서 돌고, 디스크에 흔적(holder manifest·meta·snapshot·
   * 잠든 화면)이 남은 번호나 다른 장부가 참조하는 번호는 건너뛴다. 흔적이 남은 번호를
   * 재사용하면 새 세션이 옛 세션의 meta(cwd·에이전트 상태)를 물려받는다.
   */
  private async allocateId(): Promise<number> {
    let files: Set<string>;
    try { files = new Set(await readdir(this.runtimeDir)); } catch { files = new Set(); }
    const id = pickSessionId(this.nextId, MAX_SESSION_ID, (c) =>
      this.sessions.has(c) ||
      this.heldByOthers.has(c) ||
      files.has(`session-${c}.json`) ||
      files.has(`meta-${c}.json`) ||
      files.has(`snapshot-${c}.json`) ||
      files.has(`sleep-${c}.ansi`) ||
      this.idReferenced(c));
    if (id === null) throw new Error(`no free session id: all ${MAX_SESSION_ID} are in use`);
    this.nextId = id + 1;
    await this.persistNextId();
    return id;
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
    // 아직 복원 중인 세션은 자리표시로 — 빠지면 클라이언트가 그 멤버를 '없는 세션'으로 그린다.
    for (const [id, m] of this.pending) {
      if (this.sessions.has(id)) continue;
      result.push({
        id, pid: m.childPid, cmd: m.cmd, cols: m.cols, rows: m.rows, status: 'detached',
        viewerCount: 0, lastSeq: 0, createdAt: m.createdAt, detachedAt: null, recovering: true,
      });
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
    if (this.coldTimer) {
      clearInterval(this.coldTimer);
      this.coldTimer = null;
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
    if (this.coldTimer) {
      clearInterval(this.coldTimer);
      this.coldTimer = null;
    }
  }

  // ───── Session Meta ─────

  /**
   * Load a session's checkpoint if one is on disk. Returns undefined when there
   * is none or it predates offset tracking — recovery then replays the ring.
   */
  private async readCheckpoint(id: number): Promise<{ generation: string; offset: number; screen: string; cursor?: { x: number; y: number } } | undefined> {
    try {
      const raw = await readFile(resolve(this.runtimeDir, `snapshot-${id}.json`), 'utf8');
      const snap = JSON.parse(raw) as SessionSnapshot;
      if (!snap.screen || typeof snap.appliedThroughOffset !== 'number') return undefined;
      if (snap.integrity === 'degraded') return undefined;
      return { generation: snap.generation ?? '', offset: snap.appliedThroughOffset, screen: snap.screen, cursor: snap.cursor };
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
