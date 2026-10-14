import { useEffect, useRef, useState } from 'react';
import { faviconHref, faviconSvg, pickState, summarizeAgents, tabTitle, type AgentActivity, type TabIdentity } from './favicon.js';

/**
 * Keeps the browser tab's icon and title in step with the agents (see favicon.ts for what they show).
 *
 * On a workspace, the icon is that workspace's colour and initial and its state covers that workspace's panes;
 * a pane waiting in another workspace shows as a small dot. Elsewhere (no `scope`) the state covers every pane.
 * A turn that ends while this tab can't be seen leaves a "done" mark until the tab is looked at again.
 */
export function useTabIdentity({ agentStates, connected, base, accent, instance, identity, scope }: {
  agentStates: Record<number, AgentActivity>;
  connected: boolean;
  /** Where the person is: a workspace's name, or nothing. */
  base: string;
  accent: string;
  /** This server's own name, if it has one. */
  instance: string;
  /** The workspace this tab is on: its name gives the initial, `key` the colour (a stream's workspaces share one key). */
  identity?: TabIdentity;
  /** Session ids of that workspace; the state is only about these. */
  scope?: ReadonlySet<number> | null;
}): void {
  const [doneUnseen, setDoneUnseen] = useState(false);
  // Which agents were working at the last look; null before the first answer, so what was already running at load is not "finished".
  const working = useRef<Set<number> | null>(null);

  useEffect(() => {
    const now = new Set<number>();
    for (const [id, a] of Object.entries(agentStates)) if (a?.kind && a.active && !a.waiting && (!scope || scope.has(Number(id)))) now.add(Number(id));
    const before = working.current;
    working.current = now;
    if (!before || Object.keys(agentStates).length === 0) return;
    const unseen = !document.hasFocus() || document.hidden;
    if (unseen && [...before].some((id) => !now.has(id) && agentStates[id]?.kind && !agentStates[id]?.waiting)) setDoneUnseen(true);
  }, [agentStates, scope]);

  useEffect(() => {
    const seen = () => { if (document.hasFocus() && !document.hidden) setDoneUnseen(false); };
    document.addEventListener('visibilitychange', seen);
    window.addEventListener('focus', seen);
    return () => { document.removeEventListener('visibilitychange', seen); window.removeEventListener('focus', seen); };
  }, []);

  const { waiting, running } = summarizeAgents(agentStates, scope);
  const elsewhere = scope ? summarizeAgents(agentStates).waiting > waiting : false;
  const state = pickState({ connected, waiting, doneUnseen, running });

  useEffect(() => {
    document.title = tabTitle({ base, state, count: waiting, instance: instance || undefined });
  }, [base, state, waiting, instance]);

  useEffect(() => {
    // Chrome often keeps the old tab icon when only an existing <link>'s href changes; a new element is picked up.
    document.querySelectorAll('link[rel="icon"][type="image/svg+xml"]').forEach((el) => el.remove());
    const link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/svg+xml';
    link.href = faviconHref(faviconSvg({ state, count: waiting, accent, identity, elsewhere }));
    document.head.appendChild(link);
  }, [state, waiting, accent, identity?.key, identity?.name, elsewhere]);
}
