import { RawData } from 'ws';

export const CMD = {
  DATA: 0x00,
  RESIZE: 0x01,
  CREATE: 0x02,
  DESTROY: 0x03,
  PAUSE: 0x04,
  RESUME: 0x05,
} as const;

export function encode(sessionId: number, cmd: number, payload?: Buffer): Buffer {
  const payloadLen = payload?.length ?? 0;
  const frame = Buffer.allocUnsafe(3 + payloadLen);
  frame.writeUInt16LE(sessionId, 0);
  frame[2] = cmd;
  if (payloadLen > 0) payload!.copy(frame, 3);
  return frame;
}

export function decode(raw: Buffer): { sessionId: number; cmd: number; payload: Buffer } {
  return {
    sessionId: raw.readUInt16LE(0),
    cmd: raw[2],
    payload: raw.subarray(3),
  };
}

export function toBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  return Buffer.concat(raw);
}
