/**
 * The file the user meant, when the path they gave does not exist.
 *
 * Every miss in the log so far had a correct tail and a wrong head — a
 * truncated `/turing/…` missing `/Users/x`, a report named without the
 * two folders it sits in. So the search is by suffix: files under a root
 * whose name matches exactly, ranked by how many trailing path segments
 * agree with what was asked. One clear winner opens; a tie is reported,
 * never guessed.
 *
 * Bounded on purpose. Depth, entry count and wall time all have caps, and
 * the usual bulk (node_modules, .git, caches) is skipped, so a cwd of `~`
 * costs a fraction of a second and never a hang.
 */
import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';

export interface NearestHit { path: string; score: number }
export type NearestResult =
  | { kind: 'hit'; path: string; score: number; root: string }
  | { kind: 'ambiguous'; candidates: string[]; root: string }
  | { kind: 'none'; root: string; capped: boolean };

export const NEAREST_MAX_DEPTH = 6;
export const NEAREST_MAX_ENTRIES = 20_000;
export const NEAREST_MAX_MS = 150;
const SKIP = new Set(['node_modules', '.git', '.cache', '__pycache__', '.venv', 'venv', '.Trash', 'Library', '.npm', '.pnpm-store', 'target', '.next', '.turbo']);

/** Names so common that the basename alone proves nothing; a parent must agree too. */
const GENERIC = new Set(['index.html', 'index.htm', 'index.js', 'index.ts', 'readme.md', 'readme', 'package.json', 'main.rs', 'main.py', 'main.go',
  'main.ts', 'main.js', 'app.js', 'app.ts', 'app.tsx', 'lib.rs', 'mod.rs', 'init.py', '__init__.py', 'makefile', 'dockerfile', 'cargo.toml',
  'tsconfig.json', 'config.json', 'settings.json', 'report.html', 'notes.md', 'todo.md', 'plan.md', 'test.ts', 'test.js', 'utils.ts', 'types.ts']);

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

/**
 * @param requested absolute path that failed realpath
 * @param cwd the pane's cwd — the fallback root, and the floor for how shallow a root may be
 */
export async function findNearest(requested: string, cwd: string | undefined, now = () => Date.now()): Promise<NearestResult> {
  const wanted = requested.split(sep).filter(Boolean);
  const name = wanted[wanted.length - 1];
  if (!name) return { kind: 'none', root: '/', capped: false };

  // Root: the existing head of the request, unless that is shallower than the cwd — then the cwd.
  const prefix = await existingPrefix(requested);
  const cwdDepth = cwd ? cwd.split(sep).filter(Boolean).length : 0;
  let root = prefix.dir;
  if (cwd && (prefix.depth < 2 || prefix.depth < cwdDepth) ) root = cwd;
  try { root = await realpath(root); } catch { return { kind: 'none', root, capped: false }; }

  const first = await searchUnder(root, wanted, name, now);
  if (first.kind !== 'none' || first.capped) return first;
  // Nothing below. Agents print repository-relative paths from deep cwds, so
  // climb to the repo root (the nearest ancestor with .git) and look once more.
  const repo = await repoRootAbove(root);
  if (!repo || repo === root) return first;
  const second = await searchUnder(repo, wanted, name, now);
  return second.kind === 'none' && !second.capped ? first : second;
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

async function searchUnder(root: string, wanted: string[], name: string, now: () => number): Promise<NearestResult> {
  const generic = GENERIC.has(name.toLowerCase());
  const minScore = generic ? 2 : 1;
  const started = now();
  let visited = 0;
  let capped = false;
  const hits: NearestHit[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length > 0) {
    if (now() - started > NEAREST_MAX_MS || visited > NEAREST_MAX_ENTRIES) { capped = true; break; }
    const { dir, depth } = queue.shift()!;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      visited++;
      const n = entry.name;
      if (entry.isDirectory()) {
        if (depth + 1 <= NEAREST_MAX_DEPTH && !n.startsWith('.') && !SKIP.has(n)) queue.push({ dir: join(dir, n), depth: depth + 1 });
        continue;
      }
      if (n !== name) continue;
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const path = join(dir, n);
      const score = suffixScore(path, wanted);
      if (score >= minScore) hits.push({ path, score });
    }
  }

  if (hits.length === 0) return { kind: 'none', root, capped };
  hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  const best = hits[0]!;
  const ties = hits.filter((h) => h.score === best.score);
  if (ties.length > 1) return { kind: 'ambiguous', candidates: ties.slice(0, 5).map((h) => h.path), root };
  return { kind: 'hit', path: best.path, score: best.score, root };
}

export function describeNearest(result: NearestResult, requested: string): string {
  switch (result.kind) {
    case 'hit': return `matched ${result.path} (asked for ${basename(requested)})`;
    case 'ambiguous': return `ambiguous — ${result.candidates.length} files named ${basename(requested)} under ${result.root}: ${result.candidates.join(', ')}`;
    case 'none': return result.capped ? `not found: ${requested} (search under ${result.root} capped)` : `not found: ${requested}`;
  }
}
