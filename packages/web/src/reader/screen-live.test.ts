import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Terminal } from '@xterm/headless';
import { marked } from 'marked';
import { readScreenMessage, screenMessage, toMarkdown } from './screen-live.js';

const D = '─'.repeat(40);

describe('screenMessage', () => {
  it('joins the rows of a wrapped paragraph and stops at the spinner', () => {
    const rows = ['❯ hi', '', '⏺ Octopuses are masters of', '  camouflage and they do it', '  with pigment.', '', '✳ Tinkering… (3s)', '', D, '❯', D];
    expect(screenMessage(rows)).toEqual({ start: 2, streaming: true, text: 'Octopuses are masters of camouflage and they do it with pigment.' });
  });
  it('is empty until the first words are drawn, and null with nothing from the agent', () => {
    expect(screenMessage(['❯ hi', '⏺', '✳ Thinking…'])).toEqual({ start: 1, streaming: true, text: '' });
    expect(screenMessage(['❯ hi', '✳ Thinking…', D])).toBeNull();
  });
  it('takes the last message when there are several', () => {
    const rows = ['⏺ first', '', '⏺ Bash(ls)', '  ⎿  a b', '', '⏺ second one', '  wrapped', D];
    expect(screenMessage(rows)?.text).toBe('second one wrapped');
  });
  it('is not a message while the last thing drawn is a tool call', () => {
    expect(screenMessage(['⏺ words', '', '⏺ Bash(ls -l /tmp)', D])).toBeNull();
    expect(screenMessage(['⏺ words', '', '⏺ Listing 1 directory… (ctrl+o to expand)', D])).toBeNull();
    expect(screenMessage(['⏺ words', '', '⏺ mcp__figma__whoami()', D])).toBeNull();
  });
  it('does not take a tool row for words when its marker is between blinks', () => {
    const rows = ['⏺ I will list it.', '  Listing 1 directory… (ctrl+o to expand)', D];
    expect(screenMessage(rows)?.text).toBe('I will list it.');
    expect(screenMessage(['⏺ Let me check.', '  Bash(ls -ld /tmp)', D])?.text).toBe('Let me check.');
  });
  it('knows the agent is done writing from its spinner row', () => {
    expect(screenMessage(['⏺ all of it', '', '✻ Cooked for 9s · done 오후 4:05', D])?.streaming).toBe(false);
    expect(screenMessage(['⏺ all of it', '', '✳ Tinkering… (11s · ↓ 1.5k tokens)', D])?.streaming).toBe(true);
    expect(screenMessage(['⏺ all of it', '', D, '❯', D])?.streaming).toBe(false);
  });
  it('ends at the Interrupted row', () => {
    expect(screenMessage(['⏺ Female octopuses brood their eggs for long', '  ⎿  Interrupted · What should Claude do instead?', D])?.text)
      .toBe('Female octopuses brood their eggs for long');
  });
});

/** Rows as the terminal draws prose: with a two-column margin. */
const margin = (rows: string[]) => rows.map((r) => (r ? '  ' + r : r));

describe('toMarkdown', () => {
  it('keeps paragraphs apart and wrapped list items whole', () => {
    expect(toMarkdown(['one two', 'three', '', '- a b', '  c d', '- e', '', 'after'])).toBe('one two three\n\n- a b c d\n- e\n\nafter');
  });
  it('keeps a table drawn as its markdown (bars, a row wrapped at a narrow width), and wrapped code, as rows (rows without styles)', () => {
    const rows = [
      '| 구성 요소 | 역할 | 특징 |', '|---|---|---|', '| 색소포 | 근육으로 크기를 조절해 색을 낸다', '| 신경이 직접 제어한다 |', '| 피부 돌기 | 표면을 울퉁불퉁하게 바꾼다 |', '바위·산호의 질감을 흉내 낸다 |',
      '', '    matched = [c for c in skin if c in', 'background]', '    total = len(skin) or 1', '', 'After the code.',
    ];
    expect(toMarkdown(margin(rows))).toBe([
      '```\n| 구성 요소 | 역할 | 특징 |\n|---|---|---|\n| 색소포 | 근육으로 크기를 조절해 색을 낸다 | 신경이 직접 제어한다 |\n| 피부 돌기 | 표면을 울퉁불퉁하게 바꾼다 | 바위·산호의 질감을 흉내 낸다 |\n```',
      '```\nmatched = [c for c in skin if c in background]\ntotal = len(skin) or 1\n```',
      'After the code.',
    ].join('\n\n'));
  });
  it('keeps indented rows and table rows as they were, in a fence that stays open at the end', () => {
    const rows = ['text', '', 'a    | b   | c', '-----+-----+----', 'd    | e   | f'];
    expect(toMarkdown(margin(rows))).toBe('text\n\n```\na    | b   | c\n-----+-----+----\nd    | e   | f');
    expect(toMarkdown(margin([...rows, '', 'next']))).toBe('text\n\n```\na    | b   | c\n-----+-----+----\nd    | e   | f\n```\n\nnext');
    expect(toMarkdown(margin(['code:', '', '    x = 1', '    y = 2']))).toBe('code:\n\n```\nx = 1\ny = 2');
  });
});

// ── Recorded sessions: real Claude Code output (2.1.301, haiku), replayed through the terminal the page reads. ──
interface Fixture { name: string; cols: number; rows: number; truth: string[]; ev: [number, string][] }
const load = (name: string): Fixture => JSON.parse(readFileSync(new URL(`./__fixtures__/${name}.json`, import.meta.url), 'utf8'));
const letters = (s: string) => (s.match(/[\p{L}\p{N}]/gu) ?? []).join('');
/** The record keeps the fence's language tag; the terminal does not draw it. */
const noTags = (s: string) => s.replace(/^(`{3,}|~{3,})\w*$/gm, '$1');

async function replay(fx: Fixture): Promise<(string | null)[]> {
  const term = new Terminal({ cols: fx.cols, rows: fx.rows, scrollback: 3000, allowProposedApi: true });
  const frames: (string | null)[] = [];
  for (const [, b64] of fx.ev) {
    await new Promise<void>((r) => term.write(Buffer.from(b64, 'base64'), r));
    frames.push(readScreenMessage(term.buffer.active)?.text ?? null);
  }
  return frames;
}

/** The kinds of the top-level blocks of a document, in order (what a reader sees as its shape). */
const shape = (md: string) => marked.lexer(md).filter((t) => t.type !== 'space').map((t) => (t.type === 'list' ? (t.ordered ? 'ol' : 'ul') : t.type === 'code' ? 'pre' : t.type === 'paragraph' ? 'p' : t.type)).join(' ');

async function lastMessage(fx: Fixture): Promise<string> {
  const frames = (await replay(fx)).filter((f): f is string => !!f);
  return frames[frames.length - 1]!;
}

describe('recorded sessions: the preview has the shape of the record', () => {
  // Headings, bold/italic/code, lists, quotes, rules, tables, diagrams and highlighted code, at 60 to 160 columns.
  for (const name of ['hi60', 'hi100', 'ks60', 'ks160', 'c1_60', 'c4_60']) {
    it(`${name}: same blocks, in the same order, as the agent's own text`, async () => {
      const fx = load(name);
      expect(shape(await lastMessage(fx))).toBe(shape(noTags(fx.truth[fx.truth.length - 1]!)));
    });
  }

  it('ks60: bold, italic, inline code, nesting and the quote come back as markdown', async () => {
    const md = await lastMessage(load('ks60'));
    expect(md).toMatch(/^## /);
    expect(md).toMatch(/\*\*[^*]+\*\*/);
    expect(md).toMatch(/(^|[^*])\*[^*\n]+\*([^*]|$)/);
    expect(md).toMatch(/`inline code`/);
    expect(md).toMatch(/^ {2}- /m);
    expect(md).toMatch(/^> /m);
    expect(md).toMatch(/^---$/m);
  });

  it('hi100: a table the terminal drew with box characters becomes a markdown table', async () => {
    const md = await lastMessage(load('hi100'));
    expect(md).toMatch(/^\| 영역 +\| /m);
    expect(md).toMatch(/^\| --- \|/m);
  });

  it('c3_120: highlighted code (python, javascript, bash, json, html) is code, and a language the terminal cannot colour keeps its name', async () => {
    const md = await lastMessage(load('c3_120'));
    const fences = md.match(/^```.*$/gm) ?? [];
    expect(fences.length).toBeGreaterThanOrEqual(10);
    expect(md).toMatch(/^```mermaid$/m);
    expect(md).not.toMatch(/^import os import sys/m);
  });

  it('c2_60: nested and long lists are lists', async () => {
    const md = await lastMessage(load('c2_60'));
    expect(md).toMatch(/^ {4}- /m);
    expect(md).toMatch(/^12\. /m);
  });
});

describe('recorded sessions', () => {
  for (const name of ['w80', 'w120', 'w160', 'w200', 'long120', 'ko100', 'hi60', 'hi100', 'ks60', 'ks160', 'c1_60', 'c4_60']) {
    it(`${name}: each frame extends the one before, and the last one is the record's text`, async () => {
      const fx = load(name);
      const frames = await replay(fx);
      let prev = '';
      let steps = 0;
      for (const f of frames) {
        if (f === null) { prev = ''; continue; }
        const now = letters(f);
        if (now === prev) continue;
        steps++;
        expect(now.startsWith(prev), `frame diverged after ${prev.length} letters`).toBe(true);
        prev = now;
      }
      expect(steps).toBeGreaterThan(5);
      expect(prev).toBe(letters(noTags(fx.truth[fx.truth.length - 1]!)));
    });
  }

  it('esc160c: an interrupted message is what was drawn, up to the cut', async () => {
    const fx = load('esc160c');
    const last = (await replay(fx)).filter((f): f is string => f !== null && f.length > 0).pop()!;
    const truth = letters(fx.truth[fx.truth.length - 1]!);
    expect(truth.startsWith(letters(last)) || letters(last).startsWith(truth)).toBe(true);
  });

  it('tools160: tool calls are never taken for the agent\'s words, and every frame is the start of a message the record has', async () => {
    const fx = load('tools160');
    const frames = await replay(fx);
    const truth = fx.truth.map(letters);
    for (const f of frames) {
      if (f === null) continue;
      expect(f).not.toMatch(/Bash\(|Listing \d+ director|ctrl\+o/);
      const n = letters(f);
      if (n) expect(truth.some((t) => t.startsWith(n)), `"${f.slice(0, 60)}" is not the start of any message in the record`).toBe(true);
    }
  });
});
