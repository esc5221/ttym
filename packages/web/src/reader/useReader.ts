import type { RefObject } from 'react';
import type { AgentState } from '../app-shared.js';
import { interrupted } from './model.js';
import { useDockLayout, type DockLayout } from './useDockLayout.js';
import { useTranscript, type TranscriptHook } from './useTranscript.js';

/**
 * What a screen needs to show reader mode: the conversation and where the
 * terminal's input rows are. `stage` is the box the page is laid over, `on`
 * switches both off together so a hidden reader costs nothing.
 */
export function useReader(
  sid: number,
  agent: AgentState | undefined,
  stage: RefObject<HTMLElement | null>,
  on: boolean,
  pollMs?: number,
): { transcript: TranscriptHook; dock: DockLayout | null; working: boolean } {
  const transcript = useTranscript(sid, on, pollMs);
  const dock = useDockLayout(stage, sid, transcript.state.agent ?? agent?.kind ?? null, !!agent?.waiting, on);
  // The agent's own flag says a turn is running; an interruption in the transcript overrides a flag that never cleared.
  // A screen that plainly shows no turn running also overrides it (Esc before the first token leaves the flag on).
  const working = !!agent?.active && !interrupted(transcript.state) && dock?.busy !== false;
  return { transcript, dock, working };
}
