import { describe, expect, it } from 'vitest';
import { ansiToHtml, stripAnsi } from './ansi.js';

describe('ansiToHtml', () => {
  it('renders SGR colors and resets to the caller default', () => {
    const html = ansiToHtml('\u001b[31mred\u001b[0mplain', { defaultFg: '#abc' });
    expect(html).toContain('color:#cd3131');
    expect(html).toContain('red');
    expect(html.split('plain')[0]).toContain('#cd3131');
    expect(html).toContain('color:#abc');
  });

  it('escapes HTML and honours cursor-forward as spaces', () => {
    const html = ansiToHtml('<a>\u001b[3Cb');
    expect(html).toContain('&lt;a&gt;');
    expect(html).toContain('   b');
  });

  it('drops unknown escapes without leaking them into text', () => {
    const html = ansiToHtml('\u001b[?2026hok\u001b[?2026l');
    expect(html).toContain('ok');
    expect(html).not.toContain('2026');
  });
});

describe('stripAnsi', () => {
  it('removes CSI and simple escapes', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m \u001bMx')).toBe('red x');
  });
});
