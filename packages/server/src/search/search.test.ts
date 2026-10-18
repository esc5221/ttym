import { mkdirSync, mkdtempSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiText, lexicalScore, pickPrompts, userTextsOf, type SessionDoc } from './corpus.js';
import { readerFeed } from '../reader/index.js';
import { askNoul, DecisionsError } from './decisions.js';
import { resolveSettings, SearchService, DEFAULT_SEARCH_MODEL, DEFAULT_SEARCH_URL, type SearchDeps } from './service.js';

const doc = (over: Partial<SessionDoc> = {}): SessionDoc => ({
  id: 1, workspaceId: 'w1', workspace: 'mc', member: 'term-1', stream: null, title: 'mc 서버 복구', note: '서버 기동 완료', prompts: [], ...over,
});

describe('corpus', () => {
  it('pickPrompts drops short, slash and blank lines, keeps the first two at 120 chars', () => {
    const long = 'x'.repeat(300);
    expect(pickPrompts(['ㄱㄱ', '/clear', '  ', '마인크래프트 서버가 안 떠서 로그를 보고 있어', long, '세 번째 프롬프트는 버려진다 진짜로'])).toEqual([
      '마인크래프트 서버가 안 떠서 로그를 보고 있어',
      'x'.repeat(120),
    ]);
  });

  it('aiText leaves prompts out when asked to, and local text keeps them', () => {
    const d = doc({ prompts: ['첫 프롬프트는 이런 내용이다 정말'] });
    expect(aiText(d, true)).toContain('프롬프트: 첫 프롬프트');
    expect(aiText(d, false)).toBe('mc / mc 서버 복구 / 서버 기동 완료');
  });

  it('lexicalScore is the share of query bigrams found in the text', () => {
    expect(lexicalScore('서버 복구', 'mc 서버 복구 서버 기동')).toBe(1);
    expect(lexicalScore('비트코인', 'mc 서버 복구')).toBe(0);
    expect(lexicalScore('', 'mc')).toBe(0);
    expect(lexicalScore('서버 로그', 'mc 서버 복구')).toBeCloseTo(1 / 3, 5);
  });
});

describe('askNoul', () => {
  const cfg = { url: 'https://decide.test/alpha/decisions', model: 'm', key: 'sk-test', timeoutMs: 1000 };
  const q = { instructions: 'is it?', criteria: { true: 'yes', false: 'no' } };

  it('posts the OpenRouter decisions shape with the key and reads probabilities and cost', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({ model: 'm', state: { search_query: 'x' }, questions: { s1: { type: 'noul', ...q } } });
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
      return new Response(JSON.stringify({ answers: { s1: { type: 'noul', noul: 0.8 } }, usage: { cost: 0.0002 } }), { status: 200 });
    });
    const r = await askNoul(cfg, { search_query: 'x' }, { s1: q }, fetchMock as unknown as typeof fetch);
    expect(r).toEqual({ noul: { s1: 0.8 }, cost: 0.0002 });
    expect(fetchMock.mock.calls[0]![0]).toBe(cfg.url);
  });

  it('turns an HTTP error into a DecisionsError carrying the provider message', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }));
    await expect(askNoul(cfg, {}, { s1: q }, f as unknown as typeof fetch)).rejects.toMatchObject({ status: 401, message: '401 bad key' });
  });

  it('rejects a response without answers and a network failure', async () => {
    const empty = vi.fn(async () => new Response('{}', { status: 200 }));
    await expect(askNoul(cfg, {}, { s1: q }, empty as unknown as typeof fetch)).rejects.toBeInstanceOf(DecisionsError);
    const down = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    await expect(askNoul(cfg, {}, { s1: q }, down as unknown as typeof fetch)).rejects.toThrow(/unreachable: ECONNREFUSED/);
  });
});

describe('resolveSettings', () => {
  it('defaults to OpenRouter + Jev and reads overrides', () => {
    expect(resolveSettings({})).toMatchObject({ url: DEFAULT_SEARCH_URL, model: DEFAULT_SEARCH_MODEL, withPrompts: true, timeoutMs: 8000 });
    const s = resolveSettings({ 'search-url': ' https://api.typesafe.test/v1/decisions ', 'search-model': 'typesafe/jev-1.15', 'search-prompts': 'off', 'search-exclude-streams': 'gpai, 회사 ,', 'search-timeout': '2500' });
    expect(s.url).toBe('https://api.typesafe.test/v1/decisions');
    expect(s.model).toBe('typesafe/jev-1.15');
    expect(s.withPrompts).toBe(false);
    expect([...s.excludeStreams]).toEqual(['gpai', '회사']);
    expect(s.timeoutMs).toBe(2500);
  });
});

describe('SearchService', () => {
  let home: string;
  let config: Record<string, string>;
  let calls: Array<{ url: string; body: { model: string; questions: Record<string, { instructions: string }> } }>;
  let answer: (names: string[]) => Record<string, number>;

  const fetchStub = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body });
    const noul = answer(Object.keys(body.questions));
    return new Response(JSON.stringify({ answers: Object.fromEntries(Object.entries(noul).map(([k, v]) => [k, { type: 'noul', noul: v }])), usage: { cost: 0.0003 } }), { status: 200 });
  }) as unknown as typeof fetch;

  const make = (over: Partial<SearchDeps> = {}) => new SearchService({
    homeDir: home,
    config: () => config,
    sessions: async () => [
      { id: 1, lastSeq: 10, title: 'mc 서버 복구', note: '기동 완료' },
      { id: 2, lastSeq: 20, title: 'PostHog 결제 등록', note: '' },
      { id: 3, lastSeq: 30, title: '', note: '' },
    ],
    workspaces: () => [
      { id: 'w1', name: 'mc', stream: null, members: [{ sessionId: 1, name: 'a' }] },
      { id: 'w2', name: '리뷰하기', stream: '회사', members: [{ sessionId: 2, name: 'b' }] },
      { id: 'w3', name: '', stream: null, members: [{ sessionId: 3, name: 'c' }] },
    ],
    userTexts: async (id) => (id === 3 ? ['슬랙 봇 트리거가 누락되는 문제를 고쳐줘 제발'] : []),
    fetch: fetchStub,
    ...over,
  });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ttym-search-'));
    config = {};
    calls = [];
    answer = (names) => Object.fromEntries(names.map((n) => [n, n === 's1' ? 0.9 : n === 's2' ? 0.2 : 0.6]));
    delete process.env.TTYM_SEARCH_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });
  afterEach(() => { delete process.env.TTYM_SEARCH_API_KEY; delete process.env.OPENROUTER_API_KEY; });

  it('without a key the ai search is off and sends nothing', async () => {
    const r = await make().searchAi('서버');
    expect(r).toMatchObject({ hits: [], ai: { state: 'no-key' } });
    expect(calls).toHaveLength(0);
  });

  it('stores the key 0600, never reports it, and prefers the file over env', async () => {
    const svc = make();
    process.env.OPENROUTER_API_KEY = 'env-key';
    expect(await svc.keyState()).toEqual({ set: true, source: 'env' });
    await svc.setKey('  file-key ');
    const path = join(home, 'search-api-key');
    expect(readFileSync(path, 'utf8')).toBe('file-key\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await svc.keyState()).toEqual({ set: true, source: 'file' });
    await svc.setKey('');
    expect(existsSync(path)).toBe(false);
    expect(await svc.keyState()).toEqual({ set: true, source: 'env' });
  });

  it('asks one noul question per session, keeps hits at or above 0.5 and sorts them', async () => {
    await make().setKey('k');
    const svc = make();
    const r = await svc.searchAi('마인크래프트');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(DEFAULT_SEARCH_URL);
    expect(calls[0]!.body.model).toBe(DEFAULT_SEARCH_MODEL);
    expect(Object.keys(calls[0]!.body.questions)).toEqual(['s1', 's2', 's3']);
    expect(r.hits.map((h) => [h.id, h.p, h.via])).toEqual([[1, 0.9, 'ai'], [3, 0.6, 'ai']]);
    expect(r.hits[0]).toMatchObject({ workspaceId: 'w1', workspace: 'mc', member: 'a', title: 'mc 서버 복구' });
    expect(r.ai).toMatchObject({ state: 'ok', cost: 0.0003, asked: 3 });
  });

  it('uses the configured url and model', async () => {
    config = { 'search-url': 'https://official.test/v1/decisions', 'search-model': 'typesafe/jev-9' };
    const svc = make();
    await svc.setKey('k');
    await svc.searchAi('x y');
    expect(calls[0]).toMatchObject({ url: 'https://official.test/v1/decisions', body: { model: 'typesafe/jev-9' } });
  });

  it('sends prompts to the model only while search-prompts is on', async () => {
    const svc = make();
    await svc.setKey('k');
    await svc.searchAi('슬랙');
    expect(calls[0]!.body.questions.s3!.instructions).toContain('슬랙 봇 트리거가 누락되는 문제를 고쳐줘 제발');
    config = { 'search-prompts': 'off' };
    calls = [];
    await svc.searchAi('슬랙 다시');
    expect(calls[0]!.body.questions.s3).toBeUndefined();
  });

  it('keeps excluded streams out of the request', async () => {
    config = { 'search-exclude-streams': '회사' };
    const svc = make();
    await svc.setKey('k');
    await svc.searchAi('결제');
    expect(Object.keys(calls[0]!.body.questions)).toEqual(['s1', 's3']);
  });

  it('answers a repeated query from cache and reports provider failures', async () => {
    const svc = make();
    await svc.setKey('k');
    await svc.searchAi('같은 질의');
    await svc.searchAi('같은 질의');
    expect(calls).toHaveLength(1);
    const bad = make({ fetch: (async () => new Response('{"error":"nope"}', { status: 500 })) as unknown as typeof fetch });
    expect(await bad.searchAi('다른 질의')).toMatchObject({ hits: [], ai: { state: 'error', error: expect.stringContaining('500') } });
  });

  it('lex search runs locally, ranks by overlap and uses prompts', async () => {
    const svc = make();
    const r = await svc.searchLex('슬랙 봇 트리거');
    expect(r.hits[0]).toMatchObject({ id: 3, via: 'lex' });
    expect(r.ai).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect((await svc.searchLex('   ')).hits).toEqual([]);
  });
});

describe('prompts from a real transcript', () => {
  it('pulls what the person typed out of a Claude transcript, skipping the assistant and tool lines', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ttym-search-claude-'));
    const realHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const dir = join(home, '.claude', 'projects', '-work-proj');
      mkdirSync(dir, { recursive: true });
      const T = (s: number) => new Date(Date.UTC(2026, 9, 13, 0, 0, s)).toISOString();
      const lines = [
        { type: 'user', uuid: 'u1', timestamp: T(1), message: { content: '마인크래프트 서버가 안 떠서 로그를 보고 있어' } },
        { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: T(2), message: { role: 'assistant', content: [{ type: 'text', text: '로그를 확인해 보겠습니다' }] } },
        { type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: T(3), message: { content: 'ㄱㄱ' } },
      ].map((o) => JSON.stringify(o)).join('\n') + '\n';
      writeFileSync(join(dir, 'sid.jsonl'), lines);
      const feed = await readerFeed({ claudeSessionId: 'sid', cwd: '/work/proj' }, { after: null, key: null });
      const texts = userTextsOf(feed.updates);
      expect(texts).toEqual(['마인크래프트 서버가 안 떠서 로그를 보고 있어', 'ㄱㄱ']);
      expect(pickPrompts(texts)).toEqual(['마인크래프트 서버가 안 떠서 로그를 보고 있어']);
    } finally {
      process.env.HOME = realHome;
    }
  });
});
