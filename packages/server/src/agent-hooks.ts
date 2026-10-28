/**
 * What Claude Code's hooks say about a pane, turned into runtime meta.
 *
 * The hooks are the agent telling us; the screen is a rendering we would have to guess from.
 * Three things the old pair of flags (claudeActive, claudeTurnOpen) could not say:
 *
 *   waiting      a permission prompt is up. PermissionRequest fires the moment it opens — in
 *                bypassPermissions too, where Claude still asks for a few commands (an `rm` on
 *                a variable that may be empty) and denies by itself two minutes later.
 *   interrupted  the turn ended without an answer: StopFailure (API error, connection lost),
 *                or no Stop at all (Esc, a denied prompt) — found by the waiting sweep.
 *   liveness     a long turn re-stamps agentActiveAt on every tool call, so it does not age
 *                out at AGENT_ACTIVE_TTL_MS while it is plainly working.
 *
 * Measured on Claude Code 2.1.312 (lab: ~/work/bp-tasks/261029-ttym-state):
 *   prompt approved → no hook until PostToolUse (the tool may run for minutes)
 *   prompt denied / Esc → no hook at all; "Interrupted" on screen, status file goes idle
 *   a subagent's prompt carries its agent_id; the main turn may already have stopped
 *   /compact → PreCompact, SessionStart(source compact), PostCompact — no UserPromptSubmit, no Stop
 * So a hook can open a wait but not always close it; the sweep closes it from the status file.
 */

/** meta.claudeWaiting — a prompt the hooks saw open. agentId: a subagent's (its prompt outlives the main turn). */
export interface HookWaiting { for: string; tool?: string; agentId?: string; at: number }

/** meta.claudeInterrupted — how the last turn ended without an answer. Cleared by the next prompt or a normal Stop. */
export interface Interrupted {
  at: number;
  /**
   * error: StopFailure (API error, connection lost), or an API error on screen ·
   * interrupted: the turn ended with no Stop — Esc (before any output it leaves no trace on screen but
   * the prompt back in the composer), a denied prompt, or, rarely, a Stop that never reached us.
   */
  reason: 'error' | 'interrupted';
  message?: string;
}

/** What the activity hook forwards from Claude Code's payload. */
export interface HookEvent {
  event: string;
  agentId?: string;
  tool?: string;
  notificationType?: string;
  message?: string;
}

export function parseHookEvent(body: unknown): HookEvent | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.event !== 'string' || !b.event) return null;
  const str = (v: unknown, max = 200) => (typeof v === 'string' && v ? v.slice(0, max) : undefined);
  return { event: b.event, agentId: str(b.agentId, 64), tool: str(b.tool, 64), notificationType: str(b.notificationType, 64), message: str(b.message) };
}

export function hookWaitingOf(meta: Record<string, unknown>): HookWaiting | null {
  const w = meta.claudeWaiting;
  return w && typeof w === 'object' && typeof (w as HookWaiting).for === 'string' && typeof (w as HookWaiting).at === 'number' ? w as HookWaiting : null;
}

export function interruptedOf(meta: Record<string, unknown>): Interrupted | null {
  const i = meta.claudeInterrupted;
  return i && typeof i === 'object' && typeof (i as Interrupted).at === 'number' && typeof (i as Interrupted).reason === 'string' ? i as Interrupted : null;
}

/**
 * The meta patch for one hook event; null = nothing to write.
 *
 * A main-thread event after a main-thread prompt means the prompt is gone — the agent was blocked
 * on it. A subagent's prompt is closed only by that subagent (its next tool, its SubagentStop).
 */
export function hookPatch(e: HookEvent, meta: Record<string, unknown>, now: number): Record<string, unknown> | null {
  const waiting = hookWaitingOf(meta);
  const closes = (agentId: string | undefined) => waiting !== null && (waiting.agentId ?? null) === (agentId ?? null);
  switch (e.event) {
    case 'UserPromptSubmit':
      // The turn opens. Whatever stopped the last one is over.
      return { claudeActive: true, claudeTurnOpen: true, claudeTurnAt: now, agentActiveAt: now, claudeInterrupted: null, ...(waiting && !waiting.agentId ? { claudeWaiting: null } : {}) };
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const patch: Record<string, unknown> = {};
      // Liveness inside a turn. A tool call outside one (a background subagent after the main Stop)
      // is work, but not a turn: it must not open one that no Stop will close.
      if (meta.claudeTurnOpen === true) { patch.claudeActive = true; patch.agentActiveAt = now; }
      if (closes(e.agentId)) patch.claudeWaiting = null;
      return Object.keys(patch).length ? patch : null;
    }
    case 'PermissionRequest':
      return { claudeWaiting: { for: 'permission prompt', ...(e.tool ? { tool: e.tool } : {}), ...(e.agentId ? { agentId: e.agentId } : {}), at: now } satisfies HookWaiting };
    case 'Notification':
      // permission_prompt comes ~6 s after PermissionRequest; it only matters to versions without that hook.
      if (e.notificationType === 'permission_prompt' && !waiting) return { claudeWaiting: { for: 'permission prompt', at: now } satisfies HookWaiting };
      if (e.notificationType === 'elicitation_dialog') return { claudeWaiting: { for: 'elicitation', at: now } satisfies HookWaiting };
      return null;
    case 'SubagentStop':
      return waiting?.agentId && waiting.agentId === e.agentId ? { claudeWaiting: null } : null;
    default:
      return null;
  }
}

/** What a Stop / StopFailure / SessionEnd adds to the stop hook's own patch. */
export function stopPatch(event: string, reply: string | null | undefined, meta: Record<string, unknown>, now: number): Record<string, unknown> {
  const waiting = hookWaitingOf(meta);
  const patch: Record<string, unknown> = {};
  // The main agent answered or died; only a subagent's prompt can still be up.
  if (waiting && (!waiting.agentId || event === 'SessionEnd')) patch.claudeWaiting = null;
  if (event === 'StopFailure') patch.claudeInterrupted = { at: now, reason: 'error', ...(reply ? { message: reply.slice(0, 200) } : {}) } satisfies Interrupted;
  else if (event === 'Stop') patch.claudeInterrupted = null;
  return patch;
}

/** Claude's own status moved on after the prompt opened: answered, denied or cancelled. */
export const WAITING_SETTLE_MARGIN_MS = 1000;
export function hookWaitingIsStale(w: HookWaiting, status: { status: string; updatedAt?: number } | null): boolean {
  if (!status || status.status === 'waiting' || typeof status.updatedAt !== 'number') return false;
  return status.updatedAt > w.at + WAITING_SETTLE_MARGIN_MS;
}

/**
 * A permission dialog on screen — only for panes whose status file cannot be read (no agent
 * process found). The two lines Claude Code draws around its choices, both required.
 */
export function screenShowsPrompt(lines: string[]): boolean {
  const tail = lines.slice(-30);
  return tail.some((l) => /Do you want to (proceed|make this edit|create)/.test(l)) && tail.some((l) => /Esc to cancel/.test(l));
}

/** How a turn that never got its Stop ended, read off the last lines of the screen. */
export function screenInterruptReason(lines: string[]): Interrupted['reason'] {
  const tail = lines.slice(-30);
  if (tail.some((l) => /API Error|Connection (lost|error)|Request timed out/.test(l))) return 'error';
  return 'interrupted';
}
