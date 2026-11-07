import { describe, expect, it } from 'vitest';
import { applyCompletion, keyToBytes, menuToken, type KeyLike } from './composer-keys.js';

const k = (key: string, code: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

describe('keyToBytes', () => {
  it('sends what a terminal sends', () => {
    expect(keyToBytes(k('Tab', 'Tab', { shiftKey: true }))).toBe('\x1b[Z');
    expect(keyToBytes(k('Escape', 'Escape'))).toBe('\x1b');
    expect(keyToBytes(k('ArrowUp', 'ArrowUp'))).toBe('\x1b[A');
    expect(keyToBytes(k('s', 'KeyS', { ctrlKey: true }))).toBe('\x13');
    expect(keyToBytes(k('x', 'KeyX', { ctrlKey: true }))).toBe('\x18');
    expect(keyToBytes(k('_', 'Minus', { ctrlKey: true, shiftKey: true }))).toBe('\x1f');
    expect(keyToBytes(k(']', 'BracketRight', { ctrlKey: true }))).toBe('\x1d');
  });
  it('reads Option+letter on a Mac as Meta+letter, not the symbol it types', () => {
    expect(keyToBytes(k('π', 'KeyP', { altKey: true }))).toBe('\x1bp');
    expect(keyToBytes(k('†', 'KeyT', { altKey: true }))).toBe('\x1bt');
  });
  it('sends nothing for Cmd chords', () => {
    expect(keyToBytes(k('k', 'KeyK', { metaKey: true }))).toBeNull();
  });
});

describe('menuToken', () => {
  it('finds a / command at the start or after a space, not inside a path', () => {
    expect(menuToken('/comp', 5)).toEqual({ kind: 'command', start: 0, query: 'comp' });
    expect(menuToken('see /comp', 9)).toEqual({ kind: 'command', start: 4, query: 'comp' });
    expect(menuToken('line one\n/re', 12)).toEqual({ kind: 'command', start: 9, query: 're' });
    expect(menuToken('/compact now', 12)).toBeNull();
    expect(menuToken('open src/comp', 13)).toBeNull();
    expect(menuToken('at /tmp/x', 9)).toBeNull();
  });
  it('finds an @ path anywhere after a space', () => {
    expect(menuToken('look at @src/al', 15)).toEqual({ kind: 'file', start: 8, query: 'src/al' });
    expect(menuToken('mail@host', 9)).toBeNull();
  });
});

describe('applyCompletion', () => {
  it('replaces the token and the rest of its word', () => {
    const t = menuToken('look at @src/al and', 15)!;
    expect(applyCompletion('look at @src/alpha and', t, '@src/alpha.ts ')).toEqual({ text: 'look at @src/alpha.ts and', caret: 22 });
  });
});
