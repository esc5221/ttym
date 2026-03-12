import { Session, SessionInfo } from './session.js';

const DEFAULT_DETACHED_TTL = 5 * 60 * 1000; // 5분
const REAP_INTERVAL = 30 * 1000;            // 30초마다 체크

export class SessionManager {
  private sessions = new Map<number, Session>();
  private nextId = 1;
  private reapTimer: NodeJS.Timeout | null = null;
  private readonly detachedTtl: number;

  constructor(detachedTtl = DEFAULT_DETACHED_TTL) {
    this.detachedTtl = detachedTtl;
    this.reapTimer = setInterval(() => this.reap(), REAP_INTERVAL);
  }

  create(cmd: string[], cols: number, rows: number): Session {
    const id = this.nextId++;
    const session = new Session(id, cmd, cols, rows);
    this.sessions.set(id, session);
    session.onExit(() => {
      // dead 세션은 30초 후 정리 (클라이언트가 DESTROY 받을 시간)
      setTimeout(() => this.sessions.delete(id), 30_000);
    });
    return session;
  }

  get(id: number): Session | undefined {
    return this.sessions.get(id);
  }

  has(id: number): boolean {
    return this.sessions.has(id);
  }

  /** 살아있는 세션 목록 */
  list(): SessionInfo[] {
    const result: SessionInfo[] = [];
    for (const s of this.sessions.values()) {
      if (!s.isDead) result.push(s.info());
    }
    return result;
  }

  /** WebSocket 끊김 시: 해당 viewer를 모든 세션에서 제거 */
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

  destroyAll(): void {
    for (const session of this.sessions.values()) session.kill();
    this.sessions.clear();
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }
  }

  /** TTL 초과된 detached 세션 정리 */
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
