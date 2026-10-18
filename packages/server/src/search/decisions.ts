/**
 * Jev 같은 "decisions" 모델 호출. chat/completions가 아니라 질문 묶음을 보내고 질문마다 확률을 받는다.
 *
 * 요청·응답 모양은 OpenRouter의 `POST /api/alpha/decisions`를 따른다(openrouter.ai/docs/guides/community/jev).
 * 주소·모델은 호출하는 쪽이 정한다 — TypeSafe 공식 주소로 바꿔 쓸 수 있게 이 파일은 주소를 모른다.
 *
 *   요청  { model, state, questions: { <이름>: { type: 'noul', instructions, criteria: { true, false } } } }
 *   응답  { answers: { <이름>: { type: 'noul', noul: 0..1 } }, usage: { cost } }
 */

export interface DecisionsConfig {
  url: string;
  model: string;
  key: string;
  timeoutMs: number;
}

export interface NoulQuestion {
  instructions: string;
  criteria: { true: string; false: string };
}

export interface DecisionsResult {
  /** 질문 이름 → "예"일 확률. */
  noul: Record<string, number>;
  /** USD. 응답에 없으면 null. */
  cost: number | null;
}

export class DecisionsError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

export async function askNoul(
  cfg: DecisionsConfig,
  state: unknown,
  questions: Record<string, NoulQuestion>,
  fetchImpl: typeof fetch = fetch,
): Promise<DecisionsResult> {
  const body = {
    model: cfg.model,
    state,
    questions: Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, { type: 'noul', ...q }])),
  };
  let res: Response;
  try {
    res = await fetchImpl(cfg.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new DecisionsError(timeout ? `timed out after ${cfg.timeoutMs}ms` : `unreachable: ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) throw new DecisionsError(`${res.status} ${errorMessage(text)}`, res.status);
  let parsed: { answers?: Record<string, { noul?: unknown }>; usage?: { cost?: unknown } };
  try { parsed = JSON.parse(text); } catch { throw new DecisionsError('response is not JSON'); }
  if (!parsed.answers || typeof parsed.answers !== 'object') throw new DecisionsError('response has no answers');
  const noul: Record<string, number> = {};
  for (const [name, a] of Object.entries(parsed.answers)) {
    if (typeof a?.noul === 'number' && Number.isFinite(a.noul)) noul[name] = a.noul;
  }
  const cost = typeof parsed.usage?.cost === 'number' ? parsed.usage.cost : null;
  return { noul, cost };
}

function errorMessage(body: string): string {
  try {
    const e = JSON.parse(body) as { error?: { message?: unknown } | string };
    const m = typeof e.error === 'string' ? e.error : e.error?.message;
    if (typeof m === 'string') return m.slice(0, 200);
  } catch { /* not JSON */ }
  return body.slice(0, 200);
}
