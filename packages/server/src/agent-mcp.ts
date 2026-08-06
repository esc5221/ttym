#!/usr/bin/env node
// ───── ttym Agent MCP Server ─────
// Standalone process that wraps AgentBus HTTP API as MCP tools.
// Designed to be registered in Claude Code's .mcp.json.
// Communicates via stdin/stdout (MCP stdio transport).

import { createInterface } from 'node:readline';

const BUS_URL = process.env.TTYM_BUS_URL || 'http://127.0.0.1:7690/api';

// ───── HTTP helpers ─────

async function busGet(path: string): Promise<unknown> {
  const res = await fetch(`${BUS_URL}${path}`);
  return res.json();
}

async function busPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BUS_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function busPatch(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BUS_URL}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ───── MCP Tool definitions ─────

const TOOLS = [
  {
    name: 'ttym_register',
    description: 'Register this agent with the ttym bus. Call once at startup.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Unique agent ID (e.g. claude-1)' },
        name: { type: 'string', description: 'Human-readable name' },
        type: { type: 'string', description: 'Agent type: claude-code | codex | aider | custom' },
        session_id: { type: 'number', description: 'ttym session ID (from TTYM_SESSION_ID env)' },
      },
      required: ['id', 'name', 'type'],
    },
  },
  {
    name: 'ttym_send',
    description: 'Send a message to another agent or broadcast (omit "to" for broadcast).',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Sender agent ID' },
        to: { type: 'string', description: 'Recipient agent ID (omit for broadcast)' },
        subject: { type: 'string', description: 'Message subject' },
        body: { description: 'Message body (any JSON)' },
        type: { type: 'string', description: 'message | request | response | event' },
        thread_id: { type: 'string', description: 'Thread ID for conversation threading' },
      },
      required: ['from', 'body'],
    },
  },
  {
    name: 'ttym_inbox',
    description: 'Check inbox for pending messages addressed to this agent.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Agent ID to check inbox for' },
        limit: { type: 'number', description: 'Max messages to return (default 50)' },
        status: { type: 'string', description: 'Filter by status: pending | read (default pending)' },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'ttym_mark_read',
    description: 'Mark a message as read.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Message ID to mark as read' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'ttym_create_task',
    description: 'Create a new shared task for agents to work on.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title' },
        description: { type: 'string', description: 'Task description' },
        created_by: { type: 'string', description: 'Agent ID creating the task' },
        priority: { type: 'number', description: 'Priority (higher = more important, default 0)' },
      },
      required: ['title', 'created_by'],
    },
  },
  {
    name: 'ttym_claim_task',
    description: 'Atomically claim an open task. Fails if already claimed.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to claim' },
        agent_id: { type: 'string', description: 'Agent ID claiming the task' },
      },
      required: ['task_id', 'agent_id'],
    },
  },
  {
    name: 'ttym_update_task',
    description: 'Update task status or result.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to update' },
        status: { type: 'string', description: 'New status: open | claimed | in_progress | done | cancelled' },
        result: { description: 'Task result (any JSON)' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'ttym_list_agents',
    description: 'List all registered agents and their status.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'ttym_list_tasks',
    description: 'List tasks, optionally filtered by status.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status: open | claimed | in_progress | done | cancelled' },
      },
    },
  },
  {
    name: 'ttym_heartbeat',
    description: 'Send heartbeat to keep agent online. Call periodically.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Agent ID' },
      },
      required: ['agent_id'],
    },
  },
];

// ───── MCP Tool execution ─────

async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'ttym_register':
      return busPost('/agents', args);

    case 'ttym_send':
      return busPost('/messages', args);

    case 'ttym_inbox': {
      const qs = new URLSearchParams();
      if (args.limit) qs.set('limit', String(args.limit));
      if (args.status) qs.set('status', String(args.status));
      const query = qs.toString() ? `?${qs}` : '';
      return busGet(`/agents/${encodeURIComponent(String(args.agent_id))}/inbox${query}`);
    }

    case 'ttym_mark_read':
      return busPatch(`/messages/${encodeURIComponent(String(args.message_id))}`, { status: 'read' });

    case 'ttym_create_task':
      return busPost('/tasks', args);

    case 'ttym_claim_task':
      return busPost(`/tasks/${encodeURIComponent(String(args.task_id))}/claim`, { agent_id: args.agent_id });

    case 'ttym_update_task': {
      const { task_id, ...update } = args;
      return busPatch(`/tasks/${encodeURIComponent(String(task_id))}`, update);
    }

    case 'ttym_list_agents':
      return busGet('/agents');

    case 'ttym_list_tasks': {
      const qs = new URLSearchParams();
      if (args.status) qs.set('status', String(args.status));
      const query = qs.toString() ? `?${qs}` : '';
      return busGet(`/tasks${query}`);
    }

    case 'ttym_heartbeat':
      return busPost(`/agents/${encodeURIComponent(String(args.agent_id))}/heartbeat`, {});

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ───── JSON-RPC / MCP Protocol ─────

function sendResponse(id: unknown, result: unknown): void {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(msg + '\n');
}

function sendError(id: unknown, code: number, message: string): void {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(msg + '\n');
}

async function handleRequest(request: { id?: unknown; method: string; params?: any }): Promise<void> {
  const { id, method, params } = request;

  switch (method) {
    case 'initialize':
      sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'ttym-agent', version: '0.1.0' },
      });
      break;

    case 'notifications/initialized':
      // No response needed for notifications
      break;

    case 'tools/list':
      sendResponse(id, { tools: TOOLS });
      break;

    case 'tools/call': {
      const toolName = params?.name;
      const toolArgs = params?.arguments ?? {};

      try {
        const result = await executeTool(toolName, toolArgs);
        sendResponse(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      } catch (e) {
        sendResponse(id, {
          content: [{ type: 'text', text: `Error: ${(e as Error).message}` }],
          isError: true,
        });
      }
      break;
    }

    default:
      if (id !== undefined) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
  }
}

// ───── Main ─────

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  try {
    const request = JSON.parse(line);
    handleRequest(request).catch((e) => {
      if (request.id !== undefined) {
        sendError(request.id, -32603, (e as Error).message);
      }
    });
  } catch {
    // Ignore malformed JSON
  }
});

process.stderr.write(`[ttym-agent-mcp] started, BUS_URL=${BUS_URL}\n`);
