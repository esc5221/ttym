import { describe, expect, it } from 'vitest';
import { agentKindOf } from './agent-providers.js';

describe('agentKindOf — provider attribution', () => {
  it('single linkage wins outright', () => {
    expect(agentKindOf({})).toBe(null);
    expect(agentKindOf({ claudeLastSessionId: 'a' })).toBe('claude-code');
    expect(agentKindOf({ codexSessionId: 'x' })).toBe('codex');
  });

  it('with both linked, the active provider wins — codex is no longer shadowed', () => {
    // 예전 결함: 두 id가 공존하면 무조건 claude — codex로 갈아탄 pane이
    // 영원히 claude로 표시·추출됐다.
    expect(agentKindOf({
      claudeLastSessionId: 'a', codexSessionId: 'x', codexActive: true,
    })).toBe('codex');
  });

  it('with both idle, the most recently started wins; no signal keeps the old claude-first behavior', () => {
    expect(agentKindOf({
      claudeLastSessionId: 'a', claudeLastStartedAt: '2026-08-01T00:00:00Z',
      codexLastSessionId: 'x', codexLastStartedAt: '2026-08-10T00:00:00Z',
    })).toBe('codex');
    expect(agentKindOf({ claudeLastSessionId: 'a', codexLastSessionId: 'x' })).toBe('claude-code');
  });
});

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeProjectDirName, claudeStructuredTranscript } from './agent-providers.js';

describe('claude structured transcript', () => {
  it('encodes the project dir the way claude does — dots included', () => {
    expect(claudeProjectDirName('/Users/x/study/ttym')).toBe('-Users-x-study-ttym');
    expect(claudeProjectDirName('/Users/x/.clawteam/ws')).toBe('-Users-x--clawteam-ws');
  });

  it('returns the last text-bearing assistant message of this turn only', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ttym-claude-home-'));
    try {
      const cwd = '/Users/x/proj';
      const dir = join(home, '.claude', 'projects', claudeProjectDirName(cwd));
      mkdirSync(dir, { recursive: true });
      const t = (ms: number) => new Date(ms).toISOString();
      const NOW = 1_800_000_000_000;
      writeFileSync(join(dir, 'sess-1.jsonl'), [
        // 이전 턴의 답 — sinceMs 이전이라 제외돼야 한다
        JSON.stringify({ type: 'assistant', timestamp: t(NOW - 60_000), message: { content: [{ type: 'text', text: 'OLD ANSWER' }] } }),
        JSON.stringify({ type: 'user', timestamp: t(NOW), message: { content: 'q' } }),
        // 중간 단계: tool_use만 — 답이 아니다
        JSON.stringify({ type: 'assistant', timestamp: t(NOW + 1_000), message: { content: [{ type: 'tool_use', id: 'x' }] } }),
        JSON.stringify({ type: 'assistant', timestamp: t(NOW + 2_000), message: { content: [{ type: 'text', text: 'REAL ANSWER' }, { type: 'text', text: 'SECOND BLOCK' }] } }),
      ].join('\n') + '\n');

      const got = await claudeStructuredTranscript({
        cwd, claudeSessionId: 'sess-1', sinceMs: NOW, home, retries: 0,
      });
      expect(got).toBe('REAL ANSWER\nSECOND BLOCK');

      // 이 턴에 텍스트 답이 없으면 null → 화면 폴백
      const none = await claudeStructuredTranscript({
        cwd, claudeSessionId: 'sess-1', sinceMs: NOW + 10_000, home, retries: 0,
      });
      expect(none).toBeNull();

      // 파일 부재 → null
      const missing = await claudeStructuredTranscript({
        cwd, claudeSessionId: 'nope', sinceMs: NOW, home, retries: 0,
      });
      expect(missing).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
