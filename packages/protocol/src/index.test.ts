import { describe, expect, it } from 'vitest';
import {
  CMD, encode, encodeData, encodeSnapshot, decode, decodeClientFrame, decodeServerFrame, jsonPayload, parseJson,
  HEADER_BYTES, DATA_HEADER_BYTES,
} from './index.js';

const bytes = (...n: number[]) => new Uint8Array(n);

describe('wire format', () => {
  it('lays out a plain frame as [u16 id][u8 cmd][payload]', () => {
    const frame = encode(0x0102, CMD.ATTACH, bytes(9, 8));
    expect(frame[0]).toBe(0x02); // little endian
    expect(frame[1]).toBe(0x01);
    expect(frame[2]).toBe(CMD.ATTACH);
    expect(Array.from(frame.subarray(HEADER_BYTES))).toEqual([9, 8]);
  });

  it('lays out a DATA frame with a u32 sequence', () => {
    const frame = encodeData(7, 0xdeadbeef, bytes(1, 2, 3));
    expect(frame[2]).toBe(CMD.DATA);
    const seq = (frame[3] | (frame[4] << 8) | (frame[5] << 16) | (frame[6] << 24)) >>> 0;
    expect(seq).toBe(0xdeadbeef);
    expect(Array.from(frame.subarray(DATA_HEADER_BYTES))).toEqual([1, 2, 3]);
  });

  it('round-trips a plain frame', () => {
    const decoded = decode(encode(4242, CMD.RESIZE, bytes(80, 24)))!;
    expect(decoded.sessionId).toBe(4242);
    expect(decoded.cmd).toBe(CMD.RESIZE);
    expect(decoded.seq).toBeUndefined();
    expect(Array.from(decoded.payload)).toEqual([80, 24]);
  });

  it('round-trips a DATA frame including the sequence', () => {
    const decoded = decode(encodeData(1, 4294967295, bytes(65, 66)))!;
    expect(decoded.cmd).toBe(CMD.DATA);
    expect(decoded.seq).toBe(4294967295); // must not come back negative
    expect(Array.from(decoded.payload)).toEqual([65, 66]);
  });

  it('accepts an ArrayBuffer as well as a Uint8Array', () => {
    const frame = encode(5, CMD.HELLO, bytes(1));
    const fromView = decode(frame)!;
    const copy = new ArrayBuffer(frame.length);
    new Uint8Array(copy).set(frame);
    const fromBuffer = decode(copy)!;
    expect(fromBuffer).toEqual(fromView);
  });

  it('reads bytes written by Node Buffers', () => {
    // The server passes Buffers in; Buffer extends Uint8Array, so this is the
    // same code path — but it is the compatibility the split copies existed for.
    const payload = Buffer.from('hello');
    const decoded = decode(encodeSnapshot(9, 7, payload))!;
    expect(decoded.seq).toBe(7);
    expect(Buffer.from(decoded.payload).toString()).toBe('hello');
  });

  it('returns null rather than a garbage frame when too short', () => {
    expect(decode(bytes())).toBeNull();
    expect(decode(bytes(1, 2))).toBeNull();
    expect(decode(bytes(1, 2, 3))).not.toBeNull();
  });

  it('treats a DATA frame without room for a sequence as a plain frame', () => {
    const short = bytes(1, 0, CMD.DATA, 9);
    const decoded = decode(short)!;
    expect(decoded.seq).toBeUndefined();
    expect(Array.from(decoded.payload)).toEqual([9]);
  });

  it('carries a session id across the full u16 range', () => {
    for (const id of [0, 1, 255, 256, 65535]) {
      expect(decode(encode(id, CMD.ACK))!.sessionId).toBe(id);
    }
  });
});

describe('json payloads', () => {
  it('round-trips an object', () => {
    const obj = { ok: true, name: '한글', n: 42 };
    expect(parseJson(jsonPayload(obj))).toEqual(obj);
  });

  it('returns null on malformed input instead of throwing', () => {
    expect(parseJson(new TextEncoder().encode('{not json'))).toBeNull();
  });

  it('survives the frame round trip', () => {
    const frame = encode(3, CMD.LIST, jsonPayload([{ id: 1 }]));
    expect(parseJson(decode(frame)!.payload)).toEqual([{ id: 1 }]);
  });
});

describe('direction asymmetry — the Korean input regression', () => {
  it('client input DATA keeps every byte, even at 4+ bytes of payload', () => {
    // '녕 ' — a Hangul syllable committed together with the space that ended
    // its composition. 4 bytes of payload, 7 bytes of frame: exactly the
    // shape the unified decode mistook for a seq-carrying server frame,
    // eating all four bytes and making the syllable vanish on screen.
    const input = new TextEncoder().encode('녕 ');
    const frame = encode(3, CMD.DATA, input);
    const decoded = decodeClientFrame(frame)!;
    expect(decoded.seq).toBeUndefined();
    expect(new TextDecoder().decode(decoded.payload)).toBe('녕 ');
  });

  it('a paste through the client path keeps its first four bytes', () => {
    const input = new TextEncoder().encode('echo hello\n');
    const decoded = decodeClientFrame(encode(1, CMD.DATA, input))!;
    expect(new TextDecoder().decode(decoded.payload)).toBe('echo hello\n');
  });

  it('server output DATA still carries its sequence', () => {
    const decoded = decodeServerFrame(encodeData(1, 42, new TextEncoder().encode('ok')))!;
    expect(decoded.seq).toBe(42);
    expect(new TextDecoder().decode(decoded.payload)).toBe('ok');
  });
});

describe('snapshot watermark', () => {
  it('round-trips the sequence on a server → client snapshot', () => {
    const frame = encodeSnapshot(9, 41, new TextEncoder().encode('screen'));
    const decoded = decodeServerFrame(frame)!;
    expect(decoded.cmd).toBe(CMD.SNAPSHOT);
    expect(decoded.seq).toBe(41);
    expect(new TextDecoder().decode(decoded.payload)).toBe('screen');
  });

  it('leaves the client → server snapshot request bare', () => {
    // requestSnapshot sends a headerless frame; the server-side decoder must
    // not eat anything as a sequence — same asymmetry as DATA.
    const decoded = decodeClientFrame(encode(9, CMD.SNAPSHOT))!;
    expect(decoded.seq).toBeUndefined();
    expect(decoded.payload.length).toBe(0);
  });

  it('treats a snapshot without room for a sequence as a plain frame', () => {
    const decoded = decodeServerFrame(bytes(9, 0, CMD.SNAPSHOT, 0x78))!;
    expect(decoded.seq).toBeUndefined();
    expect(Array.from(decoded.payload)).toEqual([0x78]);
  });
});

describe('forward compatibility', () => {
  it('decodes a frame with an unknown command instead of rejecting it', () => {
    // The server is always newest; a client one version behind must be able
    // to skip commands it does not know rather than die on them.
    const unknown = encode(7, 0x5f, bytes(1, 2, 3));
    const decoded = decodeServerFrame(unknown)!;
    expect(decoded.cmd).toBe(0x5f);
    expect(Array.from(decoded.payload)).toEqual([1, 2, 3]);
  });
});
