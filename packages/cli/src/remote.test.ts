import { describe, expect, it } from 'vitest';
import { baseUrlFor } from './remote.js';

describe('remote base URLs', () => {
  it('proxied names get https without a port; LAN addresses get http:port', () => {
    expect(baseUrlFor('box.tail1.ts.net', 7690)).toBe('https://box.tail1.ts.net');
    expect(baseUrlFor('ttym.example.com', 7690)).toBe('https://ttym.example.com');
    expect(baseUrlFor('192.168.0.10', 7690)).toBe('http://192.168.0.10:7690');
    expect(baseUrlFor('fe80::1', 7690)).toBe('http://[fe80::1]:7690');
    expect(baseUrlFor('studio.local', 7690)).toBe('http://studio.local:7690');
  });
});
