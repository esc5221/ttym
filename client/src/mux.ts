import { CMD, encode, decode } from './protocol';

type DataCallback = (data: Uint8Array) => void;
type ExitCallback = () => void;

interface SessionCallbacks {
  onData: DataCallback;
  onExit?: ExitCallback;
}

export interface CreateOptions {
  cmd?: string[];
  cols?: number;
  rows?: number;
}

interface PendingCreate {
  resolve: (id: number) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const CREATE_TIMEOUT_MS = 10_000;

export class TerminalMux {
  private ws: WebSocket | null = null;
  private sessions = new Map<number, SessionCallbacks>();
  private pendingCreates: PendingCreate[] = [];
  private readonly url: string;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  constructor(url: string) {
    this.url = url;
  }

  connect(): Promise<void> {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      this.cleanup(new Error('Reconnecting'));
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('WebSocket connection failed'));
      ws.onmessage = (e) => this.handleMessage(e);
      ws.onclose = () => {
        if (this.ws === ws) this.cleanup(new Error('WebSocket closed'));
      };
    });
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
    // notify sessions
    for (const session of this.sessions.values()) session.onExit?.();
    this.sessions.clear();
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
        this.sessions.get(sessionId)?.onData(payload);
        break;

      case CMD.CREATE: {
        // parse JSON response: { requestId, ok, error? }
        let meta: { requestId?: number; ok?: boolean; error?: string } = {};
        if (payload.length > 0) {
          try { meta = JSON.parse(this.decoder.decode(payload)); } catch {}
        }
        console.log(`[mux] CREATE response session=${sessionId} ok=${meta.ok}`);
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

      case CMD.DESTROY: {
        const hasSession = this.sessions.has(sessionId);
        const hasExit = !!this.sessions.get(sessionId)?.onExit;
        console.log(`[mux] DESTROY received session=${sessionId} hasSession=${hasSession} hasExitCb=${hasExit}`);
        this.sessions.get(sessionId)?.onExit?.();
        this.sessions.delete(sessionId);
        break;
      }
    }
  }

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
      this.ws!.send(encode(0, CMD.CREATE, payload));
    });

    this.sessions.set(sessionId, callbacks);
    return sessionId;
  }

  send(sessionId: number, data: string | Uint8Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const payload = typeof data === 'string' ? this.encoder.encode(data) : data;
    this.ws.send(encode(sessionId, CMD.DATA, payload));
  }

  resize(sessionId: number, cols: number, rows: number) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const payload = new Uint8Array([
      cols & 0xff, (cols >>> 8) & 0xff,
      rows & 0xff, (rows >>> 8) & 0xff,
    ]);
    this.ws.send(encode(sessionId, CMD.RESIZE, payload));
  }

  pause(sessionId: number) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encode(sessionId, CMD.PAUSE));
    }
  }

  resume(sessionId: number) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encode(sessionId, CMD.RESUME));
    }
  }

  destroySession(sessionId: number) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encode(sessionId, CMD.DESTROY));
    }
    this.sessions.delete(sessionId);
  }

  disconnect() {
    const ws = this.ws;
    if (!ws) return;
    for (const id of Array.from(this.sessions.keys())) this.destroySession(id);
    ws.close();
    this.cleanup(new Error('Disconnected'));
  }
}
