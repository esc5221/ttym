import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalMux } from './mux.js';
import { CMD, decode, encode, encodeData, encodeSnapshot } from './protocol.js';

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly sent: Uint8Array[] = [];
  binaryType = 'blob';
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: Uint8Array) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emitMessage(data: Uint8Array) {
    this.onmessage?.({ data: toArrayBuffer(data) } as MessageEvent<ArrayBuffer>);
  }

  static latest(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
  }
}

describe('TerminalMux', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends HELLO on connect', async () => {
    const mux = new TerminalMux('ws://example.test');
    const connected = mux.connect();
    const socket = FakeWebSocket.latest();

    socket.open();
    await connected;

    const hello = decode(toArrayBuffer(socket.sent[0]));
    expect(hello?.cmd).toBe(CMD.HELLO);
  });

  it('tracks the last delivered seq, ACKs data, and reuses it for resumeView', async () => {
    const mux = new TerminalMux('ws://example.test');
    const connected = mux.connect();
    const socket = FakeWebSocket.latest();
    socket.open();
    await connected;

    const createPromise = mux.createSession({}, {
      onData: vi.fn(),
    });

    socket.emitMessage(encode(9, CMD.CREATE, new TextEncoder().encode(JSON.stringify({ ok: true }))));
    await createPromise;

    const onData = vi.fn();
    const attachPromise = mux.attachSession(9, { onData }, { cols: 80, rows: 24 });
    socket.emitMessage(encode(9, CMD.ATTACH, new TextEncoder().encode(JSON.stringify({
      ok: true,
      id: 9,
      pid: 123,
      cmd: ['/bin/sh'],
      cols: 80,
      rows: 24,
      status: 'attached',
      lastSeq: 3,
      createdAt: Date.now(),
      detachedAt: null,
    }))));
    await attachPromise;

    socket.emitMessage(encodeData(9, 4, new TextEncoder().encode('hello')));

    // The mux no longer ACKs on receipt — the consumer acks after parsing.
    expect(onData).toHaveBeenCalledTimes(1);
    expect(onData.mock.calls[0][1]).toBe(4);

    mux.ack(9, 4);
    const ack = decode(toArrayBuffer(socket.sent[socket.sent.length - 1]));
    expect(ack?.cmd).toBe(CMD.ACK);
    expect(JSON.parse(new TextDecoder().decode(ack!.payload))).toEqual({ seq: 4 });

    mux.resumeView(9);

    const resume = decode(toArrayBuffer(socket.sent[socket.sent.length - 1]));
    expect(resume?.cmd).toBe(CMD.RESUME_VIEW);
    expect(JSON.parse(new TextDecoder().decode(resume!.payload))).toEqual({ fromSeq: 4 });
  });

  it('advances the watermark from a snapshot so resumeView resumes from it', async () => {
    const mux = new TerminalMux('ws://example.test');
    const connected = mux.connect();
    const socket = FakeWebSocket.latest();
    socket.open();
    await connected;

    const onSnapshot = vi.fn();
    const attachPromise = mux.attachSession(9, { onData: vi.fn(), onSnapshot }, { cols: 80, rows: 24 });
    socket.emitMessage(encode(9, CMD.ATTACH, new TextEncoder().encode(JSON.stringify({
      ok: true, id: 9, pid: 1, cmd: ['/bin/sh'], cols: 80, rows: 24,
      status: 'attached', lastSeq: 3, createdAt: 0, detachedAt: null,
    }))));
    await attachPromise;

    // A resync snapshot rendered at seq 41 arrives. Before the watermark
    // existed the client kept fromSeq=3, and the next resumeView could only
    // fall back to yet another snapshot.
    socket.emitMessage(encodeSnapshot(9, 41, new TextEncoder().encode('fresh screen')));
    expect(onSnapshot).toHaveBeenCalledWith('fresh screen');

    mux.resumeView(9);
    const resume = decode(toArrayBuffer(socket.sent[socket.sent.length - 1]));
    expect(resume?.cmd).toBe(CMD.RESUME_VIEW);
    expect(JSON.parse(new TextDecoder().decode(resume!.payload))).toEqual({ fromSeq: 41 });
  });

  it('detaches tracked sessions on disconnect without faking session exit', async () => {
    const mux = new TerminalMux('ws://example.test');
    const connected = mux.connect();
    const socket = FakeWebSocket.latest();
    socket.open();
    await connected;

    const onExit = vi.fn();
    const createPromise = mux.createSession({}, { onData: vi.fn(), onExit });
    socket.emitMessage(encode(5, CMD.CREATE, new TextEncoder().encode(JSON.stringify({ ok: true }))));
    await createPromise;

    mux.disconnect();

    const sentCommands = socket.sent.map((frame) => decode(toArrayBuffer(frame))!.cmd);
    expect(sentCommands).toContain(CMD.DETACH);
    expect(sentCommands).not.toContain(CMD.DESTROY);
    expect(onExit).not.toHaveBeenCalled();
  });

  it('chunks oversized data frames for large pastes', async () => {
    const mux = new TerminalMux('ws://example.test');
    const connected = mux.connect();
    const socket = FakeWebSocket.latest();
    socket.open();
    await connected;

    const baseFrames = socket.sent.length;
    mux.send(7, 'x'.repeat(40_000));

    const frames = socket.sent.slice(baseFrames);
    expect(frames).toHaveLength(3);
    expect(frames.every((frame) => frame[2] === CMD.DATA)).toBe(true);
    expect(frames.map((frame) => frame.byteLength)).toEqual([16_387, 16_387, 7_235]);
  });
});
