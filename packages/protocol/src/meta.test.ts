import { describe, expect, it } from 'vitest';
import { isRuntimeMetaKey, runtimeMetaKeys, isRuntimeOnlyPatch } from './meta.js';

describe('meta ownership', () => {
  it('claims the agent mapping and the legacy handshake', () => {
    for (const key of [
      'claudeSessionId', 'claudeActive', 'claudeLastStoppedAt', 'claudeSessionSource',
      'codexSessionId', 'codexLastSessionId',
      'seq', 'stopSeq', 'stopAt',
    ]) {
      expect(isRuntimeMetaKey(key), key).toBe(true);
    }
  });

  it('leaves annotations and display state to the user', () => {
    for (const key of ['cwd', 'project', 'workspaceId', 'workspaceName', 'memberName', 'ticket', 'owner', 'note']) {
      expect(isRuntimeMetaKey(key), key).toBe(false);
    }
  });

  it('names the offending keys in a mixed patch', () => {
    expect(runtimeMetaKeys({ note: 'x', stopSeq: '3', claudeActive: true }))
      .toEqual(['stopSeq', 'claudeActive']);
  });

  it('requires a non-empty all-runtime patch for the internal path', () => {
    expect(isRuntimeOnlyPatch({ claudeSessionId: 'a', stopAt: 1 })).toBe(true);
    expect(isRuntimeOnlyPatch({ claudeSessionId: 'a', note: 'x' })).toBe(false);
    expect(isRuntimeOnlyPatch({})).toBe(false);
  });
});
