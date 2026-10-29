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
      /** Text the agent draws in an empty prompt as a hint (Codex does); `lines` is then empty and this is shown dim. */
      placeholder?: string;
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
 * run may be followed by a title and one more dash.
 */
const isRule = (row: string): boolean => {
  const t = row.trim();
  if (t.length < 8 || /[╭╮╰╯┌┐└┘│]/.test(t)) return false; // a box edge is not a rule
  let lead = 0;
  while (lead < t.length && RULE_CHARS.test(t[lead])) lead++;
  if (lead < 8) return false;
  if (lead === t.length) return true;
  // "<rule> title ─": the title is set off by spaces and closed by one more dash, however long the title is
  // (a long session name, in wide characters, is most of the row).
  return RULE_CHARS.test(t[t.length - 1]) && t[t.length - 2] === ' ';
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
    // More than the status line under the last rule: scrollback — unless that rule closes a pair whose
    // first row is the prompt ("❯ "), with a list drawn under it (background agents, "✔ Update installed").
    // That is what a reader without the cursor (the tail API) has to go by.
    if (below > 4) {
      for (let k = rules.length - 1; k > 0; k--) {
        const lo = rules[k - 1]!, hi = rules[k]!;
        if (hi - lo >= 2 && hi - lo <= 12 && /^\s*❯(\s|$)/.test(rows[lo + 1] ?? '')) return lo;
      }
      return null;
    }
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

// ───── numbered dialogs (Codex, Antigravity) ─────

const NUMBERED = /^\s*[›>❯]?\s*(\d+)\.\s+(.*?)\s*$/;

/**
 * A dialog that lists its answers as "1. …", "2. …" (the number key picks one in both agents). `rows` start at the
 * dialog's first row. What stands before the first answer is its title, detail and question; what stands after the last is its hint.
 */
function numberedDialog(rows: ScreenRows): DockView | null {
  const first = rows.findIndex((r) => NUMBERED.test(r));
  if (first < 0) return null;
  const options: { n: number; label: string; selected: boolean }[] = [];
  let i = first;
  for (; i < rows.length; i++) {
    const m = NUMBERED.exec(rows[i]);
    if (m) { options.push({ n: Number(m[1]), label: m[2], selected: /^\s*[›>❯]/.test(rows[i]) }); continue; }
    // A label that wrapped continues on the next row, which is not another answer and not blank.
    if (rows[i].trim() === '' || options.length === 0) break;
    if (/(Navigate|Press enter|esc to|enter to)/i.test(rows[i])) break;
    options[options.length - 1].label += ` ${rows[i].trim()}`;
  }
  const before = rows.slice(0, first).filter((r) => r.trim() && !SEPARATOR.test(r)).map((r) => r.trim());
  // The hint can wrap onto more rows when the terminal is narrow.
  const hint = rows.slice(i).map((r) => r.trim()).filter(Boolean).join(' ');
  let title = '';
  let question = '';
  let detail = before;
  if (before.length > 0 && before[0].endsWith('?')) {
    // Codex asks first and gives its detail after; the page lists detail before the question, so the ask stands as the title.
    title = before[0];
    detail = before.slice(1);
  } else {
    title = before[0] ?? '';
    detail = before.slice(1);
    const q = detail.map((r, k) => [r, k] as const).filter(([r]) => r.endsWith('?')).pop();
    if (q) { question = q[0]; detail = detail.filter((_, k) => k !== q[1]); }
  }
  return { kind: 'dialog', title, detail, question, options, hint };
}

const lastIndex = (rows: ScreenRows, test: (row: string) => boolean): number => {
  for (let i = rows.length - 1; i >= 0; i--) if (test(rows[i])) return i;
  return -1;
};

/**
 * Codex draws no rules. Its prompt is a row starting with "›" (the answers of a dialog start with it too, but
 * numbered), a blank row, and two status rows; a dialog replaces all of that from its question down.
 * What was typed wraps onto indented rows.
 */
const CODEX_PROMPT = /^›(?:\s+(?!\d+\.\s)|$)/;
const CODEX_QUESTION = /^\s*(Would you like to|Do you want to|Allow |Update available|Background server has)/;

const codexDialogTop = (rows: ScreenRows): number | null => {
  const q = lastIndex(rows, (r) => CODEX_QUESTION.test(r));
  if (q < 0 || rows.length - q > 40) return null;
  return rows.slice(q).some((r) => NUMBERED.test(r)) ? q : null;
};

const codex: DockProfile = {
  top(rows, _waiting, caretRow) {
    const dialog = codexDialogTop(rows);
    if (dialog !== null) return dialog;
    let from = caretRow !== undefined && caretRow < rows.length ? caretRow : rows.length - 1;
    for (; from >= 0; from--) if (CODEX_PROMPT.test(rows[from])) return from;
    return null;
  },
  busy(rows) {
    const tail = rows.slice(-14);
    if (tail.some((r) => /esc to interrupt/i.test(r))) return true;
    return tail.some((r) => CODEX_PROMPT.test(r)) ? false : null;
  },
  view(rows, caret) {
    if (rows.length === 0) return null;
    if (codexDialogTop(rows) === 0) return numberedDialog(rows);
    if (!CODEX_PROMPT.test(rows[0])) return null;
    const lines: string[] = [];
    let i = 0;
    for (; i < rows.length; i++) {
      if (i > 0 && rows[i].trim() === '') break;
      lines.push(i === 0 ? rows[0].replace(/^›\s?/, '') : rows[i].replace(/^ {1,2}/, '').trimEnd());
    }
    const status = rows.slice(i).filter((r) => r.trim()).map((r) => r.trim().split(/\s{3,}/));
    const empty = caret !== null && caret.y === 0 && caret.x <= 2 && lines.length === 1 && lines[0].trim() !== '';
    const line = caret ? caret.y : -1;
    const base = { kind: 'prompt' as const, status };
    const shown = empty ? [''] : lines;
    return {
      ...base,
      lines: shown,
      caret: caret && line >= 0 && line < shown.length ? { line, col: Math.max(0, caret.x - 2) } : null,
      ...(empty ? { placeholder: lines[0].trim() } : {}),
    };
  },
};

/**
 * Antigravity CLI draws its prompt as Claude Code does: a rule, a "> " row, a rule and a status row ("? for
 * shortcuts" when idle, "esc to cancel" while it works). Its permission dialog has no rule of its own to start
 * at but sits under one, and the agent leaves nothing in meta saying it is waiting, so the dialog is found by its words.
 */
const AGY_DIALOG = /^\s*(Requesting permission for:|Accessing workspace:)/;

const agyDialogTop = (rows: ScreenRows): number | null => {
  const d = lastIndex(rows, (r) => AGY_DIALOG.test(r));
  if (d < 0 || rows.length - d > 40) return null;
  // A prompt (its rules) drawn after the words means the dialog was answered and this is history.
  if (rows.slice(d).some(isRule)) return null;
  let k = d - 1;
  while (k >= 0 && rows[k].trim() === '') k--;
  return k >= 0 && isRule(rows[k]) ? k : d;
};

const agy: DockProfile = {
  top(rows, _waiting, caretRow) {
    return agyDialogTop(rows) ?? claude.top(rows, false, caretRow);
  },
  busy(rows) {
    if (agyDialogTop(rows) !== null) return null;
    const tail = rows.slice(-3);
    if (tail.some((r) => /esc to cancel/i.test(r))) return true;
    return tail.some((r) => /\? for shortcuts/.test(r)) ? false : null;
  },
  view(rows, caret) {
    // The last row of a dialog's screen is the agent's status row ("esc to cancel", the model), not part of the dialog.
    if (agyDialogTop(rows) === 0) return numberedDialog(/esc to cancel/i.test(rows[rows.length - 1] ?? '') ? rows.slice(0, -1) : rows);
    return claudeView(rows, caret, false);
  },
};

const PROFILES: Partial<Record<ReaderAgent, DockProfile>> = {
  'claude-code': claude,
  codex,
  agy,
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
