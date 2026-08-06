// ───── Agent Bus HTTP API ─────

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentBus } from './agent-bus.js';
import type { BusEvent } from './agent-types.js';

export function handleAgentApi(bus: AgentBus, req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  // Only handle /api/agents, /api/messages, /api/tasks
  if (!path.startsWith('/api/agents') && !path.startsWith('/api/messages') && !path.startsWith('/api/tasks')) {
    return false;
  }

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }

  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const readBody = (): Promise<string> => new Promise((resolve) => {
    let body = '';
    req.on('data', (c: string) => body += c);
    req.on('end', () => resolve(body));
  });

  // ───── SSE: GET /api/agents/:id/events ─────
  const eventsMatch = path.match(/^\/api\/agents\/([^/]+)\/events$/);
  if (eventsMatch && req.method === 'GET') {
    const agentId = decodeURIComponent(eventsMatch[1]);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(':ok\n\n');

    const listener = (event: BusEvent) => {
      // Only send events relevant to this agent
      if (event.type === 'message') {
        const msg = event.data;
        if (msg.to_agent !== null && msg.to_agent !== agentId) return;
      }
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    };

    bus.on('bus-event', listener);

    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
      res.write(':heartbeat\n\n');
    }, 15_000);

    req.on('close', () => {
      bus.off('bus-event', listener);
      clearInterval(heartbeat);
    });

    return true;
  }

  // ───── Agents ─────

  // POST /api/agents — register
  if (path === '/api/agents' && req.method === 'POST') {
    readBody().then((body) => {
      try {
        const reg = JSON.parse(body);
        if (!reg.id || !reg.name || !reg.type) {
          json(400, { error: 'id, name, type required' });
          return;
        }
        const agent = bus.register(reg);
        json(201, agent);
      } catch {
        json(400, { error: 'invalid body' });
      }
    });
    return true;
  }

  // GET /api/agents — list
  if (path === '/api/agents' && req.method === 'GET') {
    json(200, bus.listAgents());
    return true;
  }

  // POST /api/agents/:id/heartbeat
  const heartbeatMatch = path.match(/^\/api\/agents\/([^/]+)\/heartbeat$/);
  if (heartbeatMatch && req.method === 'POST') {
    const id = decodeURIComponent(heartbeatMatch[1]);
    const ok = bus.heartbeat(id);
    if (!ok) { json(404, { error: 'agent not found' }); return true; }
    json(200, { ok: true });
    return true;
  }

  // GET /api/agents/:id/inbox
  const inboxMatch = path.match(/^\/api\/agents\/([^/]+)\/inbox$/);
  if (inboxMatch && req.method === 'GET') {
    const agentId = decodeURIComponent(inboxMatch[1]);
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const status = url.searchParams.get('status') || 'pending';
    const messages = bus.inbox(agentId, { limit, status });
    json(200, messages);
    return true;
  }

  // GET/PATCH/DELETE /api/agents/:id
  const agentMatch = path.match(/^\/api\/agents\/([^/]+)$/);
  if (agentMatch) {
    const id = decodeURIComponent(agentMatch[1]);

    if (req.method === 'GET') {
      const agent = bus.getAgent(id);
      if (!agent) { json(404, { error: 'agent not found' }); return true; }
      json(200, agent);
      return true;
    }

    if (req.method === 'PATCH') {
      readBody().then((body) => {
        try {
          const patch = JSON.parse(body);
          const agent = bus.updateAgent(id, patch);
          if (!agent) { json(404, { error: 'agent not found' }); return; }
          json(200, agent);
        } catch {
          json(400, { error: 'invalid body' });
        }
      });
      return true;
    }

    if (req.method === 'DELETE') {
      const ok = bus.unregister(id);
      if (!ok) { json(404, { error: 'agent not found' }); return true; }
      json(200, { ok: true });
      return true;
    }
  }

  // ───── Messages ─────

  // POST /api/messages — send
  if (path === '/api/messages' && req.method === 'POST') {
    readBody().then((body) => {
      try {
        const envelope = JSON.parse(body);
        if (!envelope.from || !envelope.body) {
          json(400, { error: 'from and body required' });
          return;
        }
        const msg = bus.send(envelope);
        json(201, msg);
      } catch {
        json(400, { error: 'invalid body' });
      }
    });
    return true;
  }

  // GET /api/messages — list with filters
  if (path === '/api/messages' && req.method === 'GET') {
    const from = url.searchParams.get('from') || undefined;
    const to = url.searchParams.get('to') || undefined;
    const thread_id = url.searchParams.get('thread_id') || undefined;
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);
    const messages = bus.listMessages({ from, to, thread_id, limit });
    json(200, messages);
    return true;
  }

  // PATCH /api/messages/:id
  const msgMatch = path.match(/^\/api\/messages\/([^/]+)$/);
  if (msgMatch && req.method === 'PATCH') {
    const id = decodeURIComponent(msgMatch[1]);
    readBody().then((body) => {
      try {
        const patch = JSON.parse(body);
        const ok = bus.updateMessage(id, patch);
        if (!ok) { json(404, { error: 'message not found' }); return; }
        json(200, { ok: true });
      } catch {
        json(400, { error: 'invalid body' });
      }
    });
    return true;
  }

  // ───── Tasks ─────

  // POST /api/tasks — create
  if (path === '/api/tasks' && req.method === 'POST') {
    readBody().then((body) => {
      try {
        const task = JSON.parse(body);
        if (!task.title || !task.created_by) {
          json(400, { error: 'title and created_by required' });
          return;
        }
        const created = bus.createTask(task);
        json(201, created);
      } catch {
        json(400, { error: 'invalid body' });
      }
    });
    return true;
  }

  // GET /api/tasks — list
  if (path === '/api/tasks' && req.method === 'GET') {
    const status = url.searchParams.get('status') || undefined;
    const created_by = url.searchParams.get('created_by') || undefined;
    const claimed_by = url.searchParams.get('claimed_by') || undefined;
    const tasks = bus.listTasks({ status, created_by, claimed_by });
    json(200, tasks);
    return true;
  }

  // POST /api/tasks/:id/claim
  const claimMatch = path.match(/^\/api\/tasks\/([^/]+)\/claim$/);
  if (claimMatch && req.method === 'POST') {
    const taskId = decodeURIComponent(claimMatch[1]);
    readBody().then((body) => {
      try {
        const { agent_id } = JSON.parse(body);
        if (!agent_id) { json(400, { error: 'agent_id required' }); return; }
        const task = bus.claimTask(taskId, agent_id);
        if (!task) { json(409, { error: 'task not available (already claimed or not found)' }); return; }
        json(200, task);
      } catch {
        json(400, { error: 'invalid body' });
      }
    });
    return true;
  }

  // PATCH /api/tasks/:id
  const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch && req.method === 'PATCH') {
    const taskId = decodeURIComponent(taskMatch[1]);
    readBody().then((body) => {
      try {
        const update = JSON.parse(body);
        const task = bus.updateTask(taskId, update);
        if (!task) { json(404, { error: 'task not found' }); return; }
        json(200, task);
      } catch {
        json(400, { error: 'invalid body' });
      }
    });
    return true;
  }

  // GET /api/tasks/:id
  const taskGetMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskGetMatch && req.method === 'GET') {
    const taskId = decodeURIComponent(taskGetMatch[1]);
    const task = bus.getTask(taskId);
    if (!task) { json(404, { error: 'task not found' }); return true; }
    json(200, task);
    return true;
  }

  return false;
}
