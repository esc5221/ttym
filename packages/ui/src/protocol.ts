/**
 * Re-export of the shared wire format. Kept as a module so existing imports
 * (`./protocol`) keep working; the implementation lives in @ttym/protocol.
 */
export {
  CMD, encode, encodeData, decode, decodeServerFrame, decodeClientFrame, jsonPayload, parseJson,
  HEADER_BYTES, DATA_HEADER_BYTES,
} from '@ttym/protocol';
export type { DecodedFrame, CmdValue } from '@ttym/protocol';
