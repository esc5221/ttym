import { RawData } from 'ws';

/**
 * The wire format itself lives in @ttym/protocol, shared with the clients.
 * What stays here is the one piece that cannot: turning the `ws` library's
 * RawData union into bytes.
 */
export {
  CMD, encode, encodeData, encodeSnapshot, decode, decodeClientFrame, decodeServerFrame, jsonPayload, parseJson,
  HEADER_BYTES, DATA_HEADER_BYTES,
} from '@ttym/protocol';
export type { DecodedFrame, CmdValue } from '@ttym/protocol';

export function toBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  return Buffer.concat(raw);
}
