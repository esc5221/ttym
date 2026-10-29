import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '@ttym/api';
import { API_BASE } from '../app-shared.js';
import { applyEarlier, applyFeed, emptyState, type ReaderState } from './model.js';

/**
 * Keeps a session's conversation current while reader mode is on.
 *
 * Polls the server for what is new since the last answer. A transcript changes
 * a few times a minute at most, reading it is free of side effects, and the
 * answer is only the new bytes, so a one-second poll is cheap; push can replace
 * it later without the page noticing. Polling pauses while the tab is hidden
 * and resumes the moment it is visible.
 *
 * The first answer holds only the end of the conversation; `loadEarlier` fetches
 * the page of history above what is held, one page per call.
 */

const DEFAULT_POLL_MS = 1000;
const RETRY_MS = 3000;

export interface TranscriptHook {
  state: ReaderState;
  /** The last request's failure, or null once one succeeds. */
  error: string | null;
  /** Fetch the page of history above `state.blocks`; does nothing when there is none or one is already on its way. */
  loadEarlier: () => void;
  loadingEarlier: boolean;
  /**
   * Read now instead of at the next poll — for a page that hears of a change by push (an embedder's
   * own event stream). One already on its way is followed by one more, so nothing said meanwhile is missed.
   */
  refresh: () => void;
}

export function useTranscript(sessionId: number, enabled: boolean, pollMs = DEFAULT_POLL_MS): TranscriptHook {
  const [state, setState] = useState<ReaderState>(emptyState);
  const [error, setError] = useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  // The mirror lives in a ref so a slow answer is always applied on top of the newest state, never an older one.
  const latest = useRef<ReaderState>(state);
  const paging = useRef(false);
  const poke = useRef<() => void>(() => {});

  const commit = useCallback((next: ReaderState) => {
    if (next === latest.current) return;
    latest.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    latest.current = emptyState();
    setState(latest.current);

    let inFlight = false;
    let again = false;
    const schedule = (ms: number) => {
      if (!cancelled) timer = setTimeout(tick, ms);
    };
    const tick = async () => {
      if (document.hidden) { schedule(pollMs); return; }
      inFlight = true;
      let wait = pollMs;
      try {
        const have = latest.current;
        const feed = await api.getTranscript(API_BASE, sessionId, have.key !== null ? { after: have.next, key: have.key } : undefined);
        if (cancelled) return;
        commit(applyFeed(latest.current, feed));
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(String((e as Error).message ?? e));
        wait = RETRY_MS;
      }
      inFlight = false;
      if (again) { again = false; wait = 0; }
      schedule(wait);
    };
    poke.current = () => {
      if (cancelled) return;
      if (inFlight) { again = true; return; }
      clearTimeout(timer);
      void tick();
    };
    const onVisible = () => {
      if (!document.hidden) { clearTimeout(timer); void tick(); }
    };

    void tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      poke.current = () => {};
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [sessionId, enabled, pollMs, commit]);

  const loadEarlier = useCallback(() => {
    const have = latest.current;
    if (paging.current || have.earlier === null || have.key === null) return;
    paging.current = true;
    setLoadingEarlier(true);
    api.getTranscriptBefore(API_BASE, sessionId, have.earlier, have.key)
      .then((feed) => { commit(applyEarlier(latest.current, feed)); setError(null); })
      .catch((e) => setError(String((e as Error).message ?? e)))
      .finally(() => { paging.current = false; setLoadingEarlier(false); });
  }, [sessionId, commit]);

  const refresh = useCallback(() => poke.current(), []);

  return { state, error, loadEarlier, loadingEarlier, refresh };
}
