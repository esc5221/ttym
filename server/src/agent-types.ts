// ───── Agent Bus Type Definitions ─────

export interface AgentRegistration {
  id: string;
  name: string;
  type: string;             // claude-code | codex | aider | custom
  session_id?: number;
  status?: string;          // online | busy | offline
  caps?: string[];
  meta?: Record<string, unknown>;
}

export interface AgentRecord {
  id: string;
  name: string;
  type: string;
  session_id: number | null;
  status: string;
  caps: string[];
  meta: Record<string, unknown>;
  registered: number;
  heartbeat: number;
}

export interface MessageEnvelope {
  id?: string;
  thread_id?: string;
  from: string;
  to?: string | null;       // null = broadcast
  type?: string;             // message | request | response | event
  subject?: string;
  body: unknown;             // JSON
  in_reply_to?: string;
  status?: string;           // pending | read
  expires_at?: number;
}

export interface MessageRecord {
  id: string;
  thread_id: string | null;
  from_agent: string;
  to_agent: string | null;
  type: string;
  subject: string | null;
  body: unknown;
  status: string;
  created_at: number;
  read_at: number | null;
  expires_at: number | null;
}

export interface TaskCreate {
  title: string;
  description?: string;
  priority?: number;
  created_by: string;
  parent_id?: string;
  deps?: string[];
}

export interface TaskRecord {
  id: string;
  title: string;
  description: string | null;
  status: string;            // open | claimed | in_progress | done | cancelled
  priority: number;
  created_by: string;
  claimed_by: string | null;
  parent_id: string | null;
  deps: string[];
  result: unknown;
  created_at: number;
  updated_at: number;
  claimed_at: number | null;
}

export interface TaskUpdate {
  status?: string;
  result?: unknown;
  description?: string;
  priority?: number;
}

export type BusEvent =
  | { type: 'message'; data: MessageRecord }
  | { type: 'task_assigned'; data: TaskRecord }
  | { type: 'task_updated'; data: TaskRecord }
  | { type: 'agent_joined'; data: AgentRecord }
  | { type: 'agent_left'; data: { id: string } };
