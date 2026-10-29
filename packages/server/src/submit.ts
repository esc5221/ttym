/**
 * Type a line into a pane and press Enter — the one path `ttym await` and `ttym send --submit` share.
 *
 * Into an agent's TUI (Claude Code, Codex) that is not one write. Each step below is a way the
 * prompt was seen to sit in the composer, unsent:
 *
 *   too early   a pane just started draws its welcome first; input before the composer is up
 *               was kept as text but the Enter was lost (bp w-alerts, 10-28: 15 minutes).
 *   one write   a long text written at once arrives in two PTY reads; Claude kept only the second.
 *               So 512-byte pieces 20 ms apart (PLAYBOOK F-10).
 *   CR glued    the Enter in the same read as the text is a pasted newline, not a submit.
 *               So the CR goes SUBMIT_GAP_MS later, on its own.
 *   paste mode  Claude may still read the pieces as a paste whose end it never saw, and take the CR
 *               as a newline. Sending the end-of-paste mark (ESC [201~) and the CR again submits.
 *
 * The last is checked, not assumed: after the CR the composer must have moved on. A text still
 * there gets the end mark and one more CR; still there after that, the caller hears `false`.
 */
import type { ScreenRun } from '@ttym/protocol';
import { composerText, SUBMIT_GAP_MS, type AgentKind } from './agent-sleep.js';

export const PROMPT_PIECE_BYTES = 512;
export const PROMPT_PIECE_GAP_MS = 20;
/** How long a pane gets to draw its composer before the text goes in anyway (Claude boots in 3–5 s). */
export const COMPOSER_READY_MS = 15_000;
/** How long after the CR the composer gets to empty. */
export const SUBMIT_SETTLE_MS = 1_500;
/** How long the typed text gets to show in the composer before the CR goes anyway. */
export const TYPED_MS = 1_000;
const POLL_MS = 50;
const PASTE_END = Buffer.from('\x1b[201~');

/** Split without cutting a UTF-8 sequence: a piece never ends on a continuation byte's lead. */
export function utf8Pieces(bytes: Buffer, max: number): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < bytes.length;) {
    let end = Math.min(bytes.length, i + max);
    while (end < bytes.length && end > i + 1 && (bytes[end]! & 0xc0) === 0x80) end--;
    out.push(bytes.subarray(i, end));
    i = end;
  }
  return out.length ? out : [bytes];
}

export interface SubmitTarget {
  readonly isDead: boolean;
  write(data: Buffer): void;
  screenTail(max: number): ScreenRun[][];
}

export interface SubmitOptions {
  /** cr: an interactive TUI's Enter · lf: a shell's · none: type only */
  submit: 'cr' | 'lf' | 'none';
  /** The agent drawing the composer; null = a shell or unknown, nothing to watch. */
  agent: AgentKind | null;
  /** Skip watching the screen — a sleeping pane shows a frozen one and queues the input. */
  blind?: boolean;
  readyMs?: number;
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SubmitResult {
  /** true: the composer moved on · false: the text is still there after the retry · null: nothing to watch */
  submitted: boolean | null;
  /** The end-of-paste mark and a second CR were needed. */
  retried: boolean;
  /** Time spent waiting for the composer before typing. */
  waitedMs: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function typeAndSubmit(target: SubmitTarget, text: string, opts: SubmitOptions): Promise<SubmitResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const watch = opts.agent !== null && !opts.blind && opts.submit === 'cr';
  const composer = () => {
    try { return composerText(target.screenTail(40), opts.agent!); } catch { return null; }
  };

  let waitedMs = 0;
  let before: string | null = null;
  if (watch) {
    const readyMs = opts.readyMs ?? COMPOSER_READY_MS;
    while ((before = composer()) === null && waitedMs < readyMs && !target.isDead) {
      await sleep(POLL_MS);
      waitedMs += POLL_MS;
    }
  }

  const pieces = opts.submit === 'cr' ? utf8Pieces(Buffer.from(text), PROMPT_PIECE_BYTES) : [Buffer.from(text)];
  for (let i = 0; i < pieces.length; i++) {
    if (target.isDead) break;
    target.write(pieces[i]!);
    if (i + 1 < pieces.length) await sleep(PROMPT_PIECE_GAP_MS);
  }
  if (opts.submit === 'none' || target.isDead) return { submitted: null, retried: false, waitedMs };
  if (opts.submit === 'lf') {
    target.write(Buffer.from([0x0a]));
    return { submitted: null, retried: false, waitedMs };
  }
  await sleep(SUBMIT_GAP_MS);
  // Enter once the text shows in the composer — else an empty composer read after the CR could be
  // the text not drawn yet rather than the text sent. Not seen within TYPED_MS: Enter anyway.
  if (watch && before !== null) {
    for (let t = 0; t < TYPED_MS && composer() === before && !target.isDead; t += POLL_MS) await sleep(POLL_MS);
  }
  if (target.isDead) return { submitted: null, retried: false, waitedMs };
  target.write(Buffer.from([0x0d]));
  // Nothing to compare with: the composer never showed (a dialog, a boot that outran readyMs).
  if (!watch || before === null) return { submitted: null, retried: false, waitedMs };

  const settleMs = opts.settleMs ?? SUBMIT_SETTLE_MS;
  const movedOn = async () => {
    for (let t = 0; t < settleMs; t += POLL_MS) {
      await sleep(POLL_MS);
      if (target.isDead) return true;
      const now = composer();
      // Empty, back to what it held before we typed, or gone (a dialog opened): the CR took. A draft
      // someone left there goes out with our text, so the composer empties rather than returning to it.
      if (now === null || now === '' || now === before) return true;
    }
    return false;
  };
  if (await movedOn()) return { submitted: true, retried: false, waitedMs };
  target.write(PASTE_END);
  await sleep(SUBMIT_GAP_MS);
  target.write(Buffer.from([0x0d]));
  return { submitted: await movedOn(), retried: true, waitedMs };
}
