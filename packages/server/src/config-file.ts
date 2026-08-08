import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

/**
 * ~/.ttym/config — flat `key = value`, `#` comments, nothing else. The
 * ghostty model: no sections, no nesting, keys map 1:1 to CLI flags and
 * settings entries. The server owns the file; clients read and patch it over
 * HTTP so every surface (web, desktop, every window) shares one truth.
 *
 * Updates rewrite the file but keep what a human put there: comments and
 * unknown lines survive, existing keys are edited in place, new keys append.
 */

export type ConfigValues = Record<string, string>;

export function parseConfig(text: string): ConfigValues {
  const values: ConfigValues = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key) values[key] = value;
  }
  return values;
}

/** Apply a patch to the file text, preserving comments and layout. */
export function updateConfigText(text: string, patch: Record<string, string | null>): string {
  const lines = text.length > 0 ? text.split('\n') : [];
  const pending = new Map(Object.entries(patch));

  const next = lines.map((rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return rawLine;
    const eq = line.indexOf('=');
    if (eq === -1) return rawLine;
    const key = line.slice(0, eq).trim();
    if (!pending.has(key)) return rawLine;
    const value = pending.get(key)!;
    pending.delete(key);
    return value === null ? null : `${key} = ${value}`;
  }).filter((line): line is string => line !== null);

  // Exactly one trailing newline; trim before appending so new keys join
  // the block instead of landing after a stray blank line.
  while (next.length > 0 && next[next.length - 1] === '') next.pop();

  for (const [key, value] of pending) {
    if (value !== null) next.push(`${key} = ${value}`);
  }
  return next.length > 0 ? next.join('\n') + '\n' : '';
}

export class ConfigStore {
  private values: ConfigValues = {};
  private text = '';

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      this.text = await readFile(this.path, 'utf8');
    } catch {
      this.text = '';
    }
    this.values = parseConfig(this.text);
  }

  get(): ConfigValues {
    return { ...this.values };
  }

  /** null deletes a key. Returns the merged values after persisting. */
  async patch(patch: Record<string, string | null>): Promise<ConfigValues> {
    this.text = updateConfigText(this.text, patch);
    this.values = parseConfig(this.text);
    const tmp = `${this.path}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, this.text);
    await rename(tmp, this.path);
    return this.get();
  }
}
