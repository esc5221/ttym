import { describe, expect, it } from 'vitest';
import { isSearchKey } from './search-key.js';

const key = (over: Partial<Parameters<typeof isSearchKey>[0]> = {}) => ({ key: 'k', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over });

describe('isSearchKey', () => {
  it('is ⌘K on a Mac and nothing else', () => {
    expect(isSearchKey(key({ metaKey: true }), true)).toBe(true);
    expect(isSearchKey(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isSearchKey(key({ ctrlKey: true }), true)).toBe(false); // readline kill-line
    expect(isSearchKey(key(), true)).toBe(false);
  });

  it('is Ctrl+Shift+K elsewhere, never plain Ctrl+K', () => {
    expect(isSearchKey(key({ ctrlKey: true, shiftKey: true, key: 'K' }), false)).toBe(true);
    expect(isSearchKey(key({ ctrlKey: true }), false)).toBe(false);
    expect(isSearchKey(key({ metaKey: true }), false)).toBe(false);
    expect(isSearchKey(key({ ctrlKey: true, shiftKey: true, altKey: true }), false)).toBe(false);
  });
});
