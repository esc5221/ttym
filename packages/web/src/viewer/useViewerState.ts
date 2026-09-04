import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '@ttym/api';
import type { ViewerState, ViewPresentation } from '@ttym/api';
import type { TerminalMux } from '@ttym/ui';
import { API_BASE } from '../app-shared.js';

/**
 * Viewer state for the sessions on screen.
 *
 * Two halves, two owners. The server's half (which tabs exist) arrives by
 * GET once and CMD.VIEW push after; `version` orders them so a slow GET
 * cannot overwrite a newer push. The client's half (which tab is in front)
 * lives here and nowhere else — a tab click on this screen must not move
 * the tab on another.
 *
 * The one bridge between them is `lastOpen`: `ttym open` says which tab to
 * bring forward and how. Each serial is acted on once per page, then the
 * user's clicks win again.
 */

export interface ViewerHook {
  states: Record<number, ViewerState | null>;
  /** Per session: a tab id, or 'term' for the terminal itself. */
  active: Record<number, string>;
  setActive: (sid: number, vid: string) => void;
  close: (sid: number, vid: string) => Promise<void>;
  closeAll: (sid: number) => Promise<void>;
  open: (sid: number, targets: string[], presentation?: ViewPresentation) => Promise<void>;
}

export function useViewerState(
  mux: TerminalMux,
  sessionIds: number[],
  onPresent: (sid: number, vid: string, presentation: ViewPresentation) => void,
): ViewerHook {
  const [states, setStates] = useState<Record<number, ViewerState | null>>({});
  const [active, setActiveMap] = useState<Record<number, string>>({});
  const seenSerial = useRef<Map<number, number>>(new Map());
  const presentRef = useRef(onPresent);
  presentRef.current = onPresent;
  const key = sessionIds.join(',');

  /** Merge one session's state in version order; act on a new open request once. */
  const accept = useCallback((sid: number, incoming: ViewerState | null) => {
    setStates((prev) => {
      const current = prev[sid];
      if (incoming && current && current.version >= incoming.version) return prev;
      if (!incoming && !current) return prev;
      return { ...prev, [sid]: incoming };
    });
    if (!incoming) {
      setActiveMap((prev) => { if (!(sid in prev)) return prev; const next = { ...prev }; delete next[sid]; return next; });
      return;
    }
    const req = incoming.lastOpen;
    const seen = seenSerial.current.get(sid) ?? 0;
    if (req && req.serial > seen) {
      seenSerial.current.set(sid, req.serial);
      setActiveMap((prev) => ({ ...prev, [sid]: req.itemId }));
      presentRef.current(sid, req.itemId, req.presentation);
    } else {
      // Keep the active tab valid. First choice is what this browser was
      // looking at last time (a reload must land on the same tab), then the
      // last tab — a closed tab hands over to its neighbour that way too.
      setActiveMap((prev) => {
        const cur = prev[sid];
        if (cur && incoming.items.some((item) => item.id === cur)) return prev;
        const remembered = readActive(sid);
        // 'term' is a tab too — the terminal itself. Remembered as such, it stays in front.
        if (cur === 'term' || (cur === undefined && remembered === 'term')) return cur === 'term' ? prev : { ...prev, [sid]: 'term' };
        const fallback = incoming.items.find((item) => item.id === remembered) ?? incoming.items[incoming.items.length - 1];
        return fallback ? { ...prev, [sid]: fallback.id } : prev;
      });
    }
  }, []);

  // Initial GET per session, and the push subscription.
  useEffect(() => {
    let cancelled = false;
    const ids = key ? key.split(',').map(Number) : [];
    for (const sid of ids) {
      // A serial we already acted on in this page must not fire again after a
      // re-fetch (workspace change, reconnect) — mark what the server has.
      api.getViews(API_BASE, sid).then((state) => {
        if (cancelled) return;
        if (state?.lastOpen && !seenSerial.current.has(sid)) seenSerial.current.set(sid, state.lastOpen.serial);
        accept(sid, state);
      }).catch(() => {});
    }
    const unsubscribe = mux.onView((event) => {
      if (!ids.includes(event.sessionId)) return;
      accept(event.sessionId, event.state);
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [key, mux, accept]);

  const setActive = useCallback((sid: number, vid: string) => {
    writeActive(sid, vid);
    setActiveMap((prev) => (prev[sid] === vid ? prev : { ...prev, [sid]: vid }));
  }, []);

  // What `ttym open` brought forward counts as looked at, too.
  useEffect(() => {
    for (const [sid, vid] of Object.entries(active)) writeActive(Number(sid), vid);
  }, [active]);

  const close = useCallback(async (sid: number, vid: string) => {
    try {
      const { state } = await api.closeView(API_BASE, sid, vid);
      accept(sid, state);
    } catch {}
  }, [accept]);

  const closeAll = useCallback(async (sid: number) => {
    try { await api.closeAllViews(API_BASE, sid); accept(sid, null); } catch {}
  }, [accept]);

  const open = useCallback(async (sid: number, targets: string[], presentation?: ViewPresentation) => {
    try {
      const { state } = await api.openViews(API_BASE, sid, { targets, presentation });
      accept(sid, state);
    } catch {}
  }, [accept]);

  return { states, active, setActive, close, closeAll, open };
}

function readActive(sid: number): string | null {
  try { return window.localStorage.getItem(`ttym-viewer-active:${sid}`); } catch { return null; }
}
function writeActive(sid: number, vid: string): void {
  try { window.localStorage.setItem(`ttym-viewer-active:${sid}`, vid); } catch {}
}
