import { describe, expect, it } from 'vitest';
import headless from '@xterm/headless';
import { screenTail } from './screen-tail.js';

async function term(text: string, cols = 40, rows = 10) {
  const t = new headless.Terminal({ cols, rows, allowProposedApi: true });
  await new Promise<void>((r) => t.write(text, () => r()));
  return t;
}
const plain = (rows: { t: string }[][]) => rows.map((r) => r.map((x) => x.t).join(''));

describe('screenTail', () => {
  it('cuts from the last line that has content, not the bottom of the screen', async () => {
    const t = await term('a\r\nb\r\nc\r\nd');
    expect(plain(screenTail(t, 2))).toEqual(['c', 'd']);
  });

  it('keeps colors and groups cells of the same style', async () => {
    const t = await term('\x1b[31mred\x1b[0m plain \x1b[38;2;1;2;3mrgb\x1b[1;7m!');
    expect(screenTail(t, 1)[0]).toEqual([
      { t: 'red', fg: 'p1' },
      { t: ' plain ' },
      { t: 'rgb', fg: '#010203' },
      { t: '!', fg: 'inv-bg', bg: '#010203', b: 1 },
    ]);
  });

  it('writes a wide character once, not once per cell', async () => {
    const t = await term('한글 %12');
    expect(plain(screenTail(t, 1))).toEqual(['한글 %12']);
  });

  it('returns nothing for an empty screen', async () => {
    expect(screenTail(await term(''), 5)).toEqual([]);
  });
});
