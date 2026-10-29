import { describe, expect, it } from 'vitest';
import { hookPatch, hookWaitingIsStale, parseHookEvent, screenInterruptReason, screenShowsPrompt, staleTurnOutcome, STOP_HOOK_GRACE_MS, stopPatch } from './agent-hooks.js';

const NOW = 1_800_000_000_000;
const open = { claudeActive: true, claudeTurnOpen: true, agentActiveAt: NOW - 60_000 };

describe('hookPatch', () => {
  it('a prompt opens the turn and clears the last interruption', () => {
    expect(hookPatch({ event: 'UserPromptSubmit' }, { claudeInterrupted: { at: 1, reason: 'error' } }, NOW))
      .toEqual({ claudeActive: true, claudeTurnOpen: true, claudeTurnAt: NOW, agentActiveAt: NOW, claudeInterrupted: null });
  });

  it('a tool call inside a turn re-stamps liveness; outside one (a background subagent) it opens nothing', () => {
    expect(hookPatch({ event: 'PostToolUse' }, open, NOW)).toEqual({ claudeActive: true, agentActiveAt: NOW });
    expect(hookPatch({ event: 'PostToolUse', agentId: 'a1' }, { claudeActive: false, claudeTurnOpen: false }, NOW)).toBeNull();
  });

  it('a permission request is waiting; the main agent moving on closes it', () => {
    const waiting = hookPatch({ event: 'PermissionRequest', tool: 'Bash' }, open, NOW)!;
    expect(waiting).toEqual({ claudeWaiting: { for: 'permission prompt', tool: 'Bash', at: NOW } });
    const meta = { ...open, ...waiting };
    expect(hookPatch({ event: 'PostToolUse' }, meta, NOW + 5)).toMatchObject({ claudeWaiting: null });
    expect(hookPatch({ event: 'PostToolUseFailure' }, meta, NOW + 5)).toMatchObject({ claudeWaiting: null });
    expect(hookPatch({ event: 'UserPromptSubmit' }, meta, NOW + 5)).toMatchObject({ claudeWaiting: null });
  });

  it("a subagent's prompt is closed only by that subagent", () => {
    const meta = { ...open, claudeWaiting: { for: 'permission prompt', agentId: 'a1', at: NOW } };
    expect(hookPatch({ event: 'PostToolUse' }, meta, NOW + 5)).not.toHaveProperty('claudeWaiting');
    expect(hookPatch({ event: 'PostToolUse', agentId: 'a2' }, meta, NOW + 5)).not.toHaveProperty('claudeWaiting');
    expect(hookPatch({ event: 'UserPromptSubmit' }, meta, NOW + 5)).not.toHaveProperty('claudeWaiting');
    expect(hookPatch({ event: 'PostToolUse', agentId: 'a1' }, meta, NOW + 5)).toMatchObject({ claudeWaiting: null });
    expect(hookPatch({ event: 'SubagentStop', agentId: 'a1' }, meta, NOW + 5)).toEqual({ claudeWaiting: null });
    expect(hookPatch({ event: 'SubagentStop', agentId: 'a2' }, meta, NOW + 5)).toBeNull();
  });

  it('Notification: permission_prompt only when PermissionRequest did not already say so; elicitation; idle is nothing', () => {
    expect(hookPatch({ event: 'Notification', notificationType: 'permission_prompt' }, open, NOW)).toEqual({ claudeWaiting: { for: 'permission prompt', at: NOW } });
    expect(hookPatch({ event: 'Notification', notificationType: 'permission_prompt' }, { ...open, claudeWaiting: { for: 'permission prompt', at: 1 } }, NOW)).toBeNull();
    expect(hookPatch({ event: 'Notification', notificationType: 'elicitation_dialog' }, open, NOW)).toEqual({ claudeWaiting: { for: 'elicitation', at: NOW } });
    expect(hookPatch({ event: 'Notification', notificationType: 'idle_prompt' }, open, NOW)).toBeNull();
  });
});

describe('stopPatch', () => {
  it('StopFailure is an interruption with the error Claude printed; Stop clears it', () => {
    expect(stopPatch('StopFailure', 'API Error: Connection refused', {}, NOW)).toEqual({ claudeInterrupted: { at: NOW, reason: 'error', message: 'API Error: Connection refused' } });
    expect(stopPatch('Stop', 'done', { claudeInterrupted: { at: 1, reason: 'error' } }, NOW)).toEqual({ claudeInterrupted: null });
  });

  it("closes the main agent's prompt, not a subagent's (unless the session ended)", () => {
    expect(stopPatch('Stop', null, { claudeWaiting: { for: 'permission prompt', at: 1 } }, NOW)).toMatchObject({ claudeWaiting: null });
    expect(stopPatch('Stop', null, { claudeWaiting: { for: 'permission prompt', agentId: 'a1', at: 1 } }, NOW)).not.toHaveProperty('claudeWaiting');
    expect(stopPatch('SessionEnd', null, { claudeWaiting: { for: 'permission prompt', agentId: 'a1', at: 1 } }, NOW)).toMatchObject({ claudeWaiting: null });
  });
});

describe('hookWaitingIsStale', () => {
  const w = { for: 'permission prompt', at: 10_000 };
  it('closes once Claude says anything but waiting, stamped after the prompt opened', () => {
    expect(hookWaitingIsStale(w, { status: 'busy', updatedAt: 12_000 })).toBe(true);
    expect(hookWaitingIsStale(w, { status: 'idle', updatedAt: 12_000 })).toBe(true);
  });
  it('stays while Claude says waiting, or its last word is older than the prompt, or there is no word', () => {
    expect(hookWaitingIsStale(w, { status: 'waiting', updatedAt: 99_000 })).toBe(false);
    // The busy written at PreToolUse lands just before PermissionRequest.
    expect(hookWaitingIsStale(w, { status: 'busy', updatedAt: 9_990 })).toBe(false);
    expect(hookWaitingIsStale(w, null)).toBe(false);
  });
});

describe('screen fallbacks', () => {
  it('a permission dialog needs both its question and its footer', () => {
    expect(screenShowsPrompt([' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel · Tab to amend'])).toBe(true);
    expect(screenShowsPrompt(['● I asked: Do you want to proceed?', '❯ '])).toBe(false);
  });
  it('names how a turn without Stop ended', () => {
    expect(screenInterruptReason(['  ⎿  Interrupted · What should Claude do instead?', '❯ '])).toBe('interrupted');
    expect(screenInterruptReason(['● API Error: Connection lost', '❯ '])).toBe('error');
    // Esc before any output: nothing on screen but the prompt back in the composer.
    expect(screenInterruptReason(['❯ Write an essay', '  ⏵⏵ bypass permissions on'])).toBe('interrupted');
  });
});

describe('parseHookEvent', () => {
  it('takes what the hook forwards, drops empties, refuses a body without an event', () => {
    expect(parseHookEvent({ event: 'PermissionRequest', agentId: null, tool: 'Bash', notificationType: null, message: '' })).toEqual({ event: 'PermissionRequest', tool: 'Bash' });
    expect(parseHookEvent({})).toBeNull();
    expect(parseHookEvent(null)).toBeNull();
  });
});

describe('staleTurnOutcome', () => {
  const open = { claudeActive: true, claudeTurnOpen: true, claudeTurnAt: 10_000, agentActiveAt: 10_000 };
  const idle = { status: 'idle' as const, updatedAt: 20_000 };
  const screen = () => ['❯ '];

  it('waits out the Stop hook: idle a moment ago is not a cut-short turn yet', () => {
    expect(staleTurnOutcome(open, idle, 0, 20_000 + STOP_HOOK_GRACE_MS, screen)).toBeNull();
  });

  it('a Stop that landed during the grace leaves nothing to do (pie lead, 10-29)', () => {
    const closed = { ...open, claudeActive: false, claudeTurnOpen: false, claudeInterrupted: null };
    expect(staleTurnOutcome(closed, idle, 0, 30_000, screen)).toBeNull();
  });

  it('no Stop and no Esc of ours: interrupted, from the screen', () => {
    const r = staleTurnOutcome(open, idle, 0, 30_000, screen)!;
    expect(r.patch).toEqual({ claudeActive: false, claudeTurnOpen: false, claudeInterrupted: { at: 30_000, reason: 'interrupted' } });
    expect(r.ended).toEqual({ at: 30_000, reason: 'interrupted' });
    const err = staleTurnOutcome(open, idle, 0, 30_000, () => ['  ⎿  API Error: 500'])!;
    expect(err.ended?.reason).toBe('error');
  });

  it('an Esc delivered during the turn: someone stopped it — the pane rests, only the await hears', () => {
    const r = staleTurnOutcome(open, idle, 15_000, 30_000, screen)!;
    expect(r.patch).toEqual({ claudeActive: false, claudeTurnOpen: false });
    expect(r.ended).toEqual({ at: 30_000, reason: 'cancelled' });
  });

  it('an Esc from before the turn does not count', () => {
    expect(staleTurnOutcome(open, idle, 9_000, 30_000, screen)!.ended?.reason).toBe('interrupted');
  });

  it('claudeActive without a turn closes quietly', () => {
    const r = staleTurnOutcome({ claudeActive: true, agentActiveAt: 10_000 }, idle, 0, 30_000, screen)!;
    expect(r).toEqual({ patch: { claudeActive: false, claudeTurnOpen: false }, ended: null });
  });
});
