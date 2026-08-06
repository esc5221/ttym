/**
 * Which session-meta keys the server owns.
 *
 * Meta began as one free-form map and protocol state moved in next to the
 * user's notes: the await handshake lived in `seq`/`stopSeq`, the agent
 * session mapping in the `claude*`/`codex*` family. Anyone could reset them
 * through the public PATCH — `ttym meta 42 --set seq=0` stalled an await
 * indefinitely (RFD 1 §2.3).
 *
 * Interactions took the handshake out of meta; what remains is the agent
 * mapping, written every turn by the hooks. These keys are runtime state: the
 * internal agent endpoint may write them, the public surface may not. This
 * rule is part of the wire contract — both the server (to enforce) and the
 * CLI (to route) need the same answer, which is why it lives here.
 *
 * `cwd` and the workspace-membership cache keys stay annotations on purpose:
 * they are display state the server refreshes on its own, and a stray write
 * to them breaks nothing but that user's display.
 */

const RUNTIME_EXACT = new Set(['seq', 'stopSeq', 'stopAt']);
const RUNTIME_PREFIXES = ['claude', 'codex'];

export function isRuntimeMetaKey(key: string): boolean {
  if (RUNTIME_EXACT.has(key)) return true;
  return RUNTIME_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Runtime keys found in a patch, so a rejection can name what it rejected. */
export function runtimeMetaKeys(patch: Record<string, unknown>): string[] {
  return Object.keys(patch).filter(isRuntimeMetaKey);
}

/** True when every key is runtime — what the internal endpoint requires. */
export function isRuntimeOnlyPatch(patch: Record<string, unknown>): boolean {
  const keys = Object.keys(patch);
  return keys.length > 0 && keys.every(isRuntimeMetaKey);
}
