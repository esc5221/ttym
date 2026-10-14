/**
 * The tab's icon and title, from what the agents are doing.
 *
 * With many browser tabs open only the icon (and, a little wider, the title's first character) can be seen,
 * so those two carry the state. The icon is the brand mark (a block cursor on a dark tile) with a badge:
 * a red circle with the number of panes waiting for the person, a green check once a turn has ended unseen,
 * an amber ring while an agent works. The title starts with one plain symbol for the same state, so the state
 * is still readable where the icon can't change (Safari) or colours are hard to tell apart.
 */

export type TabState = 'idle' | 'run' | 'done' | 'wait' | 'offline';

export const BRAND_ACCENT = '#f29c5c';

const TILE = '#0b0b0c';
const RED = '#e5484d';
const GREEN = '#3fb27f';
const AMBER = '#e0a030';
const GREY = '#6d6d72';

// 5x7 digits for one-digit counts, 3x5 for two digits; on the 64-unit icon each cell is a whole pixel at 16px and at 32px.
const DIGITS_5X7: Record<string, string[]> = {
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'], '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'], '3': ['.###.', '#...#', '....#', '..##.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'], '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'], '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'], '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
};
const DIGITS_3X5: Record<string, string[]> = {
  '0': ['###', '#.#', '#.#', '#.#', '###'], '1': ['.#.', '##.', '.#.', '.#.', '###'], '2': ['###', '..#', '###', '#..', '###'], '3': ['###', '..#', '###', '..#', '###'],
  '4': ['#.#', '#.#', '###', '..#', '..#'], '5': ['###', '#..', '###', '..#', '###'], '6': ['###', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '.#.', '.#.', '.#.'], '8': ['###', '#.#', '###', '#.#', '###'], '9': ['###', '#.#', '###', '..#', '###'],
};
// Letters for the workspace initial, in the same 5x7 grid as the digits.
const LETTERS_5X7: Record<string, string[]> = {
  A: ['.###.','#...#','#...#','#####','#...#','#...#','#...#'],
  B: ['####.','#...#','#...#','####.','#...#','#...#','####.'],
  C: ['.####','#....','#....','#....','#....','#....','.####'],
  D: ['####.','#...#','#...#','#...#','#...#','#...#','####.'],
  E: ['#####','#....','#....','####.','#....','#....','#####'],
  F: ['#####','#....','#....','####.','#....','#....','#....'],
  G: ['.####','#....','#....','#.###','#...#','#...#','.###.'],
  H: ['#...#','#...#','#...#','#####','#...#','#...#','#...#'],
  I: ['.###.','..#..','..#..','..#..','..#..','..#..','.###.'],
  J: ['..###','...#.','...#.','...#.','...#.','#..#.','.##..'],
  K: ['#...#','#..#.','#.#..','##...','#.#..','#..#.','#...#'],
  L: ['#....','#....','#....','#....','#....','#....','#####'],
  M: ['#...#','##.##','#.#.#','#.#.#','#...#','#...#','#...#'],
  N: ['#...#','##..#','#.#.#','#..##','#...#','#...#','#...#'],
  O: ['.###.','#...#','#...#','#...#','#...#','#...#','.###.'],
  P: ['####.','#...#','#...#','####.','#....','#....','#....'],
  Q: ['.###.','#...#','#...#','#...#','#.#.#','#..#.','.##.#'],
  R: ['####.','#...#','#...#','####.','#.#..','#..#.','#...#'],
  S: ['.####','#....','#....','.###.','....#','....#','####.'],
  T: ['#####','..#..','..#..','..#..','..#..','..#..','..#..'],
  U: ['#...#','#...#','#...#','#...#','#...#','#...#','.###.'],
  V: ['#...#','#...#','#...#','#...#','#...#','.#.#.','..#..'],
  W: ['#...#','#...#','#...#','#.#.#','#.#.#','##.##','#...#'],
  X: ['#...#','#...#','.#.#.','..#..','.#.#.','#...#','#...#'],
  Y: ['#...#','#...#','.#.#.','..#..','..#..','..#..','..#..'],
  Z: ['#####','....#','...#.','..#..','.#...','#....','#####'],
};
const CHECK = ['......#', '.....##', '#...##.', '##.##..', '.###...'];

const cells = (rows: string[], x0: number, y0: number, unit: number, fill = '#fff'): string =>
  rows.map((row, y) => [...row].map((c, x) =>
    c === '#' ? `<rect x="${x0 + x * unit}" y="${y0 + y * unit}" width="${unit}" height="${unit}" fill="${fill}"/>` : '').join('')).join('');

/** Ring colours; a key (a stream's name, or a workspace's id) keeps its colour because the colour comes from a hash of it. */
export const PALETTE = ['#e5645a', '#e8873a', '#d4a72c', '#8fb83a', '#3fb27f', '#2fb5b0', '#3a9bd9', '#5a7ae0', '#8a6cdb', '#bf63cf', '#d9628f', '#8d96a3'];

export function colorFor(key: string): string {
  let h = 5381;
  for (const c of key) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

/** The first Latin letter or digit of a name, upper-cased; names without one (Korean only) have none. */
export function initialOf(name: string): string {
  const m = /[A-Za-z0-9]/.exec(name);
  return m ? m[0].toUpperCase() : '';
}

/** Which workspace the tab is on: its tile gets the workspace's colour and initial instead of the brand's. */
export interface TabIdentity { key: string; name: string }

/** The icon as an SVG document. `count` is the number of waiting panes and is only drawn for the `wait` state. `elsewhere` marks a pane waiting in another workspace. */
export function faviconSvg({ state, count = 0, accent = BRAND_ACCENT, identity, elsewhere = false }: {
  state: TabState; count?: number; accent?: string; identity?: TabIdentity; elsewhere?: boolean;
}): string {
  if (identity) return identitySvg({ state, count, identity, elsewhere });
  let body = `<rect width="64" height="64" rx="14" fill="${TILE}"/>`;
  if (state === 'idle') {
    body += `<rect x="22" y="12" width="20" height="40" fill="${accent}"/>`;
  } else if (state === 'offline') {
    body += `<rect x="24" y="14" width="16" height="36" fill="none" stroke="${GREY}" stroke-width="4"/>`;
  } else {
    body += `<rect x="10" y="8" width="20" height="40" fill="${accent}"/>`;
    const disc = state === 'wait' ? RED : state === 'done' ? GREEN : TILE;
    body += `<circle cx="42" cy="42" r="21" fill="${disc}"/>`;
    if (state === 'wait') {
      const n = String(Math.min(Math.max(Math.floor(count), 1), 99));
      body += n.length === 1
        ? cells(DIGITS_5X7[n]!, 32, 28, 4)
        : cells(DIGITS_3X5[n[0]!]!, 29, 33, 4) + cells(DIGITS_3X5[n[1]!]!, 43, 33, 4);
    } else if (state === 'done') {
      body += cells(CHECK, 28, 32, 4);
    } else {
      body += `<circle cx="42" cy="42" r="15" fill="none" stroke="${AMBER}" stroke-width="7"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" shape-rendering="crispEdges">${body}</svg>`;
}

const glyph5x7 = (c: string): string[] => LETTERS_5X7[c] ?? DIGITS_5X7[c]!;

function identitySvg({ state, count, identity, elsewhere }: { state: TabState; count: number; identity: TabIdentity; elsewhere: boolean }): string {
  // Every workspace shares the dark tile; the ring is the workspace's colour and the letter its initial.
  const badge = state === 'wait' || state === 'done' || state === 'run';
  const ring = state === 'offline' ? GREY : colorFor(identity.key);
  let body = `<rect width="64" height="64" rx="14" fill="${ring}"/><rect x="6" y="6" width="52" height="52" rx="9" fill="${TILE}"/>`;
  const ini = initialOf(identity.name);
  const ink = state === 'offline' ? GREY : '#fff';
  if (ini) {
    const rows = glyph5x7(ini);
    body += badge ? cells(rows, 10, 9, 4) : cells(rows, 17, 11, 6, ink);
  } else {
    // No Latin letter in the name: a plain block stands in for it.
    body += badge ? `<rect x="12" y="12" width="14" height="28" fill="#fff"/>` : `<rect x="23" y="14" width="18" height="36" fill="${ink}"/>`;
  }
  if (badge) {
    body += `<circle cx="42" cy="42" r="17" fill="${state === 'wait' ? RED : state === 'done' ? GREEN : '#101012'}" stroke="${TILE}" stroke-width="3"/>`;
    if (state === 'wait') {
      const n = String(Math.min(Math.max(Math.floor(count), 1), 99));
      body += n.length === 1 ? cells(DIGITS_5X7[n]!, 32, 28, 4) : cells(DIGITS_3X5[n[0]!]!, 28, 32, 4) + cells(DIGITS_3X5[n[1]!]!, 42, 32, 4);
    } else if (state === 'done') {
      body += cells(CHECK, 28, 32, 4);
    } else {
      body += `<circle cx="42" cy="42" r="10" fill="none" stroke="${AMBER}" stroke-width="6"/>`;
    }
  }
  if (elsewhere && state !== 'wait') body += `<circle cx="52" cy="12" r="9" fill="${RED}" stroke="${TILE}" stroke-width="3"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" shape-rendering="crispEdges">${body}</svg>`;
}

export const faviconHref = (svg: string): string => `data:image/svg+xml,${encodeURIComponent(svg)}`;

const GLYPH: Record<TabState, string> = { idle: '', run: '◐', done: '✓', wait: '!', offline: '⚠' };

/**
 * `base` is where the person is (a workspace's name); with none the title is just "ttym".
 * `instance` names this server when it has a name of its own, so tabs of several machines can be told apart.
 */
export function tabTitle({ base, state, count = 0, instance }: { base?: string; state: TabState; count?: number; instance?: string }): string {
  const glyph = GLYPH[state];
  let title = `${glyph ? `${glyph} ` : ''}${base || 'ttym'}`;
  if (state === 'wait') title += ` · ${count} 대기`;
  else if (state === 'offline') title += ' · 연결 끊김';
  if (instance) title += ` · ${instance}`;
  return title;
}

/** A block colour from config; anything that isn't a hex colour falls back to the brand's. */
export function parseAccent(value: string | undefined): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((value ?? '').trim());
  return m ? `#${m[1]!.toLowerCase()}` : BRAND_ACCENT;
}

export interface AgentActivity { kind: string | null; active: boolean; waiting?: string | null; sleep?: { state: string } | null }

/** How many panes wait for the person, and whether any agent is working; `scope` limits it to some sessions (a workspace's). */
export function summarizeAgents(states: Record<number, AgentActivity>, scope?: ReadonlySet<number> | null): { waiting: number; running: boolean } {
  let waiting = 0;
  let running = false;
  for (const [id, a] of Object.entries(states)) {
    if (!a?.kind || (scope && !scope.has(Number(id)))) continue;
    if (a.waiting) waiting++;
    else if (a.active && !a.sleep) running = true;
  }
  return { waiting, running };
}

/** The state that wins when several apply: a person is wanted first, then a result to look at, then work in progress. */
export function pickState({ connected, waiting, doneUnseen, running }: { connected: boolean; waiting: number; doneUnseen: boolean; running: boolean }): TabState {
  if (!connected) return 'offline';
  if (waiting > 0) return 'wait';
  if (doneUnseen) return 'done';
  if (running) return 'run';
  return 'idle';
}
