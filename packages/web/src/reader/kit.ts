import type { MarkedExtension, Token, Tokens, TokenizerAndRendererExtension } from 'marked';

/**
 * Reader kit: a few `:::kind` blocks that turn plans, status and results into drawn blocks,
 * written by the agent in a line or two each instead of a page of HTML.
 *
 *   :::summary                       rows (`@cards` for cards): `title | body`
 *   :::decide Which way?             options:             `name (추천) | what it is | what it costs`
 *   :::stats                         big numbers:         `65분 → 2분 | how it was measured`
 *   :::flow                          steps:               `[state] name | detail`
 *   :::tree                          nested list, two spaces per level
 *   :::timeline                      `10/30 | what happened`
 *   :::bars base=573                 bars (one may be `(강조)`): `label: 72ms`, before and after: `label: 573 → 210ms`
 *   :::stack                         one bar split in parts:    `label: 요청 120 | 큐 40 | 모델 300`
 *   :::cols 지금 | 안 A | 안 B       columns split by a line holding `---`; `vs` is the same with two
 *   :::board                         `## group`, then `name | state | what | note`
 *   :::seq 사용자 | 서버 | DB        `a -> b : what`  (`-->` dashed, for a reply)
 *   :::layers                        `## layer`, then `box | note`; `~ boundary` between layers
 *   :::note warn Title               a boxed remark (info | ok | warn | risk), markdown inside
 *   :::fold Title                    collapsed; markdown and other blocks inside (`open` shows it open)
 *   :::table Title                   a markdown table drawn lightly
 *
 * A block can hold another when its fence is longer (`::::fold` around `:::flow`).
 * Colour says state only: green done, blue running or new, dashed grey not yet, red risk, amber caution.
 * `[ok] [run] [new] [chg] [todo] [have] [risk] [warn]` and `[실측] [코드] [추정] [미확인]` work in any text.
 *
 * Text that is not this stays plain markdown, so a message read in a terminal is still readable. A block that
 * is not closed runs to the end of the message — what the agent has written so far is drawn while it writes the rest.
 * A block whose lines cannot be read shows its text as it is, and a line with more cells than the block uses says so
 * under the block: a cell dropped without a word was the one fault nobody could see.
 * Text in the lines goes through the inline parser like any markdown; text taken whole (a question, a label, a number) is escaped here.
 * Raw HTML in either is cleaned by the DOMPurify pass every message goes through (markdown.ts), as before.
 */

const TAGS: Record<string, { cls: string; label: string }> = {
  ok: { cls: 'ok', label: '완료' },
  run: { cls: 'run', label: '진행' },
  new: { cls: 'new', label: '새로' },
  chg: { cls: 'chg', label: '바뀜' },
  todo: { cls: 'todo', label: '예정' },
  have: { cls: 'have', label: '있음' },
  risk: { cls: 'risk', label: '위험' },
  warn: { cls: 'warn', label: '주의' },
  실측: { cls: 'ev-measured', label: '실측' },
  코드: { cls: 'ev-code', label: '코드' },
  추정: { cls: 'ev-guess', label: '추정' },
  미확인: { cls: 'ev-unknown', label: '미확인' },
};

/** The state words of a board line: what is needed from whom. */
const BOARD_STATES: Record<string, string> = {
  do: '할 일', decide: '결정', running: '진행', stalled: '정체', done: '완료', wait: '대기',
};

const KINDS = new Set([
  'summary', 'flow', 'decide', 'stats', 'bars', 'stack', 'tree', 'timeline', 'vs', 'cols', 'board', 'seq', 'layers',
  'note', 'fold', 'table',
  // The names other markdown dialects (Docusaurus, VitePress) give a boxed remark; the agent has seen them.
  'tip', 'info', 'warning', 'caution', 'danger',
]);
const NOTE_KINDS = new Set(['info', 'ok', 'warn', 'risk']);
const NOTE_ALIAS: Record<string, string> = { tip: 'ok', info: 'info', warning: 'warn', caution: 'warn', danger: 'risk' };

/** How many cells a line of each block uses. More than this and the rest are not drawn, which the block says. */
const MAX_CELLS: Record<string, number> = {
  summary: 2, flow: 2, decide: 3, stats: 2, tree: 2, timeline: 2, layers: 2, board: 4,
};
/** Blocks whose body is lines of `- a | b`. An empty read of one of these falls back to showing the text. */
const LINE_KINDS = new Set(['summary', 'flow', 'decide', 'stats', 'bars', 'stack', 'tree', 'timeline']);

export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface Item { depth: number; cells: Token[][]; plain: string[]; marked: boolean }
interface Group { title: string; items: Item[]; boundary?: string }
interface Step { from: number; to: number; dashed: boolean; text: string; label: Token[] }
interface KitToken {
  type: 'rkBlock';
  raw: string;
  kind: string;
  args: string;
  body: string;
  items: Item[];
  blocks: Token[][];
  groups: Group[];
  steps: Step[];
  /** Why part of the block was not drawn, in the words the reader sees. */
  lint: string[];
  /** `@name` in the header: another drawing of the same lines. Blocks ignore a name they do not have. */
  variant: string;
}
interface TagToken { type: 'rkTag'; raw: string; tag: string; source?: string }

const MARKER = /\s*\((추천|강조)\)\s*/;

const tagHtml = (tag: string, source?: string): string => {
  const def = TAGS[tag]!;
  return `<span class="rk-st rk-${def.cls}">${def.label}</span>${source ? `<span class="rk-src">${esc(source)}</span>` : ''}`;
};

/** An evidence tag at the end of text that is taken whole (a bar's value): split off, to be drawn as the chip it is. */
function splitEvidence(text: string): { text: string; chip: string } {
  const m = /\s*\[(실측|코드|추정|미확인)(?::[ \t]*([^\]\n]{1,80}))?\]\s*$/.exec(text);
  return m ? { text: text.slice(0, m.index), chip: tagHtml(m[1]!, m[2]?.trim()) } : { text, chip: '' };
}

/** `- a | b` lines. Deeper indentation (two spaces a level) is kept for the tree; other lines continue the item above. */
function parseItems(body: string, lex: (text: string) => Token[], opts: { dropNumber?: boolean } = {}): Item[] {
  const items: Array<{ depth: number; text: string }> = [];
  for (const line of body.split('\n')) {
    const m = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (m) { items.push({ depth: Math.floor(m[1]!.replace(/\t/g, '  ').length / 2), text: m[2]! }); continue; }
    if (line.trim() === '') continue;
    const last = items[items.length - 1];
    if (last) last.text += ` ${line.trim()}`;
  }
  return items.map(({ depth, text }) => itemOf(depth, text, lex, opts));
}

/** Cells are separated by ` | `, except inside a code span: a line that explains the syntax quotes it. */
export function splitCells(text: string): string[] {
  const cells: string[] = [];
  let start = 0;
  let inCode = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '`') inCode = !inCode;
    else if (!inCode && text.startsWith(' | ', i)) { cells.push(text.slice(start, i).trim()); start = i + 3; i += 2; }
  }
  cells.push(text.slice(start).trim());
  return cells;
}

function itemOf(depth: number, text: string, lex: (text: string) => Token[], opts: { dropNumber?: boolean } = {}): Item {
  const marked = MARKER.test(text);
  let clean = marked ? text.replace(MARKER, ' ').trim() : text;
  // The step number is drawn; one the agent typed as well would show twice.
  if (opts.dropNumber) clean = clean.replace(/^(\[[^\]]+\]\s*)?\d+[.)]\s+/, '$1');
  const plain = splitCells(clean);
  return { depth, cells: plain.map((c) => lex(c)), plain, marked };
}

/** `## title` opens a group; `- a | b` lines belong to it; `~ text` is the boundary under the group above it. */
function parseGroups(body: string, lex: (text: string) => Token[]): Group[] {
  const groups: Group[] = [];
  let cur: Group | null = null;
  const ensure = (): Group => (cur ??= (groups.push({ title: '', items: [] }), groups[groups.length - 1]!));
  for (const line of body.split('\n')) {
    const head = /^#{2,4}\s+(.*)$/.exec(line);
    if (head) { cur = { title: head[1]!.trim(), items: [] }; groups.push(cur); continue; }
    const bound = /^~\s*(.*)$/.exec(line);
    if (bound) { const g = groups[groups.length - 1]; if (g) g.boundary = bound[1]!.trim(); continue; }
    const m = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (m) { ensure().items.push(itemOf(0, m[1]!, lex)); continue; }
    if (line.trim() !== '' && cur && cur.items.length) {
      const last = cur.items[cur.items.length - 1]!;
      last.plain[last.plain.length - 1] += ` ${line.trim()}`;
    }
  }
  return groups;
}

/** `a -> b : text`, `a --> b : text`. Names are matched against the participants in the block's first line. */
function parseSteps(body: string, people: string[], lex: (text: string) => Token[], lint: string[]): Step[] {
  const steps: Step[] = [];
  const index = (name: string): number => people.findIndex((p) => p.toLowerCase() === name.trim().toLowerCase());
  for (const line of body.split('\n')) {
    const m = /^\s*[-*+]\s+(.+?)\s*(-->|->)\s*(.+?)(?:\s*:\s*(.*))?$/.exec(line);
    if (!m) continue;
    const from = index(m[1]!);
    const to = index(m[3]!);
    if (from < 0 || to < 0) { lint.push(`"${(from < 0 ? m[1] : m[3])!.trim()}"는 위 참여자 줄에 없어서 이 단계를 그리지 않았습니다.`); continue; }
    steps.push({ from, to, dashed: m[2] === '-->', text: m[4] ?? '', label: lex(m[4] ?? '') });
  }
  return steps;
}

/**
 * The connector cells in front of each tree line, from the nesting alone:
 * one cell per ancestor level (a vertical line while that ancestor has later siblings, blank after its last),
 * then this line's own cell: a tee when a sibling follows, an elbow when it is the last.
 */
export function treeGuides(depths: number[]): Array<Array<'pipe' | 'blank' | 'tee' | 'elbow'>> {
  /** Does a later line at exactly `level` come before the nesting drops above it? */
  const siblingFollows = (from: number, level: number): boolean => {
    for (let j = from + 1; j < depths.length; j++) {
      if (depths[j]! < level) return false;
      if (depths[j]! === level) return true;
    }
    return false;
  };
  return depths.map((depth, i) => {
    const cells: Array<'pipe' | 'blank' | 'tee' | 'elbow'> = [];
    for (let level = 0; level < depth; level++) cells.push(siblingFollows(i, level) ? 'pipe' : 'blank');
    cells.push(siblingFollows(i, depth) ? 'tee' : 'elbow');
    return cells;
  });
}

function attrsOf(args: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of args.matchAll(/([\w가-힣]+)=("([^"]*)"|\S+)/g)) out[m[1]!] = m[3] ?? m[2]!;
  return out;
}

const num = (s: string): number => parseFloat(s.replace(/,/g, ''));
const pct = (n: number): string => `${n.toFixed(1)}%`;

/** `120ms`, `요청 120`, `573` → the number and what follows it. */
function leadingNumber(s: string): { n: number; rest: string } | null {
  const m = /^\s*(-?[\d][\d,]*\.?\d*)\s*(.*)$/.exec(s);
  return m ? { n: num(m[1]!), rest: m[2]!.trim() } : null;
}

const block: TokenizerAndRendererExtension = {
  name: 'rkBlock',
  level: 'block',
  start(src: string) { return /^:{3,}[a-z]/m.exec(src)?.index; },
  tokenizer(src: string) {
    const head = /^(:{3,})([a-z][a-z-]*)[ \t]*([^\n]*)(?:\n|$)/.exec(src);
    if (!head || !KINDS.has(head[2]!)) return undefined;
    const fence = head[1]!.length;
    const rest = src.slice(head[0].length);
    // The block ends at a line of at least as many colons; without one it runs to the end of what is there.
    const close = new RegExp(`^:{${fence},}[ \\t]*(?:\\n|$)`, 'm').exec(rest);
    const body = close ? rest.slice(0, close.index) : rest;
    const raw = head[0] + body + (close ? close[0] : '');
    let kind = head[2]!;
    let variant = '';
    let args = head[3]!.replace(/(^|\s)@([a-z][a-z0-9-]*)(?=\s|$)/, (_m, sp: string, v: string) => { variant = v; return sp; }).trim();
    if (NOTE_ALIAS[kind]) { args = `${NOTE_ALIAS[kind]} ${args}`.trim(); kind = 'note'; }
    const bodyText = body.replace(/\n+$/, '');
    // `this` is the lexer (marked binds it).
    const lexer = this.lexer;
    const lex = (text: string): Token[] => lexer.inlineTokens(text);
    const token: KitToken = { type: 'rkBlock', raw, kind, args, body: bodyText, items: [], blocks: [], groups: [], steps: [], lint: [], variant };
    if (kind === 'note' || kind === 'fold' || kind === 'table') {
      token.blocks = [lexer.blockTokens(bodyText, [])];
    } else if (kind === 'vs' || kind === 'cols') {
      const halves = bodyText.split(/^-{3,}[ \t]*$/m);
      token.blocks = halves.map((half) => lexer.blockTokens(half.replace(/^\n+|\n+$/g, ''), []));
    } else if (kind === 'board' || kind === 'layers') {
      token.groups = parseGroups(bodyText, lex);
      if (kind === 'board' && token.groups.some((g) => g.items.some((it) => it.plain.length > MAX_CELLS.board!))) {
        token.lint.push(`한 줄에 칸이 ${MAX_CELLS.board}개를 넘으면 넘는 칸은 그리지 않습니다.`);
      }
      if (kind === 'layers' && token.groups.some((g) => g.items.some((it) => it.plain.length > MAX_CELLS.layers!))) {
        token.lint.push(`한 줄에 칸이 ${MAX_CELLS.layers}개를 넘으면 넘는 칸은 그리지 않습니다.`);
      }
    } else if (kind === 'seq') {
      const people = args.split('|').map((p) => p.trim()).filter(Boolean);
      token.steps = parseSteps(bodyText, people, lex, token.lint);
    } else {
      token.items = parseItems(bodyText, lex, { dropNumber: kind === 'flow' });
      const max = MAX_CELLS[kind];
      if (max !== undefined && token.items.some((it) => it.plain.length > max)) {
        token.lint.push(`이 블록은 한 줄에 칸을 ${max}개까지 씁니다. 넘는 칸은 그리지 않았습니다.`);
      }
    }
    const empty = (LINE_KINDS.has(kind) && token.items.length === 0)
      || ((kind === 'board' || kind === 'layers') && token.groups.every((g) => g.items.length === 0))
      || (kind === 'seq' && token.steps.length === 0);
    if (empty && bodyText.trim() !== '') {
      // Nothing could be read: show what was written instead of an empty frame.
      token.blocks = [lexer.blockTokens(bodyText, [])];
      token.lint.unshift(`':::${kind}' 블록의 줄 형식(- 칸 | 칸)을 읽지 못해 본문을 그대로 보여 줍니다.`);
    }
    return token as unknown as Tokens.Generic;
  },
  renderer(raw) {
    const t = raw as unknown as KitToken;
    const inline = (tokens: Token[]): string => this.parser.parseInline(tokens);
    const cell = (item: Item, i: number): string => (item.cells[i] ? inline(item.cells[i]!) : '');
    const lint = t.lint.length ? `<p class="rk-lint">${t.lint.map(esc).join(' ')}</p>` : '';
    const v = t.variant;
    /** The variant is a class on the block's own root, so a stylesheet can redraw it without another structure. */
    const tagged = (html: string): string => (v ? html.replace(/class="rk /, `class="rk rk-v-${v} `) : html);
    const fallback = t.blocks.length > 0 && !['note', 'fold', 'table', 'vs', 'cols'].includes(t.kind);
    if (fallback) return `<div class="rk rk-fallback">${this.parser.parse(t.blocks[0]!)}${lint}</div>\n`;
    const out = (html: string): string => `${tagged(html)}${lint}\n`;
    switch (t.kind) {
      case 'summary': {
        const sv = v === 'cards' ? '' : v || 'rows';
        const html = `<div class="rk rk-summary">${t.items.map((it) => `<div class="rk-card"><b>${cell(it, 0)}</b><p>${cell(it, 1)}</p></div>`).join('')}</div>`;
        return `${sv ? html.replace(/class="rk /, `class="rk rk-v-${sv} `) : html}${lint}\n`;
      }
      case 'flow':
        return out(`<ol class="rk rk-flow${t.items.some((it) => it.cells[1]) ? ' rk-rows' : ''}">${t.items.map((it, n) => `<li><span class="rk-n">${n + 1}</span><div><b>${cell(it, 0)}</b>${it.cells[1] ? `<p>${cell(it, 1)}</p>` : ''}</div></li>`).join('')}</ol>`);
      case 'decide':
        if (v === 'table') {
          return out(`<div class="rk rk-decide rk-dtable">${t.args ? `<p class="rk-q">${esc(t.args)}</p>` : ''}<div class="rk-dhead"><span>안</span><span>설명</span><span>감수할 것</span></div>${t.items.map((it) => `<div class="rk-drow${it.marked ? ' rk-rec' : ''}"><b>${cell(it, 0)}${it.marked ? '<span class="rk-recpill">추천</span>' : ''}</b><span>${cell(it, 1)}</span><span>${cell(it, 2)}</span></div>`).join('')}</div>`);
        }
        return out(`<div class="rk rk-decide">${t.args ? `<p class="rk-q">${esc(t.args)}</p>` : ''}<div class="rk-opts">${t.items.map((it) => `<div class="rk-opt${it.marked ? ' rk-rec' : ''}">${it.marked ? '<span class="rk-recmark">추천</span>' : ''}<b>${cell(it, 0)}</b>${it.cells[1] ? `<p>${cell(it, 1)}</p>` : ''}${it.cells[2] ? `<p class="rk-cost"><span>감수</span> ${cell(it, 2)}</p>` : ''}</div>`).join('')}</div></div>`);
      case 'stats':
        return out(`<div class="rk rk-stats">${t.items.map((it) => {
          const pair = v === 'contrast' ? /^(.*?)\s*(?:→|->)\s*(.*)$/.exec(it.plain[0]!) : null;
          const big = pair
            ? `<div class="rk-big rk-contrast"><span class="rk-from">${esc(pair[1]!)}</span><i>→</i><span class="rk-to">${esc(pair[2]!)}</span></div>`
            : `<div class="rk-big${it.plain[0]!.length > 9 ? ' rk-long' : ''}">${cell(it, 0)}</div>`;
          return `<div class="rk-stat">${big}${it.cells[1] ? `<p>${cell(it, 1)}</p>` : ''}</div>`;
        }).join('')}</div>`);
      case 'bars': {
        const rows = t.items.map((it) => {
          // The tag goes first: its source may hold a colon of its own.
          const split = splitEvidence(it.plain[0]!);
          const raw0 = split.text;
          const colon = raw0.lastIndexOf(':');
          const label = colon > 0 ? raw0.slice(0, colon).trim() : raw0;
          const value = colon > 0 ? raw0.slice(colon + 1).trim() : '';
          // `573 → 210ms`: a before and an after, drawn as two bars with the change written out.
          const pair = /^(.*?)\s*(?:→|->)\s*(.*)$/.exec(value);
          const a = pair ? leadingNumber(pair[1]!) : null;
          const b = pair ? leadingNumber(pair[2]!) : null;
          const n = leadingNumber(value);
          return { label, value, chip: split.chip, n: n?.n ?? 0, pair: a && b ? { a: a.n, b: b.n, unit: b.rest || a.rest } : null, hi: it.marked };
        });
        const base = parseFloat(attrsOf(t.args).base ?? '');
        const max = Math.max(1, ...rows.flatMap((r) => (r.pair ? [r.pair.a, r.pair.b] : [r.n])), Number.isFinite(base) ? base : 0);
        const baseLine = Number.isFinite(base) ? `<i class="rk-base" style="--w:${((base / max) * 100).toFixed(1)}%" title="${esc(String(base))}"></i>` : '';
        return out(`<div class="rk rk-bars">${rows.map((r) => {
          if (r.pair) {
            const change = r.pair.a !== 0 ? Math.round(((r.pair.b - r.pair.a) / r.pair.a) * 100) : null;
            return `<div class="rk-row rk-pair${r.hi ? ' rk-hi' : ''}"><span class="rk-lab">${esc(r.label)}</span><span class="rk-tracks"><span class="rk-track rk-before"><i style="--w:${((r.pair.a / max) * 100).toFixed(1)}%"></i>${baseLine}</span><span class="rk-track rk-after"><i style="--w:${((r.pair.b / max) * 100).toFixed(1)}%"></i>${baseLine}</span></span><span class="rk-val">${esc(`${r.pair.a} → ${r.pair.b}${r.pair.unit}`)}${change !== null ? `<em>${change > 0 ? '+' : '−'}${Math.abs(change)}%</em>` : ''}${r.chip}</span></div>`;
          }
          return `<div class="rk-row${r.hi ? ' rk-hi' : ''}"><span class="rk-lab">${esc(r.label)}</span><span class="rk-track"><i style="--w:${((r.n / max) * 100).toFixed(1)}%"></i>${baseLine}</span><span class="rk-val">${esc(r.value)}${r.chip}</span></div>`;
        }).join('')}</div>`);
      }
      case 'stack': {
        // `dev: 요청 120 | 큐 40 | 모델 300`: the label up to the first colon, then parts that each end in a number.
        const legend: string[] = [];
        const rows = t.items.map((it) => {
          const first = it.plain[0]!;
          const colon = first.indexOf(':');
          const label = colon > 0 ? first.slice(0, colon).trim() : '';
          const parts = [colon > 0 ? first.slice(colon + 1).trim() : first, ...it.plain.slice(1)].map((p) => {
            const m = /^(.*?)\s*(-?\d[\d,]*\.?\d*)\s*([^\d\s]*)$/.exec(p);
            if (!m) return null;
            const name = m[1]!.trim() || '·';
            if (!legend.includes(name)) legend.push(name);
            return { name, n: num(m[2]!), unit: m[3]! };
          }).filter((p): p is { name: string; n: number; unit: string } => p !== null);
          return { label, parts, total: parts.reduce((s, p) => s + p.n, 0), unit: parts[0]?.unit ?? '' };
        });
        const max = Math.max(1, ...rows.map((r) => r.total));
        if (v === 'donut') {
          return out(`<div class="rk rk-stack"><div class="rk-donuts">${rows.map((r) => {
            let at = 0;
            const stops = r.parts.map((p) => {
              const from = at;
              at += (p.n / Math.max(1, r.total)) * 100;
              return `var(--rk-c${legend.indexOf(p.name) % 5}) ${from.toFixed(1)}% ${at.toFixed(1)}%`;
            }).join(', ');
            return `<div class="rk-donut"><i style="background:conic-gradient(${stops})"><b>${esc(String(Math.round(r.total * 10) / 10))}${esc(r.unit)}</b></i><span>${esc(r.label)}</span></div>`;
          }).join('')}</div><div class="rk-legend">${legend.map((n, i) => `<span><i class="rk-c${i % 5}"></i>${esc(n)}</span>`).join('')}</div></div>`);
        }
        return out(`<div class="rk rk-stack">${rows.map((r) => `<div class="rk-row"><span class="rk-lab">${esc(r.label)}</span><span class="rk-seg">${r.parts.map((p) => {
          const share = (p.n / max) * 100;
          return `<i class="rk-c${legend.indexOf(p.name) % 5}" style="--w:${share.toFixed(1)}%" title="${esc(`${p.name} ${p.n}${p.unit}`)}">${share >= 11 ? esc(String(p.n)) : ''}</i>`;
        }).join('')}</span><span class="rk-val">${esc(String(Math.round(r.total * 10) / 10))}${esc(r.unit)}</span></div>`).join('')}<div class="rk-legend">${legend.map((n, i) => `<span><i class="rk-c${i % 5}"></i>${esc(n)}</span>`).join('')}</div></div>`);
      }
      case 'tree': {
        const guides = treeGuides(t.items.map((it) => it.depth));
        return out(`<div class="rk rk-tree">${t.items.map((it, i) => `<div class="rk-node${/\/\s*$/.test(it.plain[0] ?? '') ? ' rk-dir' : ''}">${guides[i]!.map((g) => `<i class="rk-g rk-g-${g}"></i>`).join('')}<span class="rk-name">${cell(it, 0)}</span>${it.cells[1] ? `<span class="rk-note">${cell(it, 1)}</span>` : ''}</div>`).join('')}</div>`);
      }
      case 'timeline':
        return out(`<ol class="rk rk-timeline">${t.items.map((it) => `<li><span class="rk-when">${cell(it, 0)}</span><span class="rk-what">${cell(it, 1)}</span></li>`).join('')}</ol>`);
      case 'vs':
      case 'cols': {
        const heads = t.args.split('|').map((h) => h.trim());
        return tagged(`<div class="rk rk-vs rk-cols" style="--n:${t.blocks.length}">${t.blocks.map((b, i) => `<div class="rk-side"><b class="rk-sidehead">${esc(heads[i] ?? '')}</b>${this.parser.parse(b)}</div>`).join('')}</div>`) + '\n';
      }
      case 'board': {
        if (v === 'table') {
          return out(`<div class="rk rk-board rk-btable"><div class="rk-brow rk-bthead"><span>항목</span><span>상태</span><span>내용</span></div>${t.groups.map((g) => `${g.title ? `<div class="rk-btgroup">${esc(g.title)}<span class="rk-count">${g.items.length}</span></div>` : ''}${g.items.map((it) => {
            const word = (it.plain[1] ?? '').toLowerCase();
            const known = BOARD_STATES[word];
            return `<div class="rk-brow"><span class="rk-bname">${cell(it, 0)}</span><span class="rk-bstate rk-bs-${known ? word : 'other'}">${known ?? esc(it.plain[1] ?? '')}</span><span class="rk-btext">${cell(it, 2)}${it.cells[3] ? `<small>${cell(it, 3)}</small>` : ''}</span></div>`;
          }).join('')}`).join('')}</div>`);
        }
        return out(`<div class="rk rk-board">${t.groups.map((g) => `<section class="rk-bgroup">${g.title ? `<header><b>${esc(g.title)}</b><span class="rk-count">${g.items.length}</span></header>` : ''}${g.items.map((it) => {
          const word = (it.plain[1] ?? '').toLowerCase();
          const known = BOARD_STATES[word];
          return `<div class="rk-brow"><span class="rk-bname">${cell(it, 0)}</span><span class="rk-bstate rk-bs-${known ? word : 'other'}">${known ?? esc(it.plain[1] ?? '')}</span><span class="rk-btext">${cell(it, 2)}${it.cells[3] ? `<small>${cell(it, 3)}</small>` : ''}</span></div>`;
        }).join('')}</section>`).join('')}</div>`);
      }
      case 'layers':
        return out(`<div class="rk rk-layers">${t.groups.map((g) => `<section class="rk-layer">${g.title ? `<b class="rk-layername">${esc(g.title)}</b>` : ''}<div class="rk-lboxes">${g.items.map((it) => `<div class="rk-lbox"><b>${cell(it, 0)}</b>${it.cells[1] ? `<small>${cell(it, 1)}</small>` : ''}</div>`).join('')}</div></section>${g.boundary ? `<div class="rk-boundary"><span>${esc(g.boundary)}</span></div>` : ''}`).join('')}</div>`);
      case 'seq': {
        const people = t.args.split('|').map((p) => p.trim()).filter(Boolean);
        const n = Math.max(1, people.length);
        if (v === 'list') {
          return out(`<ol class="rk rk-seqlist">${t.steps.map((s, i) => `<li><span class="rk-sn">${i + 1}</span><span class="rk-who">${esc(people[s.from] ?? '')}</span><i class="${s.dashed ? 'rk-dashed' : ''}">${s.dashed ? '⇢' : '→'}</i><span class="rk-who">${esc(people[s.to] ?? '')}</span><span class="rk-what">${inline(s.label)}</span></li>`).join('')}</ol>`);
        }
        return out(`<div class="rk rk-seq" style="--n:${n}"><div class="rk-seqhead"><i></i>${people.map((p) => `<b>${esc(p)}</b>`).join('')}</div><div class="rk-seqbody">${t.steps.map((s, i) => {
          const lo = Math.min(s.from, s.to);
          const hi = Math.max(s.from, s.to);
          const span = hi - lo + 1;
          const self = s.from === s.to;
          const dir = self ? 'self' : s.to > s.from ? 'right' : 'left';
          return `<div class="rk-seqrow"><span class="rk-sn">${i + 1}</span><div class="rk-sarrow rk-${dir}${s.dashed ? ' rk-dashed' : ''}" style="grid-column:${lo + 2} / span ${span};--half:${self ? '0' : (100 / (2 * span)).toFixed(2)}%"><span>${inline(s.label)}</span></div></div>`;
        }).join('')}</div></div>`);
      }
      case 'note': {
        const [first, ...restWords] = t.args.split(/\s+/);
        const kind = first && NOTE_KINDS.has(first) ? first : 'info';
        const title = (first && NOTE_KINDS.has(first) ? restWords.join(' ') : t.args).trim();
        return tagged(`<div class="rk rk-note-box rk-n-${kind}"><b class="rk-notehead"><i></i>${esc(title || { info: '참고', ok: '확인됨', warn: '주의', risk: '위험' }[kind]!)}</b>${this.parser.parse(t.blocks[0] ?? [])}</div>`) + '\n';
      }
      case 'fold': {
        const open = /(^|\s)open$/.test(t.args);
        const title = t.args.replace(/(^|\s)open$/, '').trim() || '자세히';
        return tagged(`<details class="rk rk-fold"${open ? ' open' : ''}><summary>${esc(title)}</summary><div class="rk-foldbody">${this.parser.parse(t.blocks[0] ?? [])}</div></details>`) + '\n';
      }
      case 'table':
        return tagged(`<div class="rk rk-tbl">${t.args ? `<p class="rk-tbltitle">${esc(t.args)}</p>` : ''}${this.parser.parse(t.blocks[0] ?? [])}</div>`) + '\n';
      default:
        return '';
    }
  },
};

const tag: TokenizerAndRendererExtension = {
  name: 'rkTag',
  level: 'inline',
  start(src: string) { return src.indexOf('['); },
  tokenizer(src: string) {
    const m = /^\[(ok|run|new|chg|todo|have|risk|warn|실측|코드|추정|미확인)(?::[ \t]*([^\]\n]{1,80}))?\]/.exec(src);
    if (!m) return undefined;
    // Only the evidence tags take a source; `[ok: x]` is not a tag and stays text.
    if (m[2] !== undefined && !/^(실측|코드|추정|미확인)$/.test(m[1]!)) return undefined;
    return { type: 'rkTag', raw: m[0], tag: m[1]!, source: m[2]?.trim() } as unknown as Tokens.Generic;
  },
  renderer(raw) {
    const t = raw as unknown as TagToken;
    return tagHtml(t.tag, t.source);
  },
};

export const kitExtension: MarkedExtension = { extensions: [block, tag] };
