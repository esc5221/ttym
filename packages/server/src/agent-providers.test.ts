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
