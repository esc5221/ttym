import { describe, expect, it } from 'vitest';
import { isReaderToggleKey } from './toggle-key.js';

const key = (o: Partial<Record<'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean | string>>) =>
  ({ key: ',', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o }) as Parameters<typeof isReaderToggleKey>[0];

describe('isReaderToggleKey', () => {
  it('is ⌘, on a Mac and not Ctrl+,', () => {
    expect(isReaderToggleKey(key({ metaKey: true }), true)).toBe(true);
    expect(isReaderToggleKey(key({ ctrlKey: true }), true)).toBe(false);
  });
  it('is Ctrl+, elsewhere and not the Windows key', () => {
    expect(isReaderToggleKey(key({ ctrlKey: true }), false)).toBe(true);
    expect(isReaderToggleKey(key({ metaKey: true }), false)).toBe(false);
  });
  it('ignores other keys and extra modifiers', () => {
    expect(isReaderToggleKey(key({ metaKey: true, key: '.' }), true)).toBe(false);
    expect(isReaderToggleKey(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isReaderToggleKey(key({ ctrlKey: true, altKey: true }), false)).toBe(false);
    expect(isReaderToggleKey(key({}), true)).toBe(false);
  });
});
