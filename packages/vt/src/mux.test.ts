import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalMux } from './mux.js';
import { CMD, decode, encode, encodeData, encodeSnapshot } from './protocol.js';

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
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

    // A resync snapshot rendered at seq 41 arrives. The watermark does NOT
    // move on receipt — a receipt-time ledger can claim bytes the page never
    // parsed. It moves when the consumer acks after the repaint.
    socket.emitMessage(encodeSnapshot(9, 41, new TextEncoder().encode('fresh screen')));
    expect(onSnapshot).toHaveBeenCalledWith('fresh screen', 41);

    mux.resumeView(9);
    const before = decode(toArrayBuffer(socket.sent[socket.sent.length - 1]));
    expect(JSON.parse(new TextDecoder().decode(before!.payload))).toEqual({ fromSeq: 0 });

    mux.ack(9, 41); // 소비자(호스트)가 리페인트 파싱을 마친 시점
    mux.resumeView(9);
    const resume = decode(toArrayBuffer(socket.sent[socket.sent.length - 1]));
    expect(resume?.cmd).toBe(CMD.RESUME_VIEW);
    expect(JSON.parse(new TextDecoder().decode(resume!.payload))).toEqual({ fromSeq: 41 });
  });

  it('keeps the watermark across detach, drops it on forgetSeq', async () => {
    const mux = new TerminalMux('ws://example.test');
    const connected = mux.connect();
    const socket = FakeWebSocket.latest();
    socket.open();
    await connected;

    const attachPromise = mux.attachSession(9, { onData: vi.fn() }, { cols: 80, rows: 24 });
    socket.emitMessage(encode(9, CMD.ATTACH, new TextEncoder().encode(JSON.stringify({
      ok: true, id: 9, pid: 1, cmd: ['/bin/sh'], cols: 80, rows: 24,
      status: 'attached', lastSeq: 3, createdAt: 0, detachedAt: null,
    }))));
    await attachPromise;
    mux.ack(9, 55);

    // detach해도 워터마크는 산다 — xterm 버퍼가 host에 살아있으니 재부착은
    // delta로 이어진다.
    mux.detachSession(9);
    const attach2 = mux.attachSession(9, { onData: vi.fn() }, { cols: 80, rows: 24 });
    const sent = decode(toArrayBuffer(socket.sent[socket.sent.length - 1]));
    expect(JSON.parse(new TextDecoder().decode(sent!.payload)).fromSeq).toBe(55);
    socket.emitMessage(encode(9, CMD.ATTACH, new TextEncoder().encode(JSON.stringify({ ok: true, id: 9 }))));
    await attach2;

    // 버퍼가 죽으면(host dispose) 워터마크도 죽는다 — 백지에 delta 금지.
    mux.detachSession(9);
    mux.forgetSeq(9);
    const attach3 = mux.attachSession(9, { onData: vi.fn() }, { cols: 80, rows: 24 });
    const sent3 = decode(toArrayBuffer(socket.sent[socket.sent.length - 1]));
    expect(JSON.parse(new TextDecoder().decode(sent3!.payload)).fromSeq).toBe(0);
    socket.emitMessage(encode(9, CMD.ATTACH, new TextEncoder().encode(JSON.stringify({ ok: true, id: 9 }))));
    await attach3;
  });

  it('ignores watermarks a previous page life left in sessionStorage — a fresh page must snapshot', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
    });
    // 한때 이걸 복원하는 최적화가 있었고 정확성 버그였다: 리로드된 xterm은
    // 백지인데 장부만 살아나면 서버가 델타만 보내 화면이 안 그려진다.
    store.set('ttym-last-seqs', JSON.stringify({ 9: 41 }));

    const mux = new TerminalMux('ws://example.test');
    const connected = mux.connect();
    const socket = FakeWebSocket.latest();
    socket.open();
    await connected;

    const attachPromise = mux.attachSession(9, { onData: vi.fn() }, { cols: 80, rows: 24 });
    const attach = decode(toArrayBuffer(socket.sent[socket.sent.length - 1]));
    expect(attach?.cmd).toBe(CMD.ATTACH);
    expect(JSON.parse(new TextDecoder().decode(attach!.payload)).fromSeq).toBe(0);

    socket.emitMessage(encode(9, CMD.ATTACH, new TextEncoder().encode(JSON.stringify({
      ok: true, id: 9, pid: 1, cmd: ['/bin/sh'], cols: 80, rows: 24,
      status: 'attached', lastSeq: 41, createdAt: 0, detachedAt: null,
    }))));
    await attachPromise;
    vi.unstubAllGlobals();
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  it('replacing a mid-dial connection closes the orphan socket', async () => {
    const mux = new TerminalMux('ws://example.test');
    void mux.connect().catch(() => {});
    const socket1 = FakeWebSocket.latest();
    expect(socket1.readyState).toBe(FakeWebSocket.CONNECTING);

    // 다이얼 중 재연결: 예전엔 핸들러만 떼고 소켓을 안 닫아, 뒤늦게 열린
    // 고아 연결이 서버에 viewer로 남았다.
    const connected = mux.connect();
    expect(socket1.readyState).toBe(FakeWebSocket.CLOSED);
    const socket2 = FakeWebSocket.latest();
    socket2.open();
    await connected;
  });

  it('fires onDisconnect only for a connection that actually opened', async () => {
    const mux = new TerminalMux('ws://example.test');
    const dropped = vi.fn();
    mux.onDisconnect(dropped);

    // 실패한 다이얼: onerror 후 onclose — disconnect로 알리면 호출자의
    // 재시도 루프 옆에 두 번째 루프가 돌기 시작한다.
    const failed = mux.connect();
    const socket1 = FakeWebSocket.latest();
    socket1.onerror?.();
    socket1.close();
    await expect(failed).rejects.toThrow();
    expect(dropped).not.toHaveBeenCalled();

    // 성공 후의 끊김만 disconnect다.
    const connected = mux.connect();
    const socket2 = FakeWebSocket.latest();
    socket2.open();
    await connected;
    socket2.close();
    expect(dropped).toHaveBeenCalledTimes(1);
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
