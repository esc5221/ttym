import type { IBufferCell, Terminal } from '@xterm/headless';
import type { ScreenRun } from '@ttym/protocol';

/**
 * 보이는 화면에서 내용이 있는 마지막 줄부터 위로 `max`줄을, 같은 모양끼리 묶은 글자 덩어리로.
 *
 * serialize()를 쓰지 않는 이유: 그 출력은 다시 터미널에 써 넣으려는 것이라 빈칸을 커서 이동으로
 * 줄이고 모드 전환을 섞는다. 미리보기는 HTML로 그리므로 칸 그대로의 글자와 색이 필요하다.
 */
export function screenTail(term: Pick<Terminal, 'rows' | 'cols' | 'buffer'>, max: number): ScreenRun[][] {
  const buf = term.buffer.active;
  const lines = [];
  for (let i = 0; i < term.rows; i++) lines.push(buf.getLine(buf.viewportY + i));
  let last = lines.length - 1;
  while (last >= 0 && !(lines[last]?.translateToString(true).trim())) last--;
  if (last < 0) return [];

  const out: ScreenRun[][] = [];
  const cell = buf.getNullCell();
  for (let y = Math.max(0, last - max + 1); y <= last; y++) {
    const line = lines[y];
    const runs: ScreenRun[] = [];
    if (line) {
      for (let x = 0; x < term.cols; x++) {
        if (!line.getCell(x, cell)) break;
        if (cell.getWidth() === 0) continue; // 두 칸 글자의 뒤 칸
        const style = styleOf(cell);
        const prev = runs[runs.length - 1];
        const t = cell.getChars() || ' ';
        if (prev && sameStyle(prev, style)) prev.t += t;
        else runs.push({ t, ...style });
      }
      // 줄 끝의 배경 없는 빈칸은 버린다
      while (runs.length) {
        const r = runs[runs.length - 1]!;
        if (r.bg) break;
        r.t = r.t.replace(/ +$/, '');
        if (r.t) break;
        runs.pop();
      }
    }
    out.push(runs);
  }
  return out;
}

type Style = Omit<ScreenRun, 't'>;

function styleOf(c: IBufferCell): Style {
  const s: Style = {};
  let fg = color(c.isFgRGB(), c.isFgPalette(), c.getFgColor());
  let bg = color(c.isBgRGB(), c.isBgPalette(), c.getBgColor());
  if (c.isInverse()) { const f = fg; fg = bg ?? 'inv-bg'; bg = f ?? 'inv-fg'; }
  if (fg) s.fg = fg;
  if (bg) s.bg = bg;
  if (c.isBold()) s.b = 1;
  if (c.isItalic()) s.i = 1;
  if (c.isUnderline()) s.u = 1;
  if (c.isDim()) s.d = 1;
  return s;
}

function color(rgb: boolean, palette: boolean, v: number): string | undefined {
  if (rgb) return `#${v.toString(16).padStart(6, '0')}`;
  if (palette) return `p${v}`;
  return undefined;
}

function sameStyle(a: Style, b: Style): boolean {
  return a.fg === b.fg && a.bg === b.bg && a.b === b.b && a.i === b.i && a.u === b.u && a.d === b.d;
}
