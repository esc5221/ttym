import process from 'node:process';
import { EXIT, getPort, fetchJson, ensureCompatibleServer, hasFlag, printOutput } from './common.js';

/**
 * ttym search <질의…> — 어느 세션인지 묻는다. 웹의 Cmd+K와 같은 서버 API(/api/search)를 쓴다.
 *
 * 기본은 AI(search-* 설정과 키가 있을 때), 키가 없거나 호출이 실패하면 글자 겹침으로 답하고
 * 왜 그랬는지 stderr에 적는다. --lex는 처음부터 이 머신 안에서만(아무것도 밖으로 안 나간다).
 */

interface Hit { id: number; workspace: string; member: string; title: string; note: string; p: number; via: 'ai' | 'lex' }
interface Answer { query: string; hits: Hit[]; ai?: { state: 'ok' | 'no-key' | 'error'; error?: string; ms?: number; cost?: number | null } }

export async function cmdSearch() {
  const args = process.argv.slice(3).filter((a) => !a.startsWith('--'));
  const query = args.join(' ').trim();
  if (!query) {
    console.error('usage: ttym search <query…> [--lex] [--json]');
    process.exit(EXIT.USAGE);
  }
  const port = getPort();
  await ensureCompatibleServer(port);
  const ask = (mode: 'ai' | 'lex') => fetchJson(port, `/api/search?mode=${mode}&q=${encodeURIComponent(query)}`) as Promise<Answer | null>;

  let answer: Answer | null = hasFlag('--lex') ? await ask('lex') : await ask('ai');
  if (!answer || !Array.isArray(answer.hits)) {
    console.error('search: the server does not answer /api/search — is it an older build? (ttym restart)');
    process.exit(EXIT.FAIL);
  }
  if (answer.ai && answer.ai.state !== 'ok') {
    console.error(answer.ai.state === 'no-key'
      ? 'search: no API key (search-api-key) — showing text matches only'
      : `search: AI search failed (${answer.ai.error ?? 'unknown'}) — showing text matches only`);
    answer = await ask('lex');
  }
  if (hasFlag('--json')) return printOutput(answer, true);
  if (answer!.hits.length === 0) { console.log('no match'); process.exit(EXIT.NOT_FOUND); }
  for (const h of answer!.hits) {
    const where = h.workspace ? `${h.workspace}:${h.member}` : '-';
    console.log(`%${h.id}\t${h.p.toFixed(2)}\t${where}\t${h.title || '(no title)'}${h.note ? ` — ${h.note}` : ''}`);
  }
}
