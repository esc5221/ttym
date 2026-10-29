import { describe, expect, it } from 'vitest';
import type { ScreenRun } from '@ttym/protocol';
import { typeAndSubmit, type SubmitTarget } from './submit.js';

/**
 * A pane with Claude's composer. `onCr` says what a CR does to it: 'send' clears it, 'newline'
 * keeps the text (a paste whose end was never seen) until the end-of-paste mark arrives.
 */
function pane(opts: { onCr: 'send' | 'newline' | 'never'; bootPolls?: number; drawDelay?: number; draft?: string }) {
  let composer = opts.draft ?? '';
  let pasteOpen = opts.onCr !== 'send';
  let boot = opts.bootPolls ?? 0;
  let pending = '';
  let draw = 0;
  const writes: string[] = [];
  const rule: ScreenRun[] = [{ t: '─'.repeat(40) }];
  const target: SubmitTarget = {
    isDead: false,
    write(data) {
      const s = data.toString();
      writes.push(s);
      if (s === '\x1b[201~') { if (opts.onCr !== 'never') pasteOpen = false; return; }
      if (s === '\r') { if (!pasteOpen) composer = ''; else composer += '\n'; return; }
      pending += s;
      draw = opts.drawDelay ?? 0;
    },
    screenTail() {
      if (boot > 0) { boot--; return [[{ t: 'Welcome to Claude Code' }]]; }
      if (pending && draw-- <= 0) { composer += pending; pending = ''; }
      return [rule, [{ t: `❯ ${composer}` }], rule];
    },
  };
  return { target, writes, composer: () => composer };
}
const now = () => Promise.resolve();

describe('typeAndSubmit', () => {
  it('types, waits for the text to show, Enter — the composer empties', async () => {
    const p = pane({ onCr: 'send', drawDelay: 3 });
    const r = await typeAndSubmit(p.target, '안녕', { submit: 'cr', agent: 'claude', sleep: now });
    expect(r).toEqual({ submitted: true, retried: false, waitedMs: 0 });
    expect(p.writes).toEqual(['안녕', '\r']);
  });

  it('a draft left in the composer goes out with the text: empty afterwards is submitted, not stuck', async () => {
    const p = pane({ onCr: 'send', draft: '쓰다 만 ' });
    const r = await typeAndSubmit(p.target, '글', { submit: 'cr', agent: 'claude', sleep: now });
    expect(r).toEqual({ submitted: true, retried: false, waitedMs: 0 });
    expect(p.writes).toEqual(['글', '\r']);
  });

  it('a CR taken as a pasted newline: ends the paste and presses Enter again (w-alerts, 10-28)', async () => {
    const p = pane({ onCr: 'newline' });
    const r = await typeAndSubmit(p.target, '첫 지시', { submit: 'cr', agent: 'claude', sleep: now });
    expect(r.submitted).toBe(true);
    expect(r.retried).toBe(true);
    expect(p.writes).toEqual(['첫 지시', '\r', '\x1b[201~', '\r']);
    expect(p.composer()).toBe('');
  });

  it('still there after the retry: false, so the caller can say so', async () => {
    const p = pane({ onCr: 'never' });
    const r = await typeAndSubmit(p.target, 'x', { submit: 'cr', agent: 'claude', sleep: now });
    expect(r).toMatchObject({ submitted: false, retried: true });
  });

  it('a pane still booting: waits for the composer before typing', async () => {
    const p = pane({ onCr: 'send', bootPolls: 5 });
    const r = await typeAndSubmit(p.target, 'go', { submit: 'cr', agent: 'claude', sleep: now });
    expect(r.waitedMs).toBe(250);
    expect(r.submitted).toBe(true);
  });

  it('no composer ever: types anyway after readyMs, nothing to judge', async () => {
    const p = pane({ onCr: 'send', bootPolls: 1_000 });
    const r = await typeAndSubmit(p.target, 'go', { submit: 'cr', agent: 'claude', readyMs: 500, sleep: now });
    expect(r).toEqual({ submitted: null, retried: false, waitedMs: 500 });
    expect(p.writes).toEqual(['go', '\r']);
  });

  it('long text goes in 512-byte pieces', async () => {
    const p = pane({ onCr: 'send' });
    await typeAndSubmit(p.target, 'a'.repeat(1300), { submit: 'cr', agent: 'claude', sleep: now });
    expect(p.writes.map((w) => w.length)).toEqual([512, 512, 276, 1]);
  });

  it('a shell: text and LF in one go, nothing watched', async () => {
    const p = pane({ onCr: 'send' });
    const r = await typeAndSubmit(p.target, 'echo hi', { submit: 'lf', agent: null, sleep: now });
    expect(r.submitted).toBeNull();
    expect(p.writes).toEqual(['echo hi', '\n']);
  });

  it('a sleeping pane (blind): CR without watching the frozen screen', async () => {
    const p = pane({ onCr: 'never' });
    const r = await typeAndSubmit(p.target, 'wake', { submit: 'cr', agent: 'claude', blind: true, sleep: now });
    expect(r).toEqual({ submitted: null, retried: false, waitedMs: 0 });
    expect(p.writes).toEqual(['wake', '\r']);
  });
});
