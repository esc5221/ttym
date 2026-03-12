export const CMD = {
  DATA: 0x00,
  RESIZE: 0x01,
  CREATE: 0x02,
  DESTROY: 0x03,
  PAUSE: 0x04,
  RESUME: 0x05,
} as const;

export function encode(sessionId: number, cmd: number, payload?: Uint8Array): Uint8Array {
  const payloadLen = payload?.length ?? 0;
  const frame = new Uint8Array(3 + payloadLen);
  frame[0] = sessionId & 0xff;
  frame[1] = (sessionId >>> 8) & 0xff;
  frame[2] = cmd;
  if (payloadLen > 0) frame.set(payload!, 3);
  return frame;
}

export function decode(data: ArrayBuffer): { sessionId: number; cmd: number; payload: Uint8Array } | null {
  if (data.byteLength < 3) return null;
  const view = new DataView(data);
  return {
    sessionId: view.getUint16(0, true),
    cmd: view.getUint8(2),
    payload: new Uint8Array(data, 3),
  };
}
