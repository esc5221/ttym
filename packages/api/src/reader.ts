import { request, type BaseUrl } from './transport.js';
import type { ReaderFeed } from '@ttym/protocol';

/**
 * A session's conversation, read from its agent's own record (reader mode).
 *
 * Ask with nothing to get the tail of the conversation; ask again with the
 * previous answer's `next` and `key` to get only what was added. A different
 * `key` in the answer means the record changed and `reset` says to start over.
 */
export function getTranscript(base: BaseUrl, sessionId: number, since?: { after: number; key: string | null }): Promise<ReaderFeed> {
  return request(base, `/api/sessions/${sessionId}/transcript`, {
    query: since ? { after: since.after, key: since.key ?? undefined } : undefined,
  });
}

/** The page of history ahead of `before` (a previous answer's `from`) in the record `key` names. */
export function getTranscriptBefore(base: BaseUrl, sessionId: number, before: number, key: string): Promise<ReaderFeed> {
  return request(base, `/api/sessions/${sessionId}/transcript`, { query: { before, key } });
}
