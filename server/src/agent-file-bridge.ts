// ───── Agent File Bridge ─────
// Bridges file-based messaging to/from the AgentBus SQLite store.
// For agents that can't use HTTP or MCP (last resort fallback).
//
// Directory structure:
//   ~/.ttym/bus/agents/{id}/
//     outbox/*.json  — agent writes here, bridge reads & sends to bus
//     inbox/*.json   — bridge writes here from bus messages

import { watch, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentBus } from './agent-bus.js';
import type { BusEvent, MessageRecord } from './agent-types.js';

const POLL_INTERVAL = 2_000; // 2s fallback poll (in case fs.watch misses events)

export class AgentFileBridge {
  private busDir: string;
  private watchers = new Map<string, ReturnType<typeof watch>>();
  private pollTimer: NodeJS.Timeout | null = null;
  private knownAgents = new Set<string>();

  constructor(private bus: AgentBus, baseDir?: string) {
    this.busDir = baseDir ?? resolve(process.env.HOME || '/tmp', '.ttym', 'bus', 'agents');
    mkdirSync(this.busDir, { recursive: true });
  }

  start(): void {
    // Watch for new agent directories
    this.scanAgentDirs();

    // Listen for bus events → write to inbox files
    this.bus.on('bus-event', (event: BusEvent) => {
      if (event.type === 'message') {
        this.deliverToFile(event.data);
      }
    });

    // Poll for new agent directories + outbox files
    this.pollTimer = setInterval(() => {
      this.scanAgentDirs();
      this.pollOutboxes();
    }, POLL_INTERVAL);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const w of this.watchers.values()) {
      w.close();
    }
    this.watchers.clear();
  }

  private scanAgentDirs(): void {
    try {
      const entries = readdirSync(this.busDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !this.knownAgents.has(entry.name)) {
          this.knownAgents.add(entry.name);
          this.setupAgentDir(entry.name);
        }
      }
    } catch {
      // Directory might not exist yet
    }
  }

  private setupAgentDir(agentId: string): void {
    const agentDir = resolve(this.busDir, agentId);
    const outboxDir = resolve(agentDir, 'outbox');
    const inboxDir = resolve(agentDir, 'inbox');

    mkdirSync(outboxDir, { recursive: true });
    mkdirSync(inboxDir, { recursive: true });

    // Watch outbox for new files
    try {
      const watcher = watch(outboxDir, (eventType, filename) => {
        if (filename && filename.endsWith('.json')) {
          this.processOutboxFile(agentId, resolve(outboxDir, filename));
        }
      });
      this.watchers.set(agentId, watcher);
    } catch {
      // fs.watch may not be available
    }

    // Process any existing outbox files
    this.processOutbox(agentId);
  }

  private processOutbox(agentId: string): void {
    const outboxDir = resolve(this.busDir, agentId, 'outbox');
    try {
      const files = readdirSync(outboxDir).filter(f => f.endsWith('.json')).sort();
      for (const file of files) {
        this.processOutboxFile(agentId, resolve(outboxDir, file));
      }
    } catch {
      // Directory might not exist
    }
  }

  private processOutboxFile(agentId: string, filePath: string): void {
    try {
      if (!existsSync(filePath)) return;
      const raw = readFileSync(filePath, 'utf8');
      const envelope = JSON.parse(raw);

      // Ensure from is set to this agent
      envelope.from = envelope.from || agentId;

      this.bus.send(envelope);

      // Remove processed file
      unlinkSync(filePath);
    } catch {
      // File might be in the middle of being written, skip
    }
  }

  private pollOutboxes(): void {
    for (const agentId of this.knownAgents) {
      this.processOutbox(agentId);
    }
  }

  private deliverToFile(msg: MessageRecord): void {
    // Deliver to specific agent's inbox, or all agents for broadcast
    const targets = msg.to_agent ? [msg.to_agent] : [...this.knownAgents];

    for (const agentId of targets) {
      const inboxDir = resolve(this.busDir, agentId, 'inbox');
      try {
        mkdirSync(inboxDir, { recursive: true });
        const filename = `${msg.id}.json`;
        const filePath = resolve(inboxDir, filename);

        const data = {
          id: msg.id,
          from: msg.from_agent,
          to: msg.to_agent,
          type: msg.type,
          subject: msg.subject,
          body: msg.body,
          created_at: msg.created_at,
        };

        writeFileSync(filePath, JSON.stringify(data, null, 2));
      } catch {
        // Inbox dir might not be accessible
      }
    }
  }
}
