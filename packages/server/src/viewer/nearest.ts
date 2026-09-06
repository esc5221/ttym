/**
 * The file the user meant, when the path they gave does not exist.
 *
 * Every miss in the log so far had a correct tail and a wrong head — a
 * truncated `/turing/…` missing `/Users/x`, a report named without the
 * two folders it sits in, a Korean particle glued to the extension. So the
 * search is by suffix: entries under a root whose name matches exactly,
 * ranked by how many trailing path segments agree with what was asked.
 * One clear winner opens; a tie is reported, never guessed.
 *
 * Roots are tried in order and the first that answers wins: the existing
 * head of the request (when it is deeper than the cwd), the cwd, then the
 * repository root above it. A head that merely happens to exist —
 * `~/mainpy/output` when the file sits in `~/mainpy/sunken-garden/output` —
 * must not end the search.
 *
 * The walk is guided: a directory whose name is one of the requested
 * segments is visited before its siblings, and so is everything under it.
 * `…/playwright/x.png` reaches `sunken-garden/output/playwright/` ahead of
 * the 13k-file dump next door.
 *
 * Bounded on purpose. Depth, entry count and wall time all have caps, and
 * the usual bulk (node_modules, .git, caches) is skipped, so a cwd of `~`
 * costs a fraction of a second and never a hang. When a cap cuts the walk
 * short, Spotlight (`mdfind`, an index) is asked once for the same name
 * under the widest root and its answer goes through the same ranking.
 */
import { execFile } from 'node:child_process';
import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';

export interface NearestHit { path: string; score: number }
export type NearestResult =
  | { kind: 'hit'; path: string; score: number; root: string }
  | { kind: 'ambiguous'; candidates: string[]; root: string }
  | { kind: 'none'; root: string; capped: boolean };

export interface NearestOptions {
  now?: () => number;
  /** Indexed lookup used when the walk is capped: every path under `root` named exactly `name`. Default: mdfind. */
  locate?: (root: string, name: string) => Promise<string[]>;
  maxDepth?: number;
  maxEntries?: number;
  maxMs?: number;
}

export const NEAREST_MAX_DEPTH = 6;
export const NEAREST_MAX_ENTRIES = 20_000;
export const NEAREST_MAX_MS = 150;
const SKIP = new Set(['node_modules', '.git', '.cache', '__pycache__', '.venv', 'venv', '.Trash', 'Library', '.npm', '.pnpm-store', 'target', '.next', '.turbo']);

/** Names so common that the basename alone proves nothing; a parent must agree too. */
const GENERIC = new Set(['index.html', 'index.htm', 'index.js', 'index.ts', 'readme.md', 'readme', 'package.json', 'main.rs', 'main.py', 'main.go',
  'main.ts', 'main.js', 'app.js', 'app.ts', 'app.tsx', 'lib.rs', 'mod.rs', 'init.py', '__init__.py', 'makefile', 'dockerfile', 'cargo.toml',
  'tsconfig.json', 'config.json', 'settings.json', 'report.html', 'notes.md', 'todo.md', 'plan.md', 'test.ts', 'test.js', 'utils.ts', 'types.ts',
  'src', 'lib', 'dist', 'build', 'out', 'output', 'test', 'tests', 'docs', 'bin', 'scripts', 'assets', 'public', 'static', 'images', 'img']);

/**
 * `report.html에` → `report.html`: a Korean particle (에·을·를·에서·입니다…)
 * selected along with the path. Only one to three Hangul syllables right
 * after an extension are dropped — a path may carry Hangul anywhere else.
 */
export function stripTrailingParticle(path: string): string {
  return path.replace(/(\.[A-Za-z0-9]{1,8})[가-힣]{1,3}$/, '$1');
}

/** Longest existing directory prefix of `path`, and its depth. */
async function existingPrefix(path: string): Promise<{ dir: string; depth: number }> {
  let dir = dirname(path);
  for (;;) {
    try {
      if ((await stat(dir)).isDirectory()) return { dir, depth: dir.split(sep).filter(Boolean).length };
    } catch {}
    const up = dirname(dir);
    if (up === dir) return { dir, depth: 0 };
    dir = up;
  }
}

function suffixScore(candidate: string, wanted: string[]): number {
  const segs = candidate.split(sep).filter(Boolean);
  let n = 0;
  while (n < wanted.length && n < segs.length && segs[segs.length - 1 - n] === wanted[wanted.length - 1 - n]) n++;
  return n;
}

function rank(hits: NearestHit[], root: string, capped: boolean): NearestResult {
  if (hits.length === 0) return { kind: 'none', root, capped };
  hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  const best = hits[0]!;
  const ties = hits.filter((h) => h.score === best.score);
  if (ties.length > 1) return { kind: 'ambiguous', candidates: ties.slice(0, 5).map((h) => h.path), root };
  return { kind: 'hit', path: best.path, score: best.score, root };
}

/**
 * @param requested absolute path that failed realpath
 * @param cwd the pane's cwd — a fallback root, and the floor for how shallow a root may be
 */
export async function findNearest(requested: string, cwd: string | undefined, opts: NearestOptions = {}): Promise<NearestResult> {
  const wanted = requested.split(sep).filter(Boolean);
  const name = wanted[wanted.length - 1];
  if (!name) return { kind: 'none', root: '/', capped: false };

  // Roots, in order. The existing head of the request counts only when it is
  // deeper than the cwd; the cwd next; the repository root above it last.
  const roots: string[] = [];
  const push = async (dir: string | null) => {
    if (!dir) return;
    try { dir = await realpath(dir); } catch { return; }
    if (!roots.includes(dir)) roots.push(dir);
  };
  const prefix = await existingPrefix(requested);
  const cwdDepth = cwd ? cwd.split(sep).filter(Boolean).length : 0;
  if (prefix.depth >= 2 && (!cwd || prefix.depth > cwdDepth)) await push(prefix.dir);
  if (cwd) await push(cwd);
  // Agents print repository-relative paths from deep cwds: climb to the .git root too.
  await push(await repoRootAbove(cwd ?? prefix.dir));
  if (roots.length === 0) return { kind: 'none', root: prefix.dir, capped: false };

  let capped = false;
  for (const root of roots) {
    const r = await searchUnder(root, wanted, name, opts);
    if (r.kind !== 'none') return r;
    capped ||= r.capped;
  }
  const widest = roots[roots.length - 1]!;
  if (!capped) return { kind: 'none', root: widest, capped: false };

  // The walk did not finish. Ask the index for the same name under the widest root.
  const locate = opts.locate ?? mdfind;
  let found: string[];
  try { found = await locate(widest, name); } catch { found = []; }
  const generic = GENERIC.has(name.toLowerCase());
  const hits = found
    .filter((p) => basename(p) === name && !p.split(sep).some((seg) => SKIP.has(seg)))
    .map((p) => ({ path: p, score: suffixScore(p, wanted) }))
    .filter((h) => h.score >= (generic ? 2 : 1));
  return rank(hits, widest, true);
}

async function repoRootAbove(dir: string): Promise<string | null> {
  let cur = dir;
  for (let i = 0; i < 12; i++) {
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
    try { await stat(join(cur, '.git')); return cur; } catch {}
  }
  return null;
}

async function searchUnder(root: string, wanted: string[], name: string, opts: NearestOptions): Promise<NearestResult> {
  const now = opts.now ?? (() => Date.now());
  const maxDepth = opts.maxDepth ?? NEAREST_MAX_DEPTH;
  const maxEntries = opts.maxEntries ?? NEAREST_MAX_ENTRIES;
  const maxMs = opts.maxMs ?? NEAREST_MAX_MS;
  const generic = GENERIC.has(name.toLowerCase());
  const minScore = generic ? 2 : 1;
  // Segment names from the request (not the leaf): directories called this go first.
  const guide = new Set(wanted.slice(0, -1));
  const started = now();
  let visited = 0;
  let capped = false;
  const hits: NearestHit[] = [];
  // Two lanes: guided directories (and their subtrees) drain before the rest.
  const fast: Array<{ dir: string; depth: number }> = [];
  const slow: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (fast.length > 0 || slow.length > 0) {
    if (now() - started > maxMs || visited > maxEntries) { capped = true; break; }
    const guided = fast.length > 0;
    const { dir, depth } = (guided ? fast.shift() : slow.shift())!;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      visited++;
      const n = entry.name;
      const isDir = entry.isDirectory();
      if (n === name && (isDir || entry.isFile() || entry.isSymbolicLink())) {
        const path = join(dir, n);
        const score = suffixScore(path, wanted);
        if (score >= minScore) hits.push({ path, score });
      }
      if (isDir && depth + 1 <= maxDepth && !n.startsWith('.') && !SKIP.has(n)) {
        (guided || guide.has(n) ? fast : slow).push({ dir: join(dir, n), depth: depth + 1 });
      }
    }
  }
  return rank(hits, root, capped);
}

/** Spotlight, macOS only: exact-name lookup from the index. Resolves to [] where there is no mdfind. */
function mdfind(root: string, name: string): Promise<string[]> {
  if (process.platform !== 'darwin') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('mdfind', ['-onlyin', root, '-name', name], { timeout: 1500, maxBuffer: 1 << 20 }, (err, stdout) => {
      resolve(err ? [] : stdout.split('\n').filter(Boolean));
    });
  });
}

export function describeNearest(result: NearestResult, requested: string): string {
  switch (result.kind) {
    case 'hit': return `matched ${result.path} (asked for ${basename(requested)})`;
    case 'ambiguous': return `ambiguous — ${result.candidates.length} named ${basename(requested)} under ${result.root}: ${result.candidates.join(', ')}`;
    case 'none': return result.capped ? `not found: ${requested} (search under ${result.root} capped)` : `not found: ${requested}`;
  }
}
