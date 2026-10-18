/**
 * 세션 검색의 문서와 글자 겹침 점수.
 *
 * 문서 = workspace 이름 / 요약 제목 / 요약 한 줄 || 사용자가 보낸 프롬프트 앞부분.
 * 프롬프트를 넣은 이유는 측정에서 나왔다: 제목·노트만으로 내용 질의 13개 중 1개가 1위였고,
 * 프롬프트 앞 2개(120자씩)를 붙이니 13개 모두 1위였다(요약이 없는 새 세션도 찾는다).
 */

export interface SessionDoc {
  id: number;
  workspaceId: string | null;
  workspace: string;
  member: string;
  stream: string | null;
  title: string;
  note: string;
  prompts: string[];
}

const PROMPT_MIN = 15;
const PROMPT_CHARS = 120;
const PROMPT_COUNT = 2;

/** 리더 피드의 업데이트 중 사용자가 보낸 말만, 오래된 것부터. */
export function userTextsOf(updates: ReadonlyArray<{ op: string; text?: unknown }>): string[] {
  return updates.flatMap((u) => (u.op === 'user' && typeof u.text === 'string' ? [u.text] : []));
}

/** transcript의 사용자 발화 중 검색에 쓸 만한 것: 너무 짧은 "ㄱㄱ"과 슬래시 명령은 뺀다. */
export function pickPrompts(userTexts: string[]): string[] {
  const out: string[] = [];
  for (const raw of userTexts) {
    const t = raw.replace(/\s+/g, ' ').trim();
    if (t.length < PROMPT_MIN || t.startsWith('/')) continue;
    out.push(t.slice(0, PROMPT_CHARS));
    if (out.length === PROMPT_COUNT) break;
  }
  return out;
}

/** 모델에 보내는 문서. `withPrompts: false`면 프롬프트를 머신 밖으로 내보내지 않는다. */
export function aiText(d: SessionDoc, withPrompts: boolean): string {
  const head = [d.workspace, d.title, d.note].filter(Boolean).join(' / ');
  return withPrompts && d.prompts.length ? `${head} || 프롬프트: ${d.prompts.join(' | ')}` : head;
}

/** 로컬 글자 겹침용 — 프롬프트와 멤버 이름까지 쓴다(머신 밖으로 안 나간다). */
export function localText(d: SessionDoc): string {
  return [d.workspace, d.member, d.title, d.note, ...d.prompts].filter(Boolean).join(' ');
}

function bigrams(s: string): Set<string> {
  const t = s.toLowerCase().replace(/\s+/g, '');
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  if (t.length === 1) out.add(t);
  return out;
}

/** 질의 글자쌍 중 문서에 있는 비율(0..1). 한 글자 질의는 부분 문자열로 본다. */
export function lexicalScore(query: string, text: string): number {
  const q = bigrams(query);
  if (q.size === 0) return 0;
  const d = bigrams(text);
  let hit = 0;
  for (const g of q) if (d.has(g)) hit++;
  return hit / q.size;
}
