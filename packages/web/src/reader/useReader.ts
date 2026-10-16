import { useMemo, useRef, type RefObject } from 'react';
import type { AgentState } from '../app-shared.js';
import { interrupted } from './model.js';
import { useDockLayout, type DockLayout } from './useDockLayout.js';
import { idsOf, liveVisible, type LiveText } from './live.js';
import { useReaderLive } from './paneReader.js';
import { useScreenLive } from './useScreenLive.js';
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
  /** The pane the person is looking at. Only that one is sent the message being written (a stream for every pane would cost the agents). */
  focused = true,
): { transcript: TranscriptHook; dock: DockLayout | null; working: boolean; live: LiveText | null } {
  const transcript = useTranscript(sid, on, pollMs);
  const dock = useDockLayout(stage, sid, transcript.state.agent ?? agent?.kind ?? null, !!agent?.waiting, on);
  // The agent's own flag says a turn is running; an interruption in the transcript overrides a flag that never cleared.
  // A screen that plainly shows no turn running also overrides it (Esc before the first token leaves the flag on).
  // Claude Code reports it through its hooks. Codex's reach a pane only when it runs its own server (they come from a shared one
  // otherwise), and Antigravity has none, so for those the screen is also evidence: "esc to interrupt" is on it while a turn runs.
  const busy = dock?.busy;
  const flagged = !!agent?.active && busy !== false;
  const running = agent?.kind === 'claude-code' ? flagged : agent?.kind === 'codex' ? flagged || busy === true : busy === true;
  const working = running && !interrupted(transcript.state);

  // Claude Code's record has a message only when it is complete; its terminal draws it from the first words, and the page
  // sits on that terminal. While a tool runs there are no words to show, and the record says so before the screen does.
  const last = transcript.state.blocks[transcript.state.blocks.length - 1];
  const toolRunning = last?.kind === 'tool' && last.status === 'running';
  const liveChosen = useReaderLive();
  const streamed = useScreenLive(sid, on && liveChosen && focused && !toolRunning && (transcript.state.agent ?? agent?.kind) === 'claude-code');
  // What the page held when this message began; blocks after it are what the message may have turned into.
  const seen = useRef<{ mid: string | null; ids: Set<string> }>({ mid: null, ids: new Set() });
  if (streamed && seen.current.mid !== streamed.mid) seen.current = { mid: streamed.mid, ids: idsOf(transcript.state.blocks) };
  if (!streamed) seen.current = { mid: null, ids: seen.current.ids };
  const live = useMemo(
    () => (liveVisible(streamed, transcript.state.blocks, seen.current.ids) ? streamed : null),
    [streamed, transcript.state.blocks],
  );
  return { transcript, dock, working, live };
}
