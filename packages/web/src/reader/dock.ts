import type { ReaderAgent } from '@ttym/api';

/**
 * Where the agent's input area starts on the terminal screen.
 *
 * Reader mode covers the top of the real terminal with the page and leaves the
 * bottom rows uncovered, so that the agent's own prompt (or its permission
 * dialog) is what you type into. Which rows those are depends on how the agent
 * draws itself; a profile per agent answers that from the rows' text. An agent
 * with no profile gets a fixed number of rows, which is wrong only in how much
 * of the terminal shows, never in what a keystroke does.
 */

/** The visible terminal rows as plain text, top to bottom. */
export type ScreenRows = readonly string[];

/** What the input area says, as data, for drawing it in the page's own style. */
export type DockView =
  | {
      kind: 'prompt';
      /** What has been typed so far, one entry per line. */
      lines: string[];
      /** Caret in `lines`; `col` counts terminal cells, not characters. */
      caret: { line: number; col: number } | null;
      /** The agent's own status rows under the prompt, each split at its wide gaps. */
      status: string[][];
    }
  | {
      kind: 'dialog';
      title: string;
      detail: string[];
      question: string;
      options: { n: number; label: string; selected: boolean }[];
      hint: string;
    };

export interface DockProfile {
  /** Index of the first row of the input area, or null when it cannot be found. */
  top(rows: ScreenRows, waiting: boolean, caretRow?: number): number | null;
  /**
   * The input area (from `top` down) read as a DockView, or null when its layout isn't recognised,
   * in which case the page shows the real rows instead. `caret` is relative to `rows`.
   */
  view?(rows: ScreenRows, caret: { x: number; y: number } | null, waiting: boolean): DockView | null;
  /**
   * Whether the screen says the agent is mid-turn, or null when it can't tell.
   * The agent's own "active" flag is set by a hook and cleared by another; a turn that ends
   * some other way (the person pressed Esc before the first token) never clears it.
   */
  busy?(rows: ScreenRows, cols: number): boolean | null;
}

/** Rows to leave uncovered when the screen can't be read. */
export const FALLBACK_DOCK_ROWS = 6;

const RULE_CHARS = /[─━═]/;

/**
 * A horizontal rule: a long run of line-drawing characters. Claude Code puts the
 * session's name into the prompt's top rule ("──────── my-session ─"), so the
 * run may be followed by a short title and one more dash.
 */
const isRule = (row: string): boolean => {
  const t = row.trim();
  if (t.length < 8 || /[╭╮╰╯┌┐└┘│]/.test(t)) return false; // a box edge is not a rule
  let lead = 0;
  while (lead < t.length && RULE_CHARS.test(t[lead])) lead++;
  if (lead < 8) return false;
  if (lead === t.length) return true;
  if (!RULE_CHARS.test(t[t.length - 1])) return false;
  let heavy = 0;
  for (const c of t) if (RULE_CHARS.test(c)) heavy++;
  return heavy / t.length >= 0.4;
};

const isBoxTop = (row: string): boolean => /^\s*[╭┌]/.test(row);

/**
 * Claude Code draws its prompt between two horizontal rules, with a status line
 * below:
 *
 *     ──────────────      ← top rule
 *     ❯ the prompt
 *     ──────────────      ← bottom rule
 *       ⏵⏵ bypass permissions on …
 *
 * A permission dialog takes the prompt's place and starts at a rule (or the top
 * edge of a box) of its own, so while the agent is waiting the last such row
 * from the bottom is the top.
 */
const claude: DockProfile = {
  // Claude Code prints "esc to interrupt" in its spinner and status rows for exactly as long as a turn runs.
  // On a narrow screen those rows are cut short and the phrase may be gone, so it proves nothing there.
  busy(rows, cols) {
    if (cols < 70) return null;
    return rows.slice(-8).some((r) => /esc to interr/i.test(r));
  },
  view: (rows, caret, waiting) => claudeView(rows, caret, waiting), // defined below
  top(rows, waiting, caretRow) {
    const rules: number[] = [];
    rows.forEach((row, i) => { if (isRule(row)) rules.push(i); });

    if (waiting) {
      let top: number | null = rules.length ? rules[rules.length - 1] : null;
      rows.forEach((row, i) => { if (isBoxTop(row) && (top === null || i > top)) top = i; });
      return top;
    }

    // While the prompt is idle the cursor sits inside it, between its two rules, however much the agent
    // draws below (a command menu, a list of background agents): the rule just above the cursor starts it.
    if (caretRow !== undefined) {
      const above = rules.filter((i) => i < caretRow).pop();
      if (above !== undefined && rules.some((i) => i > caretRow) && caretRow - above <= 12) return above;
    }

    const last = rules[rules.length - 1];
    if (last === undefined) return null;
    const below = rows.length - 1 - last;
    if (below > 4) return null; // that rule is scrollback, not the prompt's
    const prev = rules[rules.length - 2];
    // The prompt can be several lines tall, but not a screenful.
    if (prev !== undefined && last - prev >= 2 && last - prev <= 12) return prev;
    return last;
  },
};

const OPTION = /^\s*(❯|>)?\s*(\d+)\.\s+(.*?)\s*$/;
const SEPARATOR = /^[\s─━═╌╍┄┈-]{6,}$/;

const claudeView = (rows: ScreenRows, caret: { x: number; y: number } | null, waiting: boolean): DockView | null => {
  if (rows.length < 2 || !isRule(rows[0])) return null;
  if (waiting) return claudeDialog(rows);

  let bottom = -1;
  for (let i = rows.length - 1; i > 0; i--) if (isRule(rows[i])) { bottom = i; break; }
  if (bottom < 0) return null;

  // Every prompt line carries a two-cell gutter: "❯ " on the first, spaces after.
  // The gutter's second cell is a no-break space on the prompt row ("❯\u00a0"), an ordinary space on the rows below.
  const lines = rows.slice(1, bottom).map((r) => r.replace(/^(❯|>)?[ \u00a0]?/, '').replace(/^ /, '').trimEnd());
  while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const line = caret ? caret.y - 1 : -1;
  return {
    kind: 'prompt',
    lines,
    caret: caret && line >= 0 && line < lines.length ? { line, col: Math.max(0, caret.x - 2) } : null,
    status: rows.slice(bottom + 1).filter((r) => r.trim()).map((r) => r.trim().split(/\s{3,}/)),
  };
};

const claudeDialog = (rows: ScreenRows): DockView | null => {
  const first = rows.findIndex((r) => OPTION.test(r));
  if (first < 0) return null;
  const options: { n: number; label: string; selected: boolean }[] = [];
  let i = first;
  for (; i < rows.length; i++) {
    const m = OPTION.exec(rows[i]);
    if (!m) break;
    options.push({ n: Number(m[2]), label: m[3], selected: !!m[1] });
  }
  const before = rows.slice(1, first).filter((r) => r.trim() && !SEPARATOR.test(r)).map((r) => r.trimEnd());
  const question = before.pop() ?? '';
  const hint = rows.slice(i).map((r) => r.trim()).filter(Boolean).pop() ?? '';
  return { kind: 'dialog', title: (before.shift() ?? '').trim(), detail: before, question: question.trim(), options, hint };
};

const PROFILES: Partial<Record<ReaderAgent, DockProfile>> = {
  'claude-code': claude,
};

/**
 * The rows down to the last one with anything on it. A screen only partly
 * filled has its prompt well above the bottom edge, so "the bottom rows" must
 * mean the bottom of what is drawn, not of the screen.
 */
export function contentRows(rows: ScreenRows): ScreenRows {
  let end = rows.length;
  while (end > 0 && rows[end - 1].trim() === '') end--;
  return rows.slice(0, end);
}

/** Number of terminal rows, counted from the bottom of `rows`, that the page leaves uncovered. Pass `contentRows(...)`. */
/** `caretRow`: the terminal cursor's row in `rows`, which pins down an idle prompt wherever it is on the screen. */
export function dockRowCount(agent: ReaderAgent | null, rows: ScreenRows, waiting: boolean, caretRow?: number): number {
  const profile = agent ? PROFILES[agent] : undefined;
  const top = profile?.top(rows, waiting, caretRow) ?? null;
  if (top === null) return Math.min(FALLBACK_DOCK_ROWS, rows.length);
  return rows.length - top;
}

/** The input area as data, or null when this agent has no reader for it or its layout isn't recognised. */
export function dockView(agent: ReaderAgent | null, rows: ScreenRows, caret: { x: number; y: number } | null, waiting: boolean): DockView | null {
  const profile = agent ? PROFILES[agent] : undefined;
  return profile?.view?.(rows, caret, waiting) ?? null;
}

/** Whether the agent is mid-turn according to what is on screen; null when this agent's screen can't say. Pass `contentRows(...)`. */
export function dockBusy(agent: ReaderAgent | null, rows: ScreenRows, cols: number): boolean | null {
  const profile = agent ? PROFILES[agent] : undefined;
  return profile?.busy?.(rows, cols) ?? null;
}
