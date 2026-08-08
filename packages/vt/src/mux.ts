import { CMD, encode, decode } from './protocol';

type DataCallback = (data: Uint8Array, seq?: number) => void;
type ExitCallback = () => void;
type SnapshotCallback = (data: string) => void;

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
    // 새로고침은 페이지 메모리의 seq 워터마크를 지워 모든 pane을 전체
    // 스냅샷 경로로 밀어넣는다 — 탭 단위 sessionStorage에 보존해두면
    // ring(1MB) 창 안의 새로고침은 delta 재생으로 끝난다.
    try {
      if (typeof sessionStorage !== 'undefined') {
        const raw = sessionStorage.getItem('ttym-last-seqs');
        if (raw) {
          for (const [id, seq] of Object.entries(JSON.parse(raw))) {
            if (typeof seq === 'number') this._lastSeqs.set(Number(id), seq);
          }
        }
        window.addEventListener('pagehide', () => this.persistSeqs());
      }
    } catch {}
  }

  private persistSeqs() {
    try {
      if (typeof sessionStorage === 'undefined') return;
      sessionStorage.setItem('ttym-last-seqs', JSON.stringify(Object.fromEntries(this._lastSeqs)));
    } catch {}
  }

  connect(): Promise<void> {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      this.cleanup(new Error('Reconnecting'));
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
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
          for (const listener of this.disconnectListeners) {
            try { listener(); } catch {}
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
    this._lastSeqs.clear();
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
        // The ACK is the consumer's job, sent after xterm has parsed the
        // bytes — server backpressure then tracks digestion, not delivery.
        if (decoded.seq !== undefined) this._lastSeqs.set(sessionId, decoded.seq);
        this.sessions.get(sessionId)?.onData(payload, decoded.seq);
        break;

      case CMD.SNAPSHOT: {
        // The snapshot replaces everything up to its watermark; without this
        // the next resumeView would carry a stale fromSeq and force yet
        // another snapshot — resyncs chaining into resyncs.
        if (decoded.seq !== undefined) this._lastSeqs.set(sessionId, decoded.seq);
        const snapStr = this.decoder.decode(payload);
        this.sessions.get(sessionId)?.onSnapshot?.(snapStr);
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
          if (typeof meta.lastSeq === 'number') this._lastSeqs.set(sessionId, meta.lastSeq);
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
    this._lastSeqs.delete(sessionId);
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

  /** Acknowledge parsed output through `seq`. Drives server-side backpressure. */
  ack(sessionId: number, seq: number) {
    this.sendRaw(encode(sessionId, CMD.ACK, this.encoder.encode(JSON.stringify({ seq }))));
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
