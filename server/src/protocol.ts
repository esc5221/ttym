import { RawData } from 'ws';

export const CMD = {
  DATA: 0x00,
  RESIZE: 0x01,
  CREATE: 0x02,
  DESTROY: 0x03,
  PAUSE: 0x04,
  RESUME: 0x05,
  HELLO: 0x06,
  LIST: 0x07,
  ATTACH: 0x08,
  DETACH: 0x09,
  SNAPSHOT: 0x0a,
  ACK: 0x0b,
  PAUSE_VIEW: 0x0c,
  RESUME_VIEW: 0x0d,
} as const;

export interface DecodedFrame {
  sessionId: number;
  cmd: number;
  payload: Buffer;
  seq?: number;
}

export function encode(sessionId: number, cmd: number, payload?: Buffer): Buffer {
  const payloadLen = payload?.length ?? 0;
  const frame = Buffer.allocUnsafe(3 + payloadLen);
  frame.writeUInt16LE(sessionId, 0);
  frame[2] = cmd;
  if (payloadLen > 0) payload!.copy(frame, 3);
  return frame;
}

export function encodeData(sessionId: number, seq: number, payload: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(7 + payload.length);
  frame.writeUInt16LE(sessionId, 0);
  frame[2] = CMD.DATA;
  frame.writeUInt32LE(seq, 3);
  payload.copy(frame, 7);
  return frame;
}

export function decode(raw: Buffer): DecodedFrame {
  return {
    sessionId: raw.readUInt16LE(0),
    cmd: raw[2],
    payload: raw.subarray(3),
  };
}

export function decodeDataFrame(raw: Buffer): DecodedFrame {
  const sessionId = raw.readUInt16LE(0);
  const cmd = raw[2];
  if (cmd === CMD.DATA && raw.length >= 7) {
    return {
      sessionId,
      cmd,
      seq: raw.readUInt32LE(3),
      payload: raw.subarray(7),
    };
  }
  return {
    sessionId,
    cmd,
    payload: raw.subarray(3),
  };
}

export function toBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  return Buffer.concat(raw);
}

export function jsonPayload(obj: object): Buffer {
  return Buffer.from(JSON.stringify(obj));
}

export function parseJson<T = any>(buf: Buffer): T | null {
  try { return JSON.parse(buf.toString()); } catch { return null; }
}
