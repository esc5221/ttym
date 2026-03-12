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
  payload: Uint8Array;
  seq?: number;
}

export function encode(sessionId: number, cmd: number, payload?: Uint8Array): Uint8Array {
  const payloadLen = payload?.length ?? 0;
  const frame = new Uint8Array(3 + payloadLen);
  frame[0] = sessionId & 0xff;
  frame[1] = (sessionId >>> 8) & 0xff;
  frame[2] = cmd;
  if (payloadLen > 0) frame.set(payload!, 3);
  return frame;
}

export function encodeData(sessionId: number, seq: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(7 + payload.length);
  frame[0] = sessionId & 0xff;
  frame[1] = (sessionId >>> 8) & 0xff;
  frame[2] = CMD.DATA;
  const view = new DataView(frame.buffer);
  view.setUint32(3, seq, true);
  frame.set(payload, 7);
  return frame;
}

export function decode(data: ArrayBuffer): DecodedFrame | null {
  if (data.byteLength < 3) return null;
  const view = new DataView(data);
  const sessionId = view.getUint16(0, true);
  const cmd = view.getUint8(2);
  if (cmd === CMD.DATA && data.byteLength >= 7) {
    return {
      sessionId,
      cmd,
      seq: view.getUint32(3, true),
      payload: new Uint8Array(data, 7),
    };
  }
  return {
    sessionId,
    cmd,
    payload: new Uint8Array(data, 3),
  };
}
