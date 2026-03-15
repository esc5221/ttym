// ───── Agent Bus — SQLite-backed message bus for inter-agent communication ─────

import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import type {
  AgentRegistration, AgentRecord, MessageEnvelope, MessageRecord,
  TaskCreate, TaskRecord, TaskUpdate, BusEvent,
} from './agent-types.js';

const REAP_INTERVAL = 30_000;    // 30s — stale agent reaper
const STALE_THRESHOLD = 90_000;  // 90s without heartbeat → offline

export class AgentBus extends EventEmitter {
  private db: Database.Database;
  private reapTimer: NodeJS.Timeout | null = null;

  constructor(dbPath: string) {
    super();
    mkdirSync(resolve(dbPath, '..'), { recursive: true });
    this.db = new Database(dbPath);

    // WAL mode + busy timeout
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');

    this.initSchema();
    this.reapTimer = setInterval(() => this.reapStaleAgents(), REAP_INTERVAL);
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        session_id INTEGER UNIQUE,
        status TEXT DEFAULT 'online',
        caps TEXT DEFAULT '[]',
        meta TEXT DEFAULT '{}',
        registered INTEGER NOT NULL,
        heartbeat INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT,
        from_agent TEXT NOT NULL REFERENCES agents(id),
        to_agent TEXT,
        type TEXT DEFAULT 'message',
        subject TEXT,
        body TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        read_at INTEGER,
        expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_msg_inbox ON messages(to_agent, status, created_at);

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'open',
        priority INTEGER DEFAULT 0,
        created_by TEXT NOT NULL REFERENCES agents(id),
        claimed_by TEXT REFERENCES agents(id),
        parent_id TEXT REFERENCES tasks(id),
        deps TEXT DEFAULT '[]',
        result TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        claimed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, priority DESC);
    `);
  }

  // ───── Agents ─────

  register(reg: AgentRegistration): AgentRecord {
    const now = Date.now();
    const caps = JSON.stringify(reg.caps ?? []);
    const meta = JSON.stringify(reg.meta ?? {});
    const status = reg.status ?? 'online';

    // Upsert: if agent already exists, update
    this.db.prepare(`
      INSERT INTO agents (id, name, type, session_id, status, caps, meta, registered, heartbeat)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        type = excluded.type,
        session_id = excluded.session_id,
        status = excluded.status,
        caps = excluded.caps,
        meta = excluded.meta,
        heartbeat = excluded.heartbeat
    `).run(reg.id, reg.name, reg.type, reg.session_id ?? null, status, caps, meta, now, now);

    const agent = this.getAgent(reg.id)!;
    this.emit('bus-event', { type: 'agent_joined', data: agent } as BusEvent);
    return agent;
  }

  heartbeat(id: string): boolean {
    const result = this.db.prepare(
      `UPDATE agents SET heartbeat = ?, status = 'online' WHERE id = ?`
    ).run(Date.now(), id);
    return result.changes > 0;
  }

  unregister(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM agents WHERE id = ?`).run(id);
    if (result.changes > 0) {
      this.emit('bus-event', { type: 'agent_left', data: { id } } as BusEvent);
      return true;
    }
    return false;
  }

  getAgent(id: string): AgentRecord | null {
    const row = this.db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as any;
    return row ? this.deserializeAgent(row) : null;
  }

  listAgents(): AgentRecord[] {
    const rows = this.db.prepare(`SELECT * FROM agents ORDER BY registered`).all() as any[];
    return rows.map(r => this.deserializeAgent(r));
  }

  updateAgent(id: string, patch: Partial<Pick<AgentRegistration, 'name' | 'status' | 'caps' | 'meta' | 'session_id'>>): AgentRecord | null {
    const agent = this.getAgent(id);
    if (!agent) return null;

    const sets: string[] = [];
    const values: unknown[] = [];

    if (patch.name !== undefined) { sets.push('name = ?'); values.push(patch.name); }
    if (patch.status !== undefined) { sets.push('status = ?'); values.push(patch.status); }
    if (patch.caps !== undefined) { sets.push('caps = ?'); values.push(JSON.stringify(patch.caps)); }
    if (patch.meta !== undefined) { sets.push('meta = ?'); values.push(JSON.stringify(patch.meta)); }
    if (patch.session_id !== undefined) { sets.push('session_id = ?'); values.push(patch.session_id); }

    if (sets.length === 0) return agent;

    values.push(id);
    this.db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getAgent(id);
  }

  private deserializeAgent(row: any): AgentRecord {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      session_id: row.session_id,
      status: row.status,
      caps: JSON.parse(row.caps || '[]'),
      meta: JSON.parse(row.meta || '{}'),
      registered: row.registered,
      heartbeat: row.heartbeat,
    };
  }

  // ───── Messages ─────

  send(envelope: MessageEnvelope): MessageRecord {
    const id = envelope.id || `msg_${randomUUID()}`;
    const thread_id = envelope.thread_id || null;
    const type = envelope.type || 'message';
    const status = envelope.status || 'pending';
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO messages (id, thread_id, from_agent, to_agent, type, subject, body, status, created_at, read_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, thread_id, envelope.from, envelope.to ?? null,
      type, envelope.subject ?? null, JSON.stringify(envelope.body),
      status, now, null, envelope.expires_at ?? null,
    );

    const msg = this.getMessage(id)!;
    this.emit('bus-event', { type: 'message', data: msg } as BusEvent);
    return msg;
  }

  inbox(agentId: string, opts?: { limit?: number; status?: string }): MessageRecord[] {
    const limit = opts?.limit ?? 50;
    const status = opts?.status ?? 'pending';

    const rows = this.db.prepare(`
      SELECT * FROM messages
      WHERE (to_agent = ? OR to_agent IS NULL)
        AND status = ?
      ORDER BY created_at ASC
      LIMIT ?
    `).all(agentId, status, limit) as any[];

    return rows.map(r => this.deserializeMessage(r));
  }

  markRead(messageId: string): boolean {
    const result = this.db.prepare(
      `UPDATE messages SET status = 'read', read_at = ? WHERE id = ?`
    ).run(Date.now(), messageId);
    return result.changes > 0;
  }

  updateMessage(messageId: string, patch: { status?: string }): boolean {
    if (!patch.status) return false;
    const result = this.db.prepare(
      `UPDATE messages SET status = ?, read_at = CASE WHEN ? = 'read' THEN ? ELSE read_at END WHERE id = ?`
    ).run(patch.status, patch.status, Date.now(), messageId);
    return result.changes > 0;
  }

  getMessage(id: string): MessageRecord | null {
    const row = this.db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as any;
    return row ? this.deserializeMessage(row) : null;
  }

  listMessages(opts?: { from?: string; to?: string; thread_id?: string; limit?: number }): MessageRecord[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (opts?.from) { conditions.push('from_agent = ?'); values.push(opts.from); }
    if (opts?.to) { conditions.push('to_agent = ?'); values.push(opts.to); }
    if (opts?.thread_id) { conditions.push('thread_id = ?'); values.push(opts.thread_id); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts?.limit ?? 100;
    values.push(limit);

    const rows = this.db.prepare(
      `SELECT * FROM messages ${where} ORDER BY created_at ASC LIMIT ?`
    ).all(...values) as any[];

    return rows.map(r => this.deserializeMessage(r));
  }

  broadcast(from: string, subject: string, body: unknown): MessageRecord {
    return this.send({ from, to: null, type: 'event', subject, body });
  }

  private deserializeMessage(row: any): MessageRecord {
    return {
      id: row.id,
      thread_id: row.thread_id,
      from_agent: row.from_agent,
      to_agent: row.to_agent,
      type: row.type,
      subject: row.subject,
      body: JSON.parse(row.body),
      status: row.status,
      created_at: row.created_at,
      read_at: row.read_at,
      expires_at: row.expires_at,
    };
  }

  // ───── Tasks ─────

  createTask(task: TaskCreate): TaskRecord {
    const id = `task_${randomUUID().slice(0, 8)}`;
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO tasks (id, title, description, status, priority, created_by, claimed_by, parent_id, deps, result, created_at, updated_at, claimed_at)
      VALUES (?, ?, ?, 'open', ?, ?, NULL, ?, ?, NULL, ?, ?, NULL)
    `).run(
      id, task.title, task.description ?? null,
      task.priority ?? 0, task.created_by,
      task.parent_id ?? null, JSON.stringify(task.deps ?? []),
      now, now,
    );

    return this.getTask(id)!;
  }

  /** Atomic claim — uses WHERE status='open' to prevent race */
  claimTask(taskId: string, agentId: string): TaskRecord | null {
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE tasks SET status = 'claimed', claimed_by = ?, claimed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'open'
    `).run(agentId, now, now, taskId);

    if (result.changes === 0) return null;

    const task = this.getTask(taskId)!;
    this.emit('bus-event', { type: 'task_assigned', data: task } as BusEvent);
    return task;
  }

  updateTask(taskId: string, update: TaskUpdate): TaskRecord | null {
    const task = this.getTask(taskId);
    if (!task) return null;

    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [Date.now()];

    if (update.status !== undefined) { sets.push('status = ?'); values.push(update.status); }
    if (update.result !== undefined) { sets.push('result = ?'); values.push(JSON.stringify(update.result)); }
    if (update.description !== undefined) { sets.push('description = ?'); values.push(update.description); }
    if (update.priority !== undefined) { sets.push('priority = ?'); values.push(update.priority); }

    values.push(taskId);
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);

    const updated = this.getTask(taskId)!;
    this.emit('bus-event', { type: 'task_updated', data: updated } as BusEvent);
    return updated;
  }

  getTask(id: string): TaskRecord | null {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as any;
    return row ? this.deserializeTask(row) : null;
  }

  listTasks(opts?: { status?: string; created_by?: string; claimed_by?: string }): TaskRecord[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (opts?.status) { conditions.push('status = ?'); values.push(opts.status); }
    if (opts?.created_by) { conditions.push('created_by = ?'); values.push(opts.created_by); }
    if (opts?.claimed_by) { conditions.push('claimed_by = ?'); values.push(opts.claimed_by); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(
      `SELECT * FROM tasks ${where} ORDER BY priority DESC, created_at ASC`
    ).all(...values) as any[];

    return rows.map(r => this.deserializeTask(r));
  }

  private deserializeTask(row: any): TaskRecord {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      created_by: row.created_by,
      claimed_by: row.claimed_by,
      parent_id: row.parent_id,
      deps: JSON.parse(row.deps || '[]'),
      result: row.result ? JSON.parse(row.result) : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      claimed_at: row.claimed_at,
    };
  }

  // ───── Stale Agent Reaper ─────

  private reapStaleAgents(): void {
    const cutoff = Date.now() - STALE_THRESHOLD;
    const stale = this.db.prepare(
      `SELECT id FROM agents WHERE heartbeat < ? AND status != 'offline'`
    ).all(cutoff) as { id: string }[];

    for (const { id } of stale) {
      this.db.prepare(`UPDATE agents SET status = 'offline' WHERE id = ?`).run(id);
      this.emit('bus-event', { type: 'agent_left', data: { id } } as BusEvent);
    }
  }

  // ───── Lifecycle ─────

  close(): void {
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }
    this.db.close();
  }
}
