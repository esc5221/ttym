import { useEffect, useState } from 'react';
import * as api from '@ttym/api';
import { API_BASE } from '../app-shared.js';
import { applyFeed, emptyState, type ReaderState } from './model.js';

/**
 * Keeps a session's conversation current while reader mode is on.
 *
 * Polls the server for what is new since the last answer. A transcript changes
 * a few times a minute at most, reading it is free of side effects, and the
 * answer is only the new bytes, so a one-second poll is cheap; push can replace
 * it later without the page noticing. Polling pauses while the tab is hidden
 * and resumes the moment it is visible.
 */

const DEFAULT_POLL_MS = 1000;
const RETRY_MS = 3000;

export interface TranscriptHook {
  state: ReaderState;
  /** The last request's failure, or null once one succeeds. */
  error: string | null;
}

export function useTranscript(sessionId: number, enabled: boolean, pollMs = DEFAULT_POLL_MS): TranscriptHook {
  const [state, setState] = useState<ReaderState>(emptyState);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The mirror lives here, not in a ref to React state, so a slow answer
    // can never be applied on top of a newer one.
    let current = emptyState();
    setState(current);

    const schedule = (ms: number) => {
      if (!cancelled) timer = setTimeout(tick, ms);
    };
    const tick = async () => {
      if (document.hidden) { schedule(pollMs); return; }
      let wait = pollMs;
      try {
        const feed = await api.getTranscript(API_BASE, sessionId, current.key !== null ? { after: current.next, key: current.key } : undefined);
        if (cancelled) return;
        const next = applyFeed(current, feed);
        if (next !== current) { current = next; setState(next); }
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(String((e as Error).message ?? e));
        wait = RETRY_MS;
      }
      schedule(wait);
    };
    const onVisible = () => {
      if (!document.hidden) { clearTimeout(timer); void tick(); }
    };

    void tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [sessionId, enabled, pollMs]);

  return { state, error };
}
