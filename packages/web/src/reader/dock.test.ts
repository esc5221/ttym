import { describe, expect, it } from 'vitest';
import { FALLBACK_DOCK_ROWS, contentRows, dockBusy, dockRowCount, dockView } from './dock.js';

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

describe('a prompt whose top rule carries the session name', () => {
  const TITLED = '─'.repeat(66) + ' claude-cli-browser-agent-plan ─';

  it('still finds the top rule, so the prompt is inside the uncovered rows', () => {
    const rows = screen([TITLED, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 7 agents']);
    expect(dockRowCount('claude-code', rows, false)).toBe(4);
    expect(dockView('claude-code', rows.slice(-4), { x: 2, y: 1 }, false)).toMatchObject({ kind: 'prompt', lines: [''] });
  });

  it('finds it when the name is long and in wide characters, so the dashes are under half of the row', () => {
    const long = '─'.repeat(27) + ' 그 파비콘이 다 똑같아서 별 의미가 없는느낌. 바꿔볼래? 진단. (Branch) ─';
    const rows = screen([long, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)']);
    expect(dockRowCount('claude-code', rows, false)).toBe(4);
  });

  it('does not take a line of prose that happens to start with dashes for a rule', () => {
    const rows = screen(['──────── is how it starts, then words, and no closing rule', '❯ ', RULE, 'status']);
    // only the real bottom rule counts, so the uncovered rows start there
    expect(dockRowCount('claude-code', rows, false)).toBe(2);
  });
});

describe('dockRowCount with the cursor', () => {
  it('finds a prompt that has a long list of agents drawn under it', () => {
    const bottom = [RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on', '', '  agents', '  · one', '  · two', '  · three', '  · four'];
    const rows = screen(bottom, 30);
    const caretRow = 30 - bottom.length + 1;
    expect(dockRowCount('claude-code', rows, false)).toBe(FALLBACK_DOCK_ROWS);
    expect(dockRowCount('claude-code', rows, false, caretRow)).toBe(bottom.length);
  });

  it('ignores a cursor that is not between two rules', () => {
    const rows = screen([RULE, '❯ ', RULE, 'status']);
    expect(dockRowCount('claude-code', rows, false, 3)).toBe(4);
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

  it('treats the no-break space after the prompt mark as part of the gutter', () => {
    const rows = [RULE, '❯\u00a0안녕 ', RULE, 'status'];
    expect(dockView('claude-code', rows, { x: 7, y: 1 }, false)).toMatchObject({ lines: ['안녕'], caret: { line: 0, col: 5 } });
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

describe('dockBusy · claude-code', () => {
  const idle = [...Array(10).fill('output'), '✻ Cooked for 4s · done', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on · 1 shell'];
  const running = [...Array(10).fill('output'), '✻ Brewing… (4s · esc to interrupt)', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on · esc to interrupt'];

  it('reads "esc to interrupt" as a running turn and its absence as an idle one', () => {
    expect(dockBusy('claude-code', running, 100)).toBe(true);
    expect(dockBusy('claude-code', idle, 100)).toBe(false);
  });

  it('does not guess on a narrow screen, or when no agent is known', () => {
    expect(dockBusy('claude-code', idle, 44)).toBeNull();
    expect(dockBusy(null, running, 100)).toBeNull();
  });
});

// Screens captured from the agents themselves (Codex 0.159, Antigravity CLI 1.3.5), widths as they came.
const RULE80 = '─'.repeat(80);

describe('antigravity', () => {
  const idle = screen(['some answer', '', RULE80, '>', RULE80, '? for shortcuts                                        Gemini 3.8 Flash · mediu']);
  const typed = screen(['', RULE80, '> fix the failing test in', '  src/a.ts', RULE80, '? for shortcuts                                        Gemini 3.8 Flash · mediu']);
  const busy = screen(['> Run the shell command', '⣟  Generating...', RULE80, '>', RULE80, 'esc to cancel                                          Gemini 3.8 Flash · mediu']);
  const dialog = screen([
    '● Ran (echo second-run)', '', 'Command', RULE80, '', 'Requesting permission for:', '   echo second-run && ls /private/tmp | head -3', '',
    'Run this command?', '> 1. Yes, run command', "  2. Yes, and always allow in this conversation for commands that start with", "'echo'",
    "  3. Yes, and always allow for commands that start with 'echo' (Persist to", 'settings.json)', '  4. No, cancel', '',
    '  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command', 'esc to cancel                                          Gemini 3.8 Flash · mediu',
  ]);

  it('finds the prompt between its rules, as it does for Claude Code', () => {
    expect(dockRowCount('agy', idle, false)).toBe(4);
    expect(dockView('agy', idle.slice(-4), { x: 2, y: 1 }, false)).toMatchObject({ kind: 'prompt', lines: [''], status: [['? for shortcuts', 'Gemini 3.8 Flash · mediu']] });
  });

  it('reads what is being typed, over several rows', () => {
    const n = dockRowCount('agy', typed, false);
    expect(n).toBe(5);
    expect(dockView('agy', typed.slice(-n), { x: 5, y: 2 }, false)).toMatchObject({ lines: ['fix the failing test in', 'src/a.ts'], caret: { line: 1, col: 3 } });
  });

  it('says a turn is running from the status row, and idle from its shortcuts hint', () => {
    expect(dockBusy('agy', contentRows(busy), 80)).toBe(true);
    expect(dockBusy('agy', contentRows(idle), 80)).toBe(false);
  });

  it('finds the permission dialog by its words, from the rule above it, and reads its answers', () => {
    const n = dockRowCount('agy', dialog, false);
    expect(n).toBe(15);
    const view = dockView('agy', dialog.slice(-n), null, false);
    expect(view).toMatchObject({
      kind: 'dialog', title: 'Requesting permission for:', detail: ['echo second-run && ls /private/tmp | head -3'], question: 'Run this command?',
      hint: '↑/↓ Navigate · tab Amend · ctrl+g edit/expand command',
    });
    expect(view).toMatchObject({ kind: 'dialog', options: [
      { n: 1, label: 'Yes, run command', selected: true },
      { n: 2, selected: false }, { n: 3, selected: false }, { n: 4, label: 'No, cancel', selected: false },
    ] });
    if (view?.kind === 'dialog') expect(view.options[1].label).toContain("start with 'echo'");
    expect(dockBusy('agy', contentRows(dialog), 80)).toBeNull();
  });

  it('treats a permission dialog that has been answered as history', () => {
    const answered = screen(['Requesting permission for:', '   ls', 'Run this command?', '> 1. Yes', '', RULE80, '>', RULE80, '? for shortcuts      Gemini']);
    expect(dockRowCount('agy', answered, false, 17)).toBe(4);
  });
});

describe('codex', () => {
  const STATUS = ['  GPT-6.1-Sol medium · /private/tmp', '  ? for shortcuts                                     ⚠ 2 warnings · f2 to view'];
  const idle = screen(['  >_ OpenAI Codex (v0.159.0)', '', '› Ask Codex to do anything', '', ...STATUS]);
  const typed = screen(['• earlier answer', '', '› Run this exact shell command: sleep 8;', '  touch /tmp/x; echo ok', '', ...STATUS]);
  const busy = screen(['› go', '', '◦ Working (3s • esc to interrupt)', '', '› Ask Codex to do anything', '', ...STATUS]);
  const dialog = screen([
    '› Run this exact shell command', '', '• Running sleep 8; touch /tmp/x', '', '  Would you like to run the following command?', '', '  Environment: local', '',
    '  Reason: The sandbox blocked creating the file. Allow the exact command to', '  run outside the sandbox?', '', '  $ sleep 8; touch /tmp/x; echo ok', '',
    '› 1. Yes, proceed (y)', "  2. Yes, and don't ask again for commands that start with `sleep 8` (p)", '  3. No, and tell Codex what to do differently (esc)', '', '  Press enter to confirm or esc to cancel',
  ]);

  it('starts at the prompt row and keeps the status rows under it', () => {
    expect(dockRowCount('codex', idle, false)).toBe(4);
    const view = dockView('codex', idle.slice(-4), { x: 2, y: 0 }, false);
    expect(view).toMatchObject({ kind: 'prompt', lines: [''], placeholder: 'Ask Codex to do anything', caret: { line: 0, col: 0 } });
    expect(view).toMatchObject({ status: [['GPT-6.1-Sol medium · /private/tmp'], ['? for shortcuts', '⚠ 2 warnings · f2 to view']] });
  });

  it('reads typed text that wrapped, and does not take it for the hint', () => {
    const n = dockRowCount('codex', typed, false, 17);
    expect(n).toBe(5);
    expect(dockView('codex', typed.slice(-n), { x: 16, y: 1 }, false)).toMatchObject({ lines: ['Run this exact shell command: sleep 8;', 'touch /tmp/x; echo ok'], caret: { line: 1, col: 14 } });
    expect(dockView('codex', typed.slice(-n), { x: 16, y: 1 }, false)).not.toHaveProperty('placeholder');
  });

  it('takes the prompt nearest above the cursor, not an earlier message that began with the same sign', () => {
    expect(dockRowCount('codex', busy, false, busy.length - 4)).toBe(4);
  });

  it('is busy while "esc to interrupt" shows', () => {
    expect(dockBusy('codex', contentRows(busy), 100)).toBe(true);
    expect(dockBusy('codex', contentRows(idle), 100)).toBe(false);
  });

  it('shows an approval dialog from its question down, with its numbered answers', () => {
    const n = dockRowCount('codex', dialog, false);
    expect(n).toBe(14);
    const view = dockView('codex', dialog.slice(-n), null, false);
    expect(view).toMatchObject({ kind: 'dialog', title: 'Would you like to run the following command?', hint: 'Press enter to confirm or esc to cancel' });
    if (view?.kind === 'dialog') {
      expect(view.options.map((o) => o.n)).toEqual([1, 2, 3]);
      expect(view.options[0]).toMatchObject({ label: 'Yes, proceed (y)', selected: true });
      expect(view.detail.some((d) => d.startsWith('$ sleep 8'))).toBe(true);
    }
  });
});
