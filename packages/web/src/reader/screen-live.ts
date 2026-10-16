/**
 * The message Claude Code is writing, read off the terminal it draws on.
 *
 * The agent's record has a message only once it is complete, but its terminal shows it row by row from the first
 * words (about every 200ms, a wrapped row at a time). reader mode sits on top of that same terminal, so the text
 * in flight is read from the xterm buffer instead of asked of the agent: no hook, no server, nothing sent.
 *
 * What the terminal draws is not markdown. Its text is not enough to tell a heading from a numbered list or a diagram
 * from a paragraph, but its attributes are: headings are bold rows, code is drawn in a colour of its own (and
 * at the left edge, where prose has a margin), `**bold**`, `*italic*` and `` `code` `` are drawn as such, a quote
 * starts with a bar, a table is drawn with box characters. This reads both and gives back markdown, so the preview
 * has the shape the record's copy will have when it replaces it.
 *
 * Written against Claude Code 2.1.301's layout; when a row is not recognised the answer is "no message" and
 * the page simply has no preview, as it had before.
 */

const DIVIDER = /^─{10,}/;
/** The spinner row ("✳ Tinkering… (11s · ↓ 1.5k tokens)") that sits between the transcript and the prompt box. */
const SPINNER = /^[✻✶✳✢✽·*]\s+\S/;
const PROMPT = /^❯/;
/** A tool's result row, and the "Interrupted" row after a turn is cut short; both end the message above them. */
const RESULT = /^\s*⎿/;
/**
 * A tool call, which is not the agent's words: `Bash(ls -l)`, `mcp__x__y(...)`, or the collapsed form of a
 * read-only call, "Listing 1 directory… (ctrl+o to expand)". While one runs its `⏺` blinks, so the row is
 * sometimes drawn without it and has to be recognised on its own.
 */
const TOOL_CALL = /^(?:Bash|Read|Edit|MultiEdit|Write|NotebookEdit|Grep|Glob|Task|Agent|WebFetch|WebSearch|TodoWrite|Skill|ToolSearch|mcp__[\w-]+)\(/;
const TOOL_COLLAPSED = /\(ctrl\+o to expand\)/;
const LIST_ITEM = /^(?:[-*•]|\d{1,9}[.)])\s/;
const NESTED_ITEM = /^\s+(?:[-*•]|\d{1,9}[.)])\s/;
/** A table the terminal drew from its text: cells apart by " | ", and the rule under the header. */
const TABLE_ROW = /\S\s+\|\s+\S/;
const TABLE_RULE = /^[-─]{3,}(?:[+┼|]\s?[-─]{3,})+\s*$/;
const BAR_ROW = /^\s*\|/;
const TABLE_RULE_BARS = /^\|[\s:|-]+\|$/;
const CODE_ROW = /^ {4,}\S/;
const HR = /^(?:-{3,}|\*{3,}|_{3,})$/;

/** A stretch of a row drawn in one style. A row's runs, put together, are its text. */
export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
  /** A chromatic foreground: what code (and inline code) is drawn in. */
  code?: boolean;
  /** A palette foreground: what syntax highlighting uses, and nothing in prose does. */
  syntax?: boolean;
}
interface Drawn { text: string; runs?: readonly Run[] }

export interface ScreenMessage {
  /** Index in `rows` of the row that opens the message. */
  start: number;
  /** The agent is still writing: its spinner row ("✳ Tinkering…", with the ellipsis) is on screen. False once it says "done". */
  streaming: boolean;
  /** The message as markdown. Empty until the first words are drawn. */
  text: string;
}

const isToolRow = (body: string) => TOOL_CALL.test(body) || TOOL_COLLAPSED.test(body);

/**
 * Whether the last thing the agent drew above its prompt is words (and not a tool call), and what they are so far.
 * `runsOf(i)` gives the styles of row `i`; without it the rows are read as plain text.
 */
export function screenMessage(rows: readonly string[], runsOf?: (i: number) => readonly Run[]): ScreenMessage | null {
  let start = -1;
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.startsWith('⏺')) { start = i; break; }
  if (start < 0) return null;
  const headText = rows[start]!.slice(1).replace(/^\s+/, '');
  if (isToolRow(headText)) return null;

  const body: Drawn[] = [drop({ text: rows[start]!, runs: runsOf?.(start) }, rows[start]!.length - headText.length)];
  let streaming = false;
  for (let i = start + 1; i < rows.length; i++) {
    const r = rows[i]!;
    if (SPINNER.test(r)) { streaming = r.includes('…'); break; }
    if (DIVIDER.test(r) || PROMPT.test(r) || RESULT.test(r)) break;
    if (isToolRow(r.replace(/^ {1,2}/, ''))) break; // a call whose marker is between blinks
    body.push({ text: r.replace(/\s+$/, ''), runs: runsOf?.(i) });
  }
  while (body.length && !body[body.length - 1]!.text.trim()) body.pop();
  return { start, streaming, text: toMarkdown(body) };
}

// ───── rows with styles ─────

/** The row without its first `n` characters. */
function drop(d: Drawn, n: number): Drawn {
  if (n <= 0) return d;
  const text = d.text.slice(n);
  if (!d.runs) return { text };
  const runs: Run[] = [];
  let skip = n;
  for (const r of d.runs) {
    if (skip >= r.text.length) { skip -= r.text.length; continue; }
    runs.push(skip ? { ...r, text: r.text.slice(skip) } : r);
    skip = 0;
  }
  return { text, runs };
}

/** The row with one style taken off its runs (a quote is all italic, which says "quote", not "emphasis"). */
function plain(d: Drawn, key: 'italic' | 'bold'): Drawn {
  return d.runs ? { text: d.text, runs: d.runs.map((r) => ({ ...r, [key]: false })) } : d;
}

const leadOf = (d: Drawn) => /^ */.exec(d.text)![0].length;
const inkOf = (d: Drawn) => d.text.replace(/\s/g, '').length;

const hasSyntax = (d: Drawn) => !!d.runs?.some((r) => r.syntax && r.text.trim());
/** A row that is one or two words drawn dim: the language name the terminal puts above a block it cannot colour. */
const isLabel = (d: Drawn) => !!d.runs?.length && d.runs.every((r) => !r.text.trim() || r.dim) && /^\s*\S+(?:\s+\S+)?\s*$/.test(d.text);

/** How much of a row's ink (its characters that are not spaces) is drawn bold, or in the code colour. */
function share(d: Drawn, key: 'bold' | 'code'): number {
  if (!d.runs) return 0;
  let all = 0;
  let hit = 0;
  for (const r of d.runs) {
    const n = r.text.replace(/\s/g, '').length;
    all += n;
    if (r[key]) hit += n;
  }
  return all ? hit / all : 0;
}

/** The row as markdown, with the bold, italic and code the terminal drew marked as such. */
function inline(d: Drawn): string {
  if (!d.runs) return d.text.trim();
  // Runs of one style are one span, so a word-by-word drawing does not become `**a** **b**`.
  const merged: Run[] = [];
  for (const r of d.runs) {
    const last = merged[merged.length - 1];
    if (last && !!last.bold === !!r.bold && !!last.italic === !!r.italic && !!last.code === !!r.code) last.text += r.text;
    else merged.push({ ...r });
  }
  let out = '';
  for (const r of merged) {
    const core = r.text.trim();
    if (!core || (!r.bold && !r.italic && !r.code)) { out += r.text; continue; }
    const lead = r.text.slice(0, r.text.length - r.text.trimStart().length);
    const tail = r.text.slice(r.text.trimEnd().length);
    const open = r.code ? '`' : (r.bold ? '**' : '') + (r.italic ? '*' : '');
    const close = r.code ? '`' : (r.italic ? '*' : '') + (r.bold ? '**' : '');
    out += `${lead}${open}${core}${close}${tail}`;
  }
  return out.trim();
}

// ───── rows to markdown ─────

/** One piece of the message, with enough about it to join it to its neighbours. `rows`: what a block that is still being assembled holds. */
interface Block { kind: 'p' | 'li' | 'pre' | 'other'; md: string; rows: string[] }

/**
 * The drawn rows as markdown. A blank row ends a block. What a block is comes from how it was drawn: all-bold rows
 * are a heading, rows in the code colour are code (kept as they are, in a fence), a bar in front is a quote, box
 * characters are a table. Everything else is prose: a paragraph the terminal wrapped is several rows that continue
 * each other, and a list item may wrap too. A fence is left open at the end of the text, so the text only ever
 * grows at its end: what an earlier frame produced is a prefix of what the next one does.
 *
 * Rows given as plain strings carry no styles, and are read by their shape alone (indented rows are code, rows
 * with bars and a rule under them are a table).
 */
export function toMarkdown(rows: readonly (string | Drawn)[]): string {
  const drawn: Drawn[] = rows.map((r) => (typeof r === 'string' ? { text: r } : r));
  const blocks: Block[] = [];

  // Segments: runs of rows with no blank row between them.
  let seg: Drawn[] = [];
  const segments: Drawn[][] = [];
  for (const d of drawn) {
    if (!d.text.trim()) { if (seg.length) segments.push(seg); seg = []; } else seg.push(d);
  }
  if (seg.length) segments.push(seg);

  for (const s of segments) {
    const ink = s.reduce((n, d) => n + inkOf(d), 0);
    const weighted = (key: 'bold' | 'code') => (ink ? s.reduce((n, d) => n + share(d, key) * inkOf(d), 0) / ink : 0);

    if (s.length > 1 && isLabel(s[0]!)) { blocks.push(codeBlock(s.slice(1).map((d) => d.text), s[0]!.text.trim())); continue; }
    if (s.some(hasSyntax) || weighted('code') >= 0.3) { blocks.push(codeBlock(s.map((d) => d.text))); continue; }
    if (weighted('bold') >= 0.9) {
      const lead = s[0]!.runs?.find((r) => r.text.trim());
      blocks.push({ kind: 'other', md: `${lead?.underline && lead.italic ? '#' : '##'} ${s.map((d) => d.text.trim()).join(' ').replace(/\s+/g, ' ')}`, rows: [] });
      continue;
    }
    // The 2-column margin prose is drawn with (code and headings start at the edge).
    const stripped = s.map((d) => drop(d, Math.min(2, leadOf(d))));
    if (stripped.every((d) => d.text.startsWith('▎'))) {
      blocks.push({ kind: 'other', md: stripped.map((d) => '> ' + inline(plain(drop(d, 1), 'italic'))).join('\n'), rows: [] });
      continue;
    }
    const first = stripped[0]!.text;
    if (stripped.length === 1 && HR.test(first.trim())) { blocks.push({ kind: 'other', md: '---', rows: [] }); continue; }
    if (/^[┌│]/.test(first) && stripped.some((d) => /^[├└]/.test(d.text))) {
      const table = boxTable(stripped.map((d) => d.text));
      if (table) { blocks.push({ kind: 'other', md: table, rows: [] }); continue; }
    }
    // A paragraph that goes on under a list item, after a blank row, is drawn indented: it belongs to the list.
    const prev = blocks[blocks.length - 1];
    if (prev?.kind === 'li' && leadOf(stripped[0]!) >= 2 && !LIST_ITEM.test(first.trim()) && !NESTED_ITEM.test(first)) {
      // Its rows are the paragraph, up to the next item, which is drawn at the margin with its number or bullet.
      const at = stripped.findIndex((d, k) => k > 0 && (LIST_ITEM.test(d.text) || NESTED_ITEM.test(d.text)));
      const own = at < 0 ? stripped : stripped.slice(0, at);
      prev.md += '\n\n   ' + own.map(inline).join(' ');
      if (at >= 0) blocks.push(...prose(stripped.slice(at)));
      continue;
    }
    blocks.push(...prose(stripped));
  }

  // The last block may still be growing: a code fence stays open, so earlier text is always a prefix of later text.
  return blocks.map((b, i) => (b.kind === 'pre' && i === blocks.length - 1 ? b.md.replace(/\n```$/, '') : b.md)).join('\n\n');
}

function codeBlock(texts: string[], info = ''): Block {
  const indent = Math.min(...texts.map((r) => /^ */.exec(r)![0].length));
  return { kind: 'pre', md: '```' + info + '\n' + texts.map((r) => r.slice(indent)).join('\n') + '\n```', rows: [] };
}

/**
 * A table the terminal drew with box characters, as a markdown table; null if it is not one. Every body row is
 * set off by a rule line, so what lies between two rules is one row, and a cell that wrapped has its text on
 * several of the rows between them. Without rules between the body rows, each row is its own.
 */
function boxTable(rows: string[]): string | null {
  const ruled = rows.filter((r) => r.trim().startsWith('├')).length >= 2;
  const logical: string[][] = [];
  let cur: string[] | null = null;
  for (const r of rows) {
    const t = r.trim();
    if (/^[┌├└]/.test(t)) { cur = null; continue; }
    if (!t.startsWith('│')) return null;
    const cells = t.replace(/^│/, '').replace(/│\s*$/, '').split('│').map((c) => c.trim());
    if (ruled && cur) cells.forEach((c, i) => { if (c) cur![i] = ((cur![i] ?? '') + ' ' + c).trim(); });
    else { cur = cells; logical.push(cur); }
  }
  if (!logical.length) return null;
  const line = (cells: string[]) => '| ' + cells.join(' | ') + ' |';
  return [line(logical[0]!), '| ' + logical[0]!.map(() => '---').join(' | ') + ' |', ...logical.slice(1).map(line)].join('\n');
}

/** Paragraphs, list items (nested ones keep their indent), and the odd table drawn from markdown, in rows with no special style. */
function prose(rows: Drawn[]): Block[] {
  const blocks: Block[] = [];
  let cur: Block | undefined;
  let inTable = false;
  const flush = () => { if (cur) blocks.push(cur); cur = undefined; };
  const start = (kind: Block['kind']): Block => { flush(); cur = { kind, md: '', rows: [] }; return cur; };
  const pre = () => (cur?.kind === 'pre' ? cur : undefined);

  for (let i = 0; i < rows.length; i++) {
    const d = rows[i]!;
    const row = d.text;
    const rule = TABLE_RULE.test(row.trim());
    // A row with a bar in it is prose ("ls /tmp | head") unless the rule of a table is drawn right under it.
    const barRow = BAR_ROW.test(row) || (TABLE_ROW.test(row) && TABLE_RULE.test((rows[i + 1]?.text ?? '').trim()));
    const item = LIST_ITEM.test(row) || (NESTED_ITEM.test(row) && cur?.kind === 'li');

    if (rule || barRow || (inTable && TABLE_ROW.test(row))) {
      const b = pre() ?? start('pre');
      if (unfinished(b.rows)) b.rows[b.rows.length - 1] += ' ' + row.trim();
      else b.rows.push(row);
      inTable = true;
    } else if (inTable && !item) {
      // The rest of a table row that was too long for the width: it wrapped back to the margin.
      const b = pre()!;
      if (unfinished(b.rows)) b.rows[b.rows.length - 1] += ' ' + row.trim();
      else b.rows.push(row);
    } else if (item) {
      inTable = false;
      const b = cur?.kind === 'li' ? cur : start('li');
      const lead = leadOf(d);
      b.md += (b.md ? '\n' : '') + ' '.repeat(lead) + inline(drop(d, lead));
    } else if (cur?.kind === 'li') {
      cur.md += ' ' + inline(d); // an item that wrapped
    } else if (CODE_ROW.test(row)) {
      const b = pre() ?? start('pre');
      b.rows.push(row);
    } else if (cur?.kind === 'pre') {
      cur.rows[cur.rows.length - 1] += ' ' + row.trim(); // code that wrapped
    } else if (cur?.kind === 'p') {
      cur.md += ' ' + inline(d);
    } else {
      start('p').md = inline(d);
    }
  }
  flush();
  return blocks.map((b) => (b.kind === 'pre' ? codeBlock(b.rows) : b));
}

/**
 * Whether the last row of a table drawn as markdown is cut short by the wrap. Every row has as many bars as the rule
 * under the header (`|---|---|`), so a row with fewer is continued by the next, whatever that starts with; before the
 * rule is drawn, a row that does not end with a bar is.
 */
function unfinished(rows: string[]): boolean {
  const last = rows[rows.length - 1];
  if (last === undefined || !BAR_ROW.test(last)) return false;
  const bars = (s: string) => (s.match(/\|/g) ?? []).length;
  const rule = rows.find((r) => BAR_ROW.test(r) && TABLE_RULE_BARS.test(r.trim()));
  return rule ? bars(last) < bars(rule) : !last.trimEnd().endsWith('|');
}

// ───── the buffer ─────

interface Cell {
  getChars(): string;
  getWidth(): number;
  isBold(): number;
  isItalic(): number;
  isUnderline(): number;
  isDim(): number;
  isFgDefault(): boolean;
  isFgRGB(): boolean;
  isFgPalette(): boolean;
  getFgColor(): number;
}
interface Line { isWrapped: boolean; length: number; translateToString(trim?: boolean): string; getCell(x: number, reuse?: Cell): Cell | undefined }
export interface BufferLike { length: number; getLine(y: number): Line | undefined; getNullCell(): Cell }

/** Whether a foreground colour is a hue (code, inline code, a diff's red and green) and not a grey or the default. */
function chromatic(c: Cell): boolean {
  if (c.isFgDefault()) return false;
  const v = c.getFgColor();
  if (c.isFgRGB()) {
    const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
    return Math.max(r, g, b) - Math.min(r, g, b) >= 24;
  }
  if (c.isFgPalette()) {
    if (v < 16) return v !== 0 && v !== 7 && v !== 8 && v !== 15;
    if (v >= 232) return false;
    const n = v - 16;
    const [r, g, b] = [Math.floor(n / 36), Math.floor(n / 6) % 6, n % 6];
    return Math.max(r, g, b) - Math.min(r, g, b) >= 2;
  }
  return false;
}

/** The styles of the buffer lines that make up one row (more than one only where the terminal itself wrapped). */
function rowRuns(buf: BufferLike, ys: readonly number[]): Run[] {
  const runs: Run[] = [];
  const cell = buf.getNullCell();
  for (const y of ys) {
    const line = buf.getLine(y);
    if (!line) continue;
    for (let x = 0; x < line.length; x++) {
      const c = line.getCell(x, cell);
      if (!c || c.getWidth() === 0) continue;
      const ch = c.getChars() || ' ';
      const style = { bold: !!c.isBold(), italic: !!c.isItalic(), underline: !!c.isUnderline(), dim: !!c.isDim(), code: chromatic(c), syntax: !c.isFgDefault() && c.isFgPalette() };
      const last = runs[runs.length - 1];
      if (last && !!last.bold === style.bold && !!last.italic === style.italic && !!last.underline === style.underline && !!last.dim === style.dim && !!last.code === style.code && !!last.syntax === style.syntax) last.text += ch;
      else runs.push({ text: ch, ...style });
    }
  }
  return runs;
}

/** The buffer's end as rows of text, and which buffer lines each row is. A row the terminal wrapped itself (it was longer than the width) continues the row before it with no break. */
export function tailRows(buf: BufferLike, max = 300): { rows: string[]; ys: number[][] } {
  const from = Math.max(0, buf.length - max);
  const rows: string[] = [];
  const ys: number[][] = [];
  for (let y = from; y < buf.length; y++) {
    const line = buf.getLine(y);
    const text = line?.translateToString(true) ?? '';
    if (line?.isWrapped && rows.length) { rows[rows.length - 1] += text; ys[ys.length - 1]!.push(y); }
    else { rows.push(text); ys.push([y]); }
  }
  while (rows.length && !rows[rows.length - 1]!.trim()) { rows.pop(); ys.pop(); }
  return { rows, ys };
}

/** The runs cut to the row's text, which has its trailing spaces trimmed. */
function trimRuns(runs: Run[], len: number): Run[] {
  const out: Run[] = [];
  let n = 0;
  for (const r of runs) {
    if (n >= len) break;
    out.push(n + r.text.length > len ? { ...r, text: r.text.slice(0, len - n) } : r);
    n += r.text.length;
  }
  return out;
}

/**
 * The message being written, read from the end of a terminal buffer. Only the last 300 rows are read (reading a whole
 * scrollback costs ~4ms, the end of it ~0.1ms), and styles only for the rows of the message.
 */
export function readScreenMessage(buf: BufferLike): ScreenMessage | null {
  const { rows, ys } = tailRows(buf);
  return screenMessage(rows, (i) => trimRuns(rowRuns(buf, ys[i]!), rows[i]!.length));
}
