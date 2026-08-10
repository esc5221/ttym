import { CMD, encode, decode } from './protocol';

type DataCallback = (data: Uint8Array, seq?: number) => void;
type ExitCallback = () => void;
type SnapshotCallback = (data: string, seq?: number) => void;

interface SessionCallbacks {
  onData: DataCallback;
  onExit?: ExitCallback;
  onSnapshot?: SnapshotCallback;
}

export interface CreateOptions {
  cmd?: string[];
  cols?: number;
  rows?: number;
  cwd?: string;
}

export interface SessionInfo {
  id: number;
  pid: number;
  cmd: string[];
  cols: number;
  rows: number;
  status: 'attached' | 'detached' | 'dead';
  lastSeq: number;
  createdAt: number;
  detachedAt: number | null;
}

export interface WorkspaceChangeEvent {
  generation: number;
  /** Full workspace state — the server never sends diffs. */
  workspace?: { id: string; [key: string]: unknown };
  deletedId?: string;
}

export interface AgentStateEvent {
  sessionId: number;
  kind: 'claude-code' | 'codex' | null;
  active: boolean;
}

export interface ConfigChangeEvent {
  values: Record<string, string>;
}

interface PendingCreate {
  resolve: (id: number) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface PendingAttach {
  resolve: (info: SessionInfo) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface PendingList {
  resolve: (list: SessionInfo[]) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const CREATE_TIMEOUT_MS = 10_000;
const ATTACH_TIMEOUT_MS = 10_000;
const LIST_TIMEOUT_MS = 5_000;
const MAX_DATA_CHUNK_BYTES = 16 * 1024;

export class TerminalMux {
  private ws: WebSocket | null = null;
  private sessions = new Map<number, SessionCallbacks>();
  private pendingCreates: PendingCreate[] = [];
  private pendingAttaches = new Map<number, PendingAttach>();
  private pendingList: PendingList | null = null;
  private readonly url: string;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private _lastSeqs = new Map<number, number>(); // sessionId → 최신 수신 seq
  private disconnectListeners = new Set<() => void>();
  private workspaceListeners = new Set<(event: WorkspaceChangeEvent) => void>();
  private agentListeners = new Set<(event: AgentStateEvent) => void>();
  private configListeners = new Set<(event: ConfigChangeEvent) => void>();

  constructor(url: string) {
    this.url = url;
    // Seq watermarks live and die with this page. Persisting them across a
    // reload (sessionStorage) shipped once and was a correctness bug: the
    // watermark says "parsed through N" but the reloaded xterm is blank, so
    // the server sends delta-only and the pane renders nothing until fresh
    // output arrives. Delta resync is valid only while the xterm buffer that
    // earned the watermark is still alive — a fresh page must snapshot.
  }

  connect(): Promise<void> {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      this.cleanup(new Error('Reconnecting'));
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      let opened = false;
      ws.onopen = () => {
        opened = true;
        // HELLO 전송
        this.sendRaw(encode(0, CMD.HELLO, this.encoder.encode(JSON.stringify({
          clientId: this.clientId(),
        }))));
        resolve();
      };
      ws.onerror = () => reject(new Error('WebSocket connection failed'));
      ws.onmessage = (e) => this.handleMessage(e);
      ws.onclose = () => {
        if (this.ws === ws) {
          this.cleanup(new Error('WebSocket closed'));
          // Only a connection that actually opened gets to announce a drop.
          // A failed dial also fires onclose; surfacing that as "disconnect"
          // spins up a second retry loop beside the caller's own.
          if (opened) {
            for (const listener of this.disconnectListeners) {
              try { listener(); } catch {}
            }
          }
        }
      };
    });
  }

  private clientId(): string {
    let id = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('ttym-client-id') : null;
    if (!id) {
      id = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
      try { sessionStorage.setItem('ttym-client-id', id); } catch {}
    }
    return id;
  }

  private sendRaw(data: Uint8Array) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  private cleanup(error: Error) {
    const ws = this.ws;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
    }
    // reject pending creates
    for (const p of this.pendingCreates) {
      clearTimeout(p.timeoutId);
      p.reject(error);
    }
    this.pendingCreates = [];
    // reject pending attaches
    for (const [, p] of this.pendingAttaches) {
      clearTimeout(p.timeoutId);
      p.reject(error);
    }
    this.pendingAttaches.clear();
    // reject pending list
    if (this.pendingList) {
      clearTimeout(this.pendingList.timeoutId);
      this.pendingList.reject(error);
      this.pendingList = null;
    }
    this.sessions.clear();
    // Watermarks survive a dropped connection: the buffers they describe are
    // still alive in their hosts, so a reconnect can resync by delta. If the
    // server rebooted meanwhile, its boot-scoped seq base demotes our stale
    // values to the snapshot path — no trust required.
    this.ws = null;
  }

  private handleMessage(e: MessageEvent<ArrayBuffer>) {
    const decoded = decode(e.data);
    if (!decoded) return;
    const sessionId = decoded.sessionId;
    const cmd = decoded.cmd;
    const payload = decoded.payload;

    switch (cmd) {
      case CMD.DATA:
        // The watermark advances in ack(), after xterm has parsed the bytes
        // — not here at receipt. A receipt-time watermark claims bytes the
        // page may never parse (queued writes are dropped on unmount), and a
        // resync from such a claim replays a hole onto the screen.
        this.sessions.get(sessionId)?.onData(payload, decoded.seq);
        break;

      case CMD.SNAPSHOT: {
        // The snapshot's watermark is committed by the consumer's ack after
        // the repaint actually parses — same rule as DATA. The seq rides
        // along so the consumer can ack it.
        const snapStr = this.decoder.decode(payload);
        this.sessions.get(sessionId)?.onSnapshot?.(snapStr, decoded.seq);
        break;
      }

      case CMD.CREATE: {
        let meta: { requestId?: number; ok?: boolean; error?: string } = {};
        if (payload.length > 0) {
          try { meta = JSON.parse(this.decoder.decode(payload)); } catch {}
        }
        const pending = this.pendingCreates.shift();
        if (!pending) break;
        clearTimeout(pending.timeoutId);

        if (meta.ok === false || sessionId === 0) {
          pending.reject(new Error(meta.error ?? 'Session creation failed'));
        } else {
          pending.resolve(sessionId);
        }
        break;
      }

      case CMD.ATTACH: {
        let meta: { ok?: boolean; error?: string } & Partial<SessionInfo> = {};
        if (payload.length > 0) {
          try { meta = JSON.parse(this.decoder.decode(payload)); } catch {}
        }
        const pendingAttach = this.pendingAttaches.get(sessionId);
        if (!pendingAttach) break;
        this.pendingAttaches.delete(sessionId);
        clearTimeout(pendingAttach.timeoutId);

        if (meta.ok === false) {
          pendingAttach.reject(new Error(meta.error ?? 'Attach failed'));
        } else {
          // meta.lastSeq is the server's head, not what this page has parsed
          // — adopting it here is exactly the "ledger without the screen"
          // bug. The watermark moves only through ack().
          pendingAttach.resolve(meta as SessionInfo);
        }
        break;
      }

      case CMD.DETACH: {
        // 서버 응답 (현재는 무시)
        break;
      }

      case CMD.LIST: {
        if (this.pendingList) {
          let list: SessionInfo[] = [];
          if (payload.length > 0) {
            try { list = JSON.parse(this.decoder.decode(payload)); } catch {}
          }
          clearTimeout(this.pendingList.timeoutId);
          this.pendingList.resolve(list);
          this.pendingList = null;
        }
        break;
      }

      case CMD.WORKSPACE: {
        let event: WorkspaceChangeEvent | null = null;
        try { event = JSON.parse(this.decoder.decode(payload)); } catch {}
        if (event && typeof event.generation === 'number') {
          for (const listener of this.workspaceListeners) {
            try { listener(event); } catch {}
          }
        }
        break;
      }

      case CMD.AGENT: {
        let event: AgentStateEvent | null = null;
        try { event = JSON.parse(this.decoder.decode(payload)); } catch {}
        if (event && typeof event.sessionId === 'number') {
          for (const listener of this.agentListeners) {
            try { listener(event); } catch {}
          }
        }
        break;
      }

      case CMD.CONFIG: {
        let event: ConfigChangeEvent | null = null;
        try { event = JSON.parse(this.decoder.decode(payload)); } catch {}
        if (event && event.values && typeof event.values === 'object') {
          for (const listener of this.configListeners) {
            try { listener(event); } catch {}
          }
        }
        break;
      }

      case CMD.DESTROY: {
        this.sessions.get(sessionId)?.onExit?.();
        this.sessions.delete(sessionId);
        this._lastSeqs.delete(sessionId);
        break;
      }
    }
  }

  // ───── 세션 생성 ─────

  async createSession(options: CreateOptions, callbacks: SessionCallbacks): Promise<number> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected');
    }

    const requestId = Date.now() + Math.random();

    const sessionId = await new Promise<number>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const idx = this.pendingCreates.findIndex((p) => p.resolve === resolve);
        if (idx !== -1) this.pendingCreates.splice(idx, 1);
        reject(new Error('CREATE timed out'));
      }, CREATE_TIMEOUT_MS);

      this.pendingCreates.push({ resolve, reject, timeoutId });
      const payload = this.encoder.encode(JSON.stringify({ ...options, requestId }));
      this.sendRaw(encode(0, CMD.CREATE, payload));
    });

    this.sessions.set(sessionId, callbacks);
    return sessionId;
  }

  // ───── 세션 목록 조회 ─────

  listSessions(): Promise<SessionInfo[]> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Not connected'));
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingList = null;
        reject(new Error('LIST timed out'));
      }, LIST_TIMEOUT_MS);

      this.pendingList = { resolve, reject, timeoutId };
      this.sendRaw(encode(0, CMD.LIST));
    });
  }

  // ───── 세션 재부착 ─────

  async attachSession(
    sessionId: number,
    callbacks: SessionCallbacks,
    opts?: { fromSeq?: number; cols?: number; rows?: number; mode?: 'readwrite' | 'readonly' },
  ): Promise<SessionInfo> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected');
    }

    this.sessions.set(sessionId, callbacks);

    const info = await new Promise<SessionInfo>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingAttaches.delete(sessionId);
        reject(new Error('ATTACH timed out'));
      }, ATTACH_TIMEOUT_MS);

      this.pendingAttaches.set(sessionId, { resolve, reject, timeoutId });
      this.sendRaw(encode(sessionId, CMD.ATTACH, this.encoder.encode(JSON.stringify({
        fromSeq: opts?.fromSeq ?? this._lastSeqs.get(sessionId) ?? 0,
        cols: opts?.cols,
        rows: opts?.rows,
        mode: opts?.mode,
      }))));
    });

    return info;
  }

  // ───── 세션 분리 ─────

  detachSession(sessionId: number) {
    this.sendRaw(encode(sessionId, CMD.DETACH));
    this.sessions.delete(sessionId);
    // The watermark survives detach on purpose: the host keeps the xterm
    // buffer, so a later re-attach replays delta instead of flashing a
    // snapshot. Callers that destroy the buffer call forgetSeq().
  }

  // ───── hidden 탭 ─────

  /** Fires when the socket drops after a successful connect. */
  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  /** Subscribe to config pushes — every window applies the same file. */
  onConfig(listener: (event: ConfigChangeEvent) => void): () => void {
    this.configListeners.add(listener);
    return () => this.configListeners.delete(listener);
  }

  /** Subscribe to agent state pushes. Returns the unsubscribe. */
  onAgent(listener: (event: AgentStateEvent) => void): () => void {
    this.agentListeners.add(listener);
    return () => this.agentListeners.delete(listener);
  }

  /** Subscribe to workspace change pushes. Returns the unsubscribe. */
  onWorkspace(listener: (event: WorkspaceChangeEvent) => void): () => void {
    this.workspaceListeners.add(listener);
    return () => this.workspaceListeners.delete(listener);
  }

  /**
   * Acknowledge parsed output through `seq`. Drives server-side backpressure
   * AND advances the watermark — this is the only place it moves, so the
   * watermark can never claim bytes the terminal has not actually rendered.
   */
  ack(sessionId: number, seq: number) {
    this._lastSeqs.set(sessionId, seq);
    this.sendRaw(encode(sessionId, CMD.ACK, this.encoder.encode(JSON.stringify({ seq }))));
  }

  /**
   * Drop a session's watermark. Must be called when the terminal buffer that
   * earned it is destroyed — watermark lifetime IS buffer lifetime; a
   * watermark outliving its buffer replays delta onto a blank screen.
   */
  forgetSeq(sessionId: number) {
    this._lastSeqs.delete(sessionId);
  }

  pauseView(sessionId: number) {
    this.sendRaw(encode(sessionId, CMD.PAUSE_VIEW));
  }

  resumeView(sessionId: number, fromSeq?: number) {
    this.sendRaw(encode(sessionId, CMD.RESUME_VIEW, this.encoder.encode(JSON.stringify({
      fromSeq: fromSeq ?? this._lastSeqs.get(sessionId) ?? 0,
    }))));
  }

  // ───── 기존 API ─────

  send(sessionId: number, data: string | Uint8Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const payload = typeof data === 'string' ? this.encoder.encode(data) : data;
    if (payload.byteLength <= MAX_DATA_CHUNK_BYTES) {
      this.sendRaw(encode(sessionId, CMD.DATA, payload));
      return;
    }

    // Chunk large pastes to avoid oversized single-frame writes stalling the transport.
    for (let offset = 0; offset < payload.byteLength; offset += MAX_DATA_CHUNK_BYTES) {
      this.sendRaw(encode(sessionId, CMD.DATA, payload.subarray(offset, offset + MAX_DATA_CHUNK_BYTES)));
    }
  }

  resize(sessionId: number, cols: number, rows: number) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const payload = new Uint8Array([
      cols & 0xff, (cols >>> 8) & 0xff,
      rows & 0xff, (rows >>> 8) & 0xff,
    ]);
    this.sendRaw(encode(sessionId, CMD.RESIZE, payload));
  }

  pause(sessionId: number) {
    this.sendRaw(encode(sessionId, CMD.PAUSE));
  }

  resume(sessionId: number) {
    this.sendRaw(encode(sessionId, CMD.RESUME));
  }

  requestSnapshot(sessionId: number) {
    this.sendRaw(encode(sessionId, CMD.SNAPSHOT));
  }

  destroySession(sessionId: number) {
    this.sendRaw(encode(sessionId, CMD.DESTROY));
    this.sessions.delete(sessionId);
    this._lastSeqs.delete(sessionId);
  }

  disconnect() {
    const ws = this.ws;
    if (!ws) return;
    // detach all (kill하지 않음)
    for (const id of Array.from(this.sessions.keys())) {
      this.detachSession(id);
    }
    ws.close();
    this.cleanup(new Error('Disconnected'));
  }
}
