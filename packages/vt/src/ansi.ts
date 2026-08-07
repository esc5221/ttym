/**
 * ANSI helpers for HTML previews — the read-only screen renderings that do
 * not warrant an xterm instance (dashboard hover previews, cards). One
 * implementation; the two apps used to carry a diverged copy each.
 */

export function xterm256Color(code: number, defaultFg = '#d4d4d4'): string {
  if (code < 16) {
    const base = [
      '#000000', '#cd3131', '#0dbc79', '#e5e510',
      '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
      '#666666', '#f14c4c', '#23d18b', '#f5f543',
      '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
    ];
    return base[code] ?? defaultFg;
  }
  if (code >= 16 && code <= 231) {
    const n = code - 16;
    const r = Math.floor(n / 36);
    const g = Math.floor((n % 36) / 6);
    const b = n % 6;
    const channel = [0, 95, 135, 175, 215, 255];
    return `rgb(${channel[r]}, ${channel[g]}, ${channel[b]})`;
  }
  const gray = 8 + (code - 232) * 10;
  return `rgb(${gray}, ${gray}, ${gray})`;
}

export function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[@-Z\\-_]/g, '');
}

export interface AnsiToHtmlOptions {
  /** Foreground used before any SGR and after a reset. */
  defaultFg?: string;
}

export function ansiToHtml(value: string, options: AnsiToHtmlOptions = {}): string {
  const defaultFg = options.defaultFg ?? '#d4d4d4';
  let result = '';
  let index = 0;
  let column = 0;
  let fg = defaultFg;
  let bg = 'transparent';
  let bold = false;
  let open = false;

  const close = () => {
    if (open) {
      result += '</span>';
      open = false;
    }
  };

  const openSpan = () => {
    close();
    result += `<span style="color:${fg};background:${bg};font-weight:${bold ? 600 : 400}">`;
    open = true;
  };

  openSpan();

  while (index < value.length) {
    const char = value[index];
    if (char === '\u001b') {
      const cursorForward = /^\u001b\[([0-9]*)C/.exec(value.slice(index));
      if (cursorForward) {
        const amount = Number(cursorForward[1] || '1');
        result += ' '.repeat(Math.max(0, amount));
        column += Math.max(0, amount);
        index += cursorForward[0].length;
        continue;
      }

      const cursorBackward = /^\u001b\[([0-9]*)D/.exec(value.slice(index));
      if (cursorBackward) {
        const amount = Number(cursorBackward[1] || '1');
        column = Math.max(0, column - Math.max(0, amount));
        index += cursorBackward[0].length;
        continue;
      }

      const cursorAbsolute = /^\u001b\[([0-9]*)G/.exec(value.slice(index));
      if (cursorAbsolute) {
        const target = Math.max(0, Number(cursorAbsolute[1] || '1') - 1);
        if (target > column) result += ' '.repeat(target - column);
        column = target;
        index += cursorAbsolute[0].length;
        continue;
      }

      const sgr = /^\u001b\[([0-9;]*)m/.exec(value.slice(index));
      if (sgr) {
        const codes = sgr[1].split(';').filter(Boolean).map((code) => Number(code));
        if (codes.length === 0) codes.push(0);
        for (let i = 0; i < codes.length; i += 1) {
          const code = codes[i];
          if (code === 0) {
            fg = defaultFg;
            bg = 'transparent';
            bold = false;
          } else if (code === 1) {
            bold = true;
          } else if (code === 22) {
            bold = false;
          } else if (code === 39) {
            fg = defaultFg;
          } else if (code === 49) {
            bg = 'transparent';
          } else if (code >= 30 && code <= 37) {
            fg = xterm256Color(code - 30, defaultFg);
          } else if (code >= 90 && code <= 97) {
            fg = xterm256Color(code - 82, defaultFg);
          } else if (code >= 40 && code <= 47) {
            bg = xterm256Color(code - 40, defaultFg);
          } else if (code >= 100 && code <= 107) {
            bg = xterm256Color(code - 92, defaultFg);
          } else if (code === 38 && codes[i + 1] === 5 && typeof codes[i + 2] === 'number') {
            fg = xterm256Color(codes[i + 2], defaultFg);
            i += 2;
          } else if (code === 48 && codes[i + 1] === 5 && typeof codes[i + 2] === 'number') {
            bg = xterm256Color(codes[i + 2], defaultFg);
            i += 2;
          }
        }
        openSpan();
        index += sgr[0].length;
        continue;
      }

      const otherEscape = /^\u001b(?:[@-Z\\-_]|\[[0-9;?]*[ -/]*[@-~])/.exec(value.slice(index));
      if (otherEscape) {
        index += otherEscape[0].length;
        continue;
      }
    }

    if (char === '&') result += '&amp;';
    else if (char === '<') result += '&lt;';
    else if (char === '>') result += '&gt;';
    else if (char === '\n') {
      result += '\n';
      column = 0;
    } else if (char !== '\r') {
      result += char;
      column += 1;
    }
    index += 1;
  }

  close();
  return result;
}
