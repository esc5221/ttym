import { describe, expect, it } from 'vitest';
import { FALLBACK_DOCK_ROWS, contentRows, dockRowCount, dockView } from './dock.js';

const RULE = '─'.repeat(100);
/** A 20-row screen: some output, then the given bottom rows. */
const screen = (bottom: string[], total = 20) => [...Array.from({ length: total - bottom.length }, (_, i) => `output line ${i}`), ...bottom];

describe('dockRowCount · claude-code', () => {
  it('covers everything above the prompt’s top rule when idle', () => {
    const rows = screen([RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)']);
    expect(dockRowCount('claude-code', rows, false)).toBe(4);
  });

  it('grows with a prompt that is several lines tall', () => {
    const rows = screen([RULE, '❯ first line', '  second line', '  third line', RULE, '  ⏵⏵ bypass permissions on']);
    expect(dockRowCount('claude-code', rows, false)).toBe(6);
  });

  it('ignores an older rule sitting in the scrollback', () => {
    const rows = screen([RULE, 'assistant text', 'more text', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', RULE, '❯ ', RULE, '  status']);
    expect(dockRowCount('claude-code', rows, false)).toBe(4);
  });

  it('starts at the dialog’s own rule while the agent is waiting', () => {
    const rows = screen([RULE, ' Bash command', '', '   pnpm build', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, and don’t ask again', '   3. No']);
    expect(dockRowCount('claude-code', rows, true)).toBe(9);
  });

  it('starts at the top edge of a boxed dialog', () => {
    const rows = screen(['╭────────────────────╮', '│ Do you want to proceed? │', '│ ❯ 1. Yes │', '╰────────────────────╯']);
    expect(dockRowCount('claude-code', rows, true)).toBe(4);
  });

  it('falls back to a fixed number of rows when no rule is on screen', () => {
    expect(dockRowCount('claude-code', screen(['just text']), false)).toBe(FALLBACK_DOCK_ROWS);
  });

  it('never claims more rows than the screen has', () => {
    expect(dockRowCount('claude-code', ['a', 'b', 'c'], false)).toBe(3);
  });
});

describe('dockRowCount · agents without a profile', () => {
  it('uses the fixed fallback for codex and for no agent', () => {
    const rows = screen([RULE, '❯ ', RULE, 'status']);
    expect(dockRowCount('codex', rows, false)).toBe(FALLBACK_DOCK_ROWS);
    expect(dockRowCount(null, rows, false)).toBe(FALLBACK_DOCK_ROWS);
  });
});

describe('contentRows', () => {
  it('drops the empty rows under the last thing drawn', () => {
    expect(contentRows(['a', 'b', '', '  ', ''])).toEqual(['a', 'b']);
    expect(contentRows(['', ''])).toEqual([]);
  });

  it('lets a prompt in the middle of a part-filled screen be found', () => {
    const rows = [...screen([RULE, '❯ ', RULE, '  status'], 10), ...Array(30).fill('')];
    expect(dockRowCount('claude-code', contentRows(rows), false)).toBe(4);
  });
});

describe('dockView · claude-code', () => {
  it('reads the typed text, the caret and the status rows of an idle prompt', () => {
    const rows = [RULE, '❯ hello wor', '  second', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)   ◐ medium · /effort'];
    const v = dockView('claude-code', rows, { x: 4, y: 2 }, false);
    expect(v).toEqual({
      kind: 'prompt',
      lines: ['hello wor', 'second'],
      caret: { line: 1, col: 2 },
      status: [['⏵⏵ bypass permissions on (shift+tab to cycle)', '◐ medium · /effort']],
    });
  });

  it('has no caret when the cursor is outside the prompt', () => {
    const v = dockView('claude-code', [RULE, '❯ ', RULE, 'status'], { x: 0, y: 3 }, false);
    expect(v).toMatchObject({ kind: 'prompt', lines: [''], caret: null });
  });

  it('reads a permission dialog into title, detail, question and numbered options', () => {
    const rows = [RULE, ' Bash command', ' Tip: use auto mode', '╌'.repeat(40), ' curl -sI https://example.com', '╌'.repeat(40), ' This command requires approval', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, and don’t ask again', '   3. No', '', ' Esc to cancel · Tab to amend'];
    expect(dockView('claude-code', rows, null, true)).toEqual({
      kind: 'dialog',
      title: 'Bash command',
      detail: [' Tip: use auto mode', ' curl -sI https://example.com', ' This command requires approval'],
      question: 'Do you want to proceed?',
      options: [{ n: 1, label: 'Yes', selected: true }, { n: 2, label: 'Yes, and don’t ask again', selected: false }, { n: 3, label: 'No', selected: false }],
      hint: 'Esc to cancel · Tab to amend',
    });
  });

  it('gives up on a dialog with no numbered options, and on agents without a reader', () => {
    expect(dockView('claude-code', [RULE, ' something else', ' entirely'], null, true)).toBeNull();
    expect(dockView('codex', [RULE, '❯ ', RULE], null, false)).toBeNull();
  });
});
