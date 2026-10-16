/**
 * Just enough of the protobuf wire format to read agy's rows (see agy.ts).
 *
 * A message is a run of (field number, wire type, value). Only two wire types carry what the reader wants —
 * varint (numbers, enums, bools) and length-delimited (strings, bytes, nested messages) — and the fixed-width
 * ones are skipped. Which field means what comes from agy-fields.ts, generated from the binary; a field that is
 * not in those tables is never looked at, so a newer agy that adds fields still reads.
 */

export type Wire = number | Uint8Array;
export type Message = Map<number, Wire[]>;

const decoder = new TextDecoder('utf-8');

/** Decodes one message. Anything that does not parse (a truncated or foreign blob) gives what was read before the break. */
export function decode(buf: Uint8Array): Message {
  const out: Message = new Map();
  let i = 0;
  const varint = (): number => {
    let result = 0;
    let scale = 1;
    for (let n = 0; n < 10; n++) {
      if (i >= buf.length) throw new RangeError('truncated varint');
      const b = buf[i++]!;
      result += (b & 0x7f) * scale;
      if (!(b & 0x80)) return result;
      scale *= 128;
    }
    throw new RangeError('varint too long');
  };
  try {
    while (i < buf.length) {
      const tag = varint();
      const field = Math.floor(tag / 8);
      const type = tag % 8;
      let value: Wire;
      if (type === 0) value = varint();
      else if (type === 2) {
        const len = varint();
        if (i + len > buf.length) throw new RangeError('truncated field');
        value = buf.subarray(i, i + len);
        i += len;
      } else if (type === 1) { i += 8; continue; }
      else if (type === 5) { i += 4; continue; }
      else break; // groups and unknown types end what can be read
      const list = out.get(field);
      if (list) list.push(value); else out.set(field, [value]);
    }
  } catch { /* keep what was read */ }
  return out;
}

export const first = (m: Message | undefined, field: number): Wire | undefined => m?.get(field)?.[0];
export const all = (m: Message | undefined, field: number): Wire[] => m?.get(field) ?? [];

export function text(v: Wire | undefined): string {
  return v instanceof Uint8Array ? decoder.decode(v) : '';
}
export const num = (v: Wire | undefined): number => (typeof v === 'number' ? v : 0);
export function msg(v: Wire | undefined): Message | undefined {
  return v instanceof Uint8Array ? decode(v) : undefined;
}
