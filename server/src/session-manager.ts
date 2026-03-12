import { Session } from './session.js';

export class SessionManager {
  private sessions = new Map<number, Session>();
  private nextId = 1;

  create(cmd: string[], cols: number, rows: number): Session {
    const id = this.nextId++;
    const session = new Session(id, cmd, cols, rows);
    this.sessions.set(id, session);
    session.onExit(() => this.sessions.delete(id));
    return session;
  }

  get(id: number): Session | undefined {
    return this.sessions.get(id);
  }

  has(id: number): boolean {
    return this.sessions.has(id);
  }

  destroy(id: number) {
    const session = this.sessions.get(id);
    if (session) {
      session.kill();
      this.sessions.delete(id);
    }
  }

  destroyAll() {
    for (const session of this.sessions.values()) session.kill();
    this.sessions.clear();
  }
}
