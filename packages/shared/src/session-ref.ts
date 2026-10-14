/**
 * 글자 속의 세션 참조(`%1297`, 다른 머신이면 `box%1297`). 터미널 링크와 reader가 같은 규칙을 쓰도록
 * 클라이언트 두 곳이 공유하는 여기에 둔다.
 */

/** `%1297`, 다른 머신이면 `box%1297`. 앞이 글자·%·/ 이면 아니다(`a%20b`, URL 인코딩).
 *  뒤가 글자면 아니다(`%10s` printf 서식). 이름이 알려진 머신이 아니면 링크가 아니다(provider에서 거른다). */
export const SESSION_REF = /(?<![\w%/-])(?:([A-Za-z][\w-]*))?%(\d{1,4})(?!\w)/g;

export interface SessionRefMatch {
  /** `text` 안의 UTF-16 위치. end는 마지막 글자 다음. */
  start: number;
  end: number;
  sessionId: number;
  host?: string;
}

/**
 * 글자 속의 세션 참조들. `hosts`가 없거나 모르는 이름의 `box%78`은 뺀다.
 */
export function matchSessionRefs(text: string, hosts?: ReadonlySet<string>): SessionRefMatch[] {
  const out: SessionRefMatch[] = [];
  for (const m of text.matchAll(SESSION_REF)) {
    const sessionId = parseInt(m[2], 10);
    if (!sessionId) continue;
    const host = m[1];
    if (host && !hosts?.has(host)) continue;
    out.push({ start: m.index!, end: m.index! + m[0].length, sessionId, host });
  }
  return out;
}
