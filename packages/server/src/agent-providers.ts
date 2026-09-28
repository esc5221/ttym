/**
 * The provider layer, deliberately small. The review killed the paseo-style
 * five-event registry — with one user and two providers there is no common
 * contract to fix yet — but the if-branches scattered through the server had
 * a real defect: with both a claude and a codex session id in meta, every
 * branch picked claude, so a pane that moved from claude to codex kept being
 * treated (kind, extraction, dots) as claude forever.
 */

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

// ───── Transcript location (claude-code) ─────
//
// The screen is a rendering, not a record. Both agents keep the record as JSONL
// and name it in their Stop hook input (transcript_path); agent-turn.ts reads
// turns from it. This path is for hooks too old to send one.

/** Claude Code's project-dir encoding: every '/' and '.' becomes '-'. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

/** Claude Code가 이 세션의 대화를 쓰는 파일. */
export function claudeTranscriptPath(cwd: string, claudeSessionId: string, home = process.env.HOME ?? '/tmp'): string {
  return resolve(home, '.claude', 'projects', claudeProjectDirName(cwd), `${claudeSessionId}.jsonl`);
}

