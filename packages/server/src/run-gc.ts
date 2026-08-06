import { readdir, stat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Sweep snapshot and meta files that belong to nobody.
 *
 * The runtime dir only ever accumulated: production carried 180 snapshots and
 * 241 metas for 15 live sessions — every session that ever existed left its
 * files behind. The b45f036e restore work deliberately kept unreferenced
 * snapshots "so manual recovery stays possible" and left the cleanup policy
 * open; this is that policy.
 *
 * A file is removed only when both are true: its session id is neither live
 * nor a workspace member, and the file has not been touched for `maxAgeMs`.
 * The age gate preserves the manual-recovery grace the original decision
 * wanted — a session dropped by mistake has two weeks of snapshot to come
 * back from, which is also exactly what a pre-A3 server needs after it
 * deleted checkpoints it should have kept.
 *
 * Scope is deliberately these two prefixes. Manifests and sockets belong to
 * recover(), which already sweeps the stale ones against a live pid check.
 */
export interface SweepResult {
  removed: string[];
  kept: number;
}

const SWEEPABLE = /^(snapshot|meta)-(\d+)\.json$/;

export async function sweepRuntimeDir(
  dir: string,
  keepIds: Set<number>,
  maxAgeMs: number,
): Promise<SweepResult> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return { removed: [], kept: 0 };
  }

  const cutoff = Date.now() - maxAgeMs;
  const removed: string[] = [];
  let kept = 0;

  for (const file of files) {
    const match = file.match(SWEEPABLE);
    if (!match) continue;
    const id = Number(match[2]);
    if (keepIds.has(id)) { kept++; continue; }

    try {
      const info = await stat(resolve(dir, file));
      if (info.mtimeMs > cutoff) { kept++; continue; }
      await unlink(resolve(dir, file));
      removed.push(file);
    } catch {
      // Raced with something else touching the file; leave it for next time.
    }
  }

  return { removed, kept };
}
