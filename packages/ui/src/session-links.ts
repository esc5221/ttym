import type { IBufferLine, ILink, ILinkProvider, Terminal as XTerm } from '@xterm/xterm';

/**
 * 터미널 글자 속의 `%1297`을 그 세션으로 가는 링크로 만든다.
 *
 * 세션 번호는 `%1297`로 적는다(CLI 주소와 같은 꼴, 4자리 이하). 에이전트가 다른 pane을
 * 언급하면 그 자리에서 눌러 열 수 있어야 한다. 무엇을 여는지는 앱이 정한다 — 이 패키지는
 * 앱의 라우트를 모른다. 핸들러가 없으면 링크를 만들지 않는다.
 */

/** `%1297`, 다른 머신이면 `box%1297`. 앞이 글자·%·/ 이면 아니다(`a%20b`, URL 인코딩).
 *  뒤가 글자면 아니다(`%10s` printf 서식). 이름이 알려진 머신이 아니면 링크가 아니다(provider에서 거른다). */
export const SESSION_REF = /(?<![\w%/-])(?:([A-Za-z][\w-]*))?%(\d{1,4})(?!\w)/g;

export interface SessionLinkHandler {
  /** `host`는 다른 머신의 세션일 때만 있다. */
  open(sessionId: number, event: MouseEvent, host?: string): void;
  /** 마우스가 링크 위에 올라왔다 — 미리보기를 띄울 자리. */
  hover?(sessionId: number, event: MouseEvent, host?: string): void;
  leave?(sessionId: number, event: MouseEvent, host?: string): void;
  /** 링크로 쳐 줄 다른 머신 이름. 비어 있으면 `box%78`은 링크가 아니다. */
  hosts?(): ReadonlySet<string>;
}

let handler: SessionLinkHandler | null = null;

export function setSessionLinkHandler(next: SessionLinkHandler | null): void {
  handler = next;
}

/** 줄 문자열의 각 UTF-16 위치가 몇 번째 칸(0부터)인지. 한글처럼 두 칸짜리 글자가 있으면
 *  문자열 위치와 칸 위치가 어긋나므로, 셀을 따라가며 직접 센다. */
export function columnsOf(line: IBufferLine, cols: number): { text: string; col: number[] } {
  let text = '';
  const col: number[] = [];
  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x);
    if (!cell) break;
    if (cell.getWidth() === 0) continue; // 두 칸 글자의 뒤 칸
    const chars = cell.getChars() || ' ';
    for (let i = 0; i < chars.length; i++) col.push(x);
    text += chars;
  }
  return { text, col };
}

export function sessionLinkProvider(term: XTerm): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const line = handler ? term.buffer.active.getLine(y - 1) : undefined;
      if (!line) { callback(undefined); return; }
      const { text, col } = columnsOf(line, term.cols);
      const links: ILink[] = [];
      for (const m of text.matchAll(SESSION_REF)) {
        const start = m.index!;
        const end = start + m[0].length - 1;
        const host = m[1];
        const sessionId = parseInt(m[2], 10);
        if (!sessionId) continue;
        if (host && !handler?.hosts?.().has(host)) continue;
        links.push({
          range: { start: { x: col[start] + 1, y }, end: { x: col[end] + 1, y } },
          text: m[0],
          decorations: { underline: true, pointerCursor: true },
          activate: (event) => handler?.open(sessionId, event, host),
          hover: (event) => handler?.hover?.(sessionId, event, host),
          leave: (event) => handler?.leave?.(sessionId, event, host),
        });
      }
      callback(links.length ? links : undefined);
    },
  };
}
