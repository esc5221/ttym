/**
 * The provider layer, deliberately small. The review killed the paseo-style
 * five-event registry — with one user and two providers there is no common
 * contract to fix yet — but the if-branches scattered through the server had
 * a real defect: with both a claude and a codex session id in meta, every
 * branch picked claude, so a pane that moved from claude to codex kept being
 * treated (kind, extraction, dots) as claude forever.
 */

import { open } from 'node:fs/promises';
import { resolve } from 'node:path';

export type AgentKind = 'claude-code' | 'codex';

export interface AgentProviderAdapter {
  id: AgentKind;
  /** Runtime-meta key prefix — the same one @ttym/protocol treats as server-owned. */
  metaPrefix: 'claude' | 'codex';
}

export const AGENT_PROVIDERS: AgentProviderAdapter[] = [
  { id: 'claude-code', metaPrefix: 'claude' },
  { id: 'codex', metaPrefix: 'codex' },
];

/**
 * Which provider a session currently belongs to. Linkage first; if both
 * providers are linked, the active one wins, then the most recently started.
 * A provider that never stamps *LastStartedAt loses ties — which reproduces
 * the old claude-first behavior exactly when no better signal exists.
 */
export function agentKindOf(meta: Record<string, unknown>): AgentKind | null {
  const claudeLinked = Boolean(meta.claudeSessionId || meta.claudeLastSessionId);
  const codexLinked = Boolean(meta.codexSessionId || meta.codexLastSessionId);
  if (!claudeLinked && !codexLinked) return null;
  if (claudeLinked !== codexLinked) return claudeLinked ? 'claude-code' : 'codex';

  const claudeActive = meta.claudeActive === true;
  const codexActive = meta.codexActive === true;
  if (claudeActive !== codexActive) return claudeActive ? 'claude-code' : 'codex';

  const claudeAt = Date.parse(String(meta.claudeLastStartedAt ?? '')) || 0;
  const codexAt = Date.parse(String(meta.codexLastStartedAt ?? '')) || 0;
  return codexAt > claudeAt ? 'codex' : 'claude-code';
}

// ───── Structured transcript (claude-code) ─────
//
// The screen is a rendering, not a record: extracting "this turn's answer"
// from marker-to-cursor rows drags in whatever the TUI painted after the
// answer — the next prompt box, footers, spinners. Claude Code keeps the
// actual record at ~/.claude/projects/<encoded cwd>/<sessionId>.jsonl and the
// hooks already link that session id to the ttym session, so the extractor
// reads the answer from the source. The screen path stays as the fallback,
// marked as such. Codex has no known structured store — it stays on screen
// extraction (reviewed decision).

/** Claude Code's project-dir encoding: every '/' and '.' becomes '-'. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

/** Read at most `bytes` from the end of a file. */
async function readTail(path: string, bytes: number): Promise<string> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    // Drop a partial first line when we started mid-file.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await fh.close();
  }
}

export interface StructuredTranscriptOpts {
  cwd: string;
  claudeSessionId: string;
  /** Only messages at/after this time count — earlier ones are previous turns. */
  sinceMs: number;
  home?: string;
  /** Retries for the file lagging the Stop hook; 0 in tests. */
  retries?: number;
}

/**
 * The last assistant message of this turn that actually says something —
 * tool_use-only messages are intermediate steps, not the answer.
 * Returns null when the file, session or a fresh-enough message is missing;
 * callers fall back to screen extraction.
 */
export async function claudeStructuredTranscript(opts: StructuredTranscriptOpts): Promise<string | null> {
  const home = opts.home ?? process.env.HOME ?? '/tmp';
  const path = resolve(home, '.claude', 'projects', claudeProjectDirName(opts.cwd), `${opts.claudeSessionId}.jsonl`);
  const retries = opts.retries ?? 3;
  // Small clock slack: the hook's timestamp and ours come from the same
  // machine, but the interaction is created just before the prompt lands.
  const cutoff = opts.sinceMs - 2_000;

  for (let attempt = 0; ; attempt++) {
    try {
      const tail = await readTail(path, 2 * 1024 * 1024);
      const lines = tail.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        let entry: { type?: string; timestamp?: string; message?: { content?: unknown } };
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.type !== 'assistant') continue;
        const at = Date.parse(entry.timestamp ?? '');
        if (Number.isFinite(at) && at < cutoff) break; // 이전 턴 영역 — 더 볼 것 없다
        const content = entry.message?.content;
        if (!Array.isArray(content)) continue;
        const text = content
          .filter((b): b is { type: string; text: string } =>
            typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        if (text.length > 0) return text;
      }
    } catch { /* 파일 부재/일시 오류 — 재시도 or null */ }
    if (attempt >= retries) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}
