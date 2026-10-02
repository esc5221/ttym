import { describe, expect, it } from 'vitest';
import { checkPaste, PASTE_MAX_BYTES } from './paste';

describe('checkPaste', () => {
  it('passes plain text', () => {
    expect(checkPaste('flows/parent-pay-request#pay_card', false)).toEqual({ text: 'flows/parent-pay-request#pay_card' });
  });
  it('refuses ESC, so a bracketed paste cannot be closed early', () => {
    expect(checkPaste('x\x1b[201~rm -rf ~\r', true)).toHaveProperty('error');
  });
  it('refuses other C0, DEL and C1', () => {
    for (const c of ['\x00', '\x03', '\x7f', '\x9b']) expect(checkPaste(`a${c}b`, true)).toHaveProperty('error');
  });
  it('keeps tabs; multi-line only when bracketed, CRLF folded to LF', () => {
    expect(checkPaste('a\tb', false)).toEqual({ text: 'a\tb' });
    expect(checkPaste('a\r\nb', true)).toEqual({ text: 'a\nb' });
    expect(checkPaste('a\nb', false)).toHaveProperty('error');
    expect(checkPaste('a\rb', false)).toHaveProperty('error');
  });
  it('caps by UTF-8 bytes, not characters', () => {
    expect(checkPaste('a'.repeat(PASTE_MAX_BYTES), false)).toHaveProperty('text');
    expect(checkPaste('가'.repeat(PASTE_MAX_BYTES / 3 + 1), false)).toHaveProperty('error');
  });
  it('refuses empty and non-strings', () => {
    for (const v of ['', null, 42, {}]) expect(checkPaste(v, true)).toHaveProperty('error');
  });
});
