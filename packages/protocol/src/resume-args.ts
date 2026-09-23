/**
 * Flags for resuming an agent, deduplicated.
 *
 * Sleep hands the running agent's argv back to wake, and the CLI adds the
 * configured resume flags on top. That argv already holds the previous
 * round's config flags, so without this every sleep/wake cycle appended one
 * more `--dangerously-skip-permissions` (seven seen on one pane). The server
 * (what it stores and types) and the CLI (what it runs) apply the same rule,
 * which is why it lives here.
 *
 * A flag is a `-x` token plus the values that follow it; two are the same
 * only when the values match too. The last copy is the one kept — keeping the
 * first would turn `--model a --model b --model a` into model b. Positional
 * tokens before any flag are never dropped.
 */
export function dedupeFlags(tokens: readonly string[]): string[] {
  const groups: string[][] = [];
  for (const t of tokens) {
    const last = groups[groups.length - 1];
    if (!t.startsWith('-') && last && last[0]!.startsWith('-')) last.push(t);
    else groups.push([t]);
  }
  const keys = groups.map((g) => g.join('\0'));
  return groups
    .filter((g, i) => !g[0]!.startsWith('-') || keys.lastIndexOf(keys[i]!) === i)
    .flat();
}
