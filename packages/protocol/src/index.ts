/**
 * The ttym WebSocket wire format, in one place.
 *
 * Server and client each had their own copy of this — identical in intent,
 * split only by `Buffer` versus `Uint8Array`, and 83 lines apart in practice.
 * Fixing one and forgetting the other is a silent protocol break, so there is
 * a single implementation now.
 *
 * `Uint8Array` is the shared currency: Node's `Buffer` is a subclass, so the
 * server can keep passing Buffers in and reading the results as bytes.
 *
 * Frame layout
 *   [u16 LE sessionId][u8 cmd][payload…]
 *   DATA frames insert a u32 LE sequence number before the payload.
 */

/**
 * Version of the HTTP + WS surface as a whole. Bumped on breaking changes so a
 * CLI and a server from different builds refuse to half-work together —
 * during the last swap a v2 CLI ran against a v3 server for hours with no way
 * to tell.
 */
export const API_VERSION = 1;

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

export type CmdValue = (typeof CMD)[keyof typeof CMD];

/** Header size for a plain frame, and for a DATA frame carrying a sequence. */
export const HEADER_BYTES = 3;
export const DATA_HEADER_BYTES = 7;

export interface DecodedFrame {
  sessionId: number;
  cmd: number;
  payload: Uint8Array;
  /** Present only on DATA frames. */
  seq?: number;
}

export function encode(sessionId: number, cmd: number, payload?: Uint8Array): Uint8Array {
  const payloadLen = payload?.length ?? 0;
  const frame = new Uint8Array(HEADER_BYTES + payloadLen);
  frame[0] = sessionId & 0xff;
  frame[1] = (sessionId >>> 8) & 0xff;
  frame[2] = cmd;
  if (payloadLen > 0) frame.set(payload!, HEADER_BYTES);
  return frame;
}

export function encodeData(sessionId: number, seq: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(DATA_HEADER_BYTES + payload.length);
  frame[0] = sessionId & 0xff;
  frame[1] = (sessionId >>> 8) & 0xff;
  frame[2] = CMD.DATA;
  frame[3] = seq & 0xff;
  frame[4] = (seq >>> 8) & 0xff;
  frame[5] = (seq >>> 16) & 0xff;
  frame[6] = (seq >>> 24) & 0xff;
  frame.set(payload, DATA_HEADER_BYTES);
  return frame;
}

/**
 * DATA frames are not symmetric, and the decoder has to know which way the
 * frame travelled.
 *
 * Server → client DATA carries a u32 sequence for replay/ack (encodeData).
 * Client → server DATA is bare input bytes (encode) — a keystroke has no
 * sequence. Unifying the two copies of this module into one decode() hid
 * that asymmetry: the server began treating any input frame of four or more
 * payload bytes as if it carried a sequence, and ate the first four bytes.
 * One-byte keys and single Hangul syllables (3 bytes) slipped under the
 * 7-byte threshold, which is why plain typing kept working while an IME
 * commit like '녕 ' — and every paste — silently lost its head.
 */
function decodeFrame(data: ArrayBuffer | Uint8Array, dataCarriesSeq: boolean): DecodedFrame | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < HEADER_BYTES) return null;

  const sessionId = bytes[0] | (bytes[1] << 8);
  const cmd = bytes[2];

  if (dataCarriesSeq && cmd === CMD.DATA && bytes.length >= DATA_HEADER_BYTES) {
    const seq = (bytes[3] | (bytes[4] << 8) | (bytes[5] << 16) | (bytes[6] << 24)) >>> 0;
    return { sessionId, cmd, seq, payload: bytes.subarray(DATA_HEADER_BYTES) };
  }
  return { sessionId, cmd, payload: bytes.subarray(HEADER_BYTES) };
}

/** What a client receives from the server. DATA parses its sequence. */
export function decodeServerFrame(data: ArrayBuffer | Uint8Array): DecodedFrame | null {
  return decodeFrame(data, true);
}

/** What the server receives from a client. DATA is bare input bytes. */
export function decodeClientFrame(data: ArrayBuffer | Uint8Array): DecodedFrame | null {
  return decodeFrame(data, false);
}

/**
 * Kept for the clients that already import it; identical to decodeServerFrame.
 * The server must not use this — its inbound DATA has no sequence.
 */
export const decode = decodeServerFrame;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function jsonPayload(obj: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(obj));
}

export function parseJson<T = unknown>(payload: Uint8Array): T | null {
  try {
    return JSON.parse(decoder.decode(payload)) as T;
  } catch {
    return null;
  }
}

export function textPayload(text: string): Uint8Array {
  return encoder.encode(text);
}

export function payloadText(payload: Uint8Array): string {
  return decoder.decode(payload);
}

export { isRuntimeMetaKey, runtimeMetaKeys, isRuntimeOnlyPatch } from './meta.js';
