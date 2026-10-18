import { readFile, writeFile, unlink, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { aiText, lexicalScore, localText, pickPrompts, type SessionDoc } from './corpus.js';
import { askNoul, DecisionsError, type DecisionsConfig, type NoulQuestion } from './decisions.js';

/**
 * 세션 찾기: 질의 한 줄 → 어느 세션인지.
 *
 * 두 갈래다. `lex`는 이 머신 안에서 글자 겹침만으로 즉시, `ai`는 decisions 모델(Jev)에
 * 세션마다 "이게 찾는 것인가?"를 묻는다. 웹은 lex를 먼저 보여 주고 ai가 오면 바꿔 끼운다.
 *
 * 설정(map과 같은 규칙: config는 서빙되므로 키는 넣지 않는다)
 *   search-url              decisions 엔드포인트 전체 주소. 기본 OpenRouter, TypeSafe 공식 주소로 바꿔 쓸 수 있다
 *   search-model            기본 typesafe/jev-1.14
 *   search-timeout          ms, 기본 8000
 *   search-prompts          off면 프롬프트 앞부분은 모델에 안 보낸다(제목·노트·workspace 이름만)
 *   search-exclude-streams  쉼표로 구분한 stream 이름 — 그 줄기의 세션은 모델에 안 보낸다
 *   키: $TTYM_HOME/search-api-key(0600) > $TTYM_SEARCH_API_KEY > $OPENROUTER_API_KEY
 *   키가 없으면 ai는 꺼진 채 lex만 돈다. 키를 넣는 것이 외부 전송의 동의다.
 */

export const DEFAULT_SEARCH_URL = 'https://openrouter.ai/api/alpha/decisions';
export const DEFAULT_SEARCH_MODEL = 'typesafe/jev-1.14';
const DEFAULT_TIMEOUT_MS = 8000;
const KEY_FILE = 'search-api-key';

/** 이 아래의 확률은 "아니다"에 가깝다. 측정에서 정답은 최저 0.64, 정답 없는 질의의 1위는 0.36이었다. */
const AI_MIN_P = 0.5;
const AI_LIMIT = 12;
const LEX_MIN = 0.2;
const LEX_LIMIT = 20;
const PROMPT_FRESH_MS = 120_000;
const INDEX_WAIT_MS = 3000;
const INDEX_PARALLEL = 6;
const ANSWER_CACHE_MS = 30_000;

export interface SearchSettings {
  url: string;
  model: string;
  timeoutMs: number;
  withPrompts: boolean;
  excludeStreams: Set<string>;
}

export function resolveSettings(values: Record<string, string>): SearchSettings {
  const timeout = parseInt(values['search-timeout'] ?? '', 10);
  return {
    url: (values['search-url'] ?? '').trim() || DEFAULT_SEARCH_URL,
    model: (values['search-model'] ?? '').trim() || DEFAULT_SEARCH_MODEL,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
    withPrompts: !['off', '0', 'false', 'no'].includes((values['search-prompts'] ?? '').trim().toLowerCase()),
    excludeStreams: new Set((values['search-exclude-streams'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
  };
}

export interface SearchHit {
  id: number;
  workspaceId: string | null;
  workspace: string;
  member: string;
  title: string;
  note: string;
  /** ai: 찾는 것일 확률(0..1). lex: 질의 글자쌍이 문서에 있는 비율. */
  p: number;
  via: 'ai' | 'lex';
}

export type AiState =
  | { state: 'ok'; ms: number; cost: number | null; asked: number }
  | { state: 'no-key' }
  | { state: 'error'; error: string; ms: number };

export interface SearchResponse {
  query: string;
  hits: SearchHit[];
  /** lex 요청에는 없다. */
  ai?: AiState;
}

export interface SearchDeps {
  homeDir: string;
  config(): Record<string, string>;
  /** 살아 있는 세션과 요약. */
  sessions(): Promise<Array<{ id: number; lastSeq: number; title: string; note: string }>>;
  workspaces(): Array<{ id: string; name: string; stream: string | null; members: Array<{ sessionId: number; name: string }> }>;
  /** 그 세션 대화에서 사용자가 보낸 말들(오래된 것부터). 읽을 수 없으면 빈 배열. */
  userTexts(id: number): Promise<string[]>;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
}

interface PromptEntry { seq: number; at: number; prompts: string[] }

export class SearchService {
  private readonly prompts = new Map<number, PromptEntry>();
  private readonly answers = new Map<string, { at: number; response: SearchResponse }>();
  private building: Promise<void> | null = null;

  constructor(private readonly deps: SearchDeps) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }
  private keyPath(): string { return resolve(this.deps.homeDir, KEY_FILE); }

  // ───── 키 ─────

  async resolveKey(): Promise<{ key: string; source: 'file' | 'env' } | null> {
    try {
      const raw = (await readFile(this.keyPath(), 'utf8')).trim();
      if (raw) return { key: raw, source: 'file' };
    } catch { /* no file */ }
    const env = process.env.TTYM_SEARCH_API_KEY || process.env.OPENROUTER_API_KEY;
    return env ? { key: env.trim(), source: 'env' } : null;
  }

  /** 키가 클라이언트로 되돌아가는 일은 없다 — 있는지와 출처만 답한다. */
  async keyState(): Promise<{ set: boolean; source: 'file' | 'env' | null }> {
    const k = await this.resolveKey();
    return { set: !!k, source: k?.source ?? null };
  }

  async setKey(key: string): Promise<void> {
    const trimmed = key.trim();
    if (!trimmed) { await unlink(this.keyPath()).catch(() => {}); return; }
    await writeFile(this.keyPath(), trimmed + '\n', { mode: 0o600 });
    await chmod(this.keyPath(), 0o600);
    this.answers.clear();
  }

  // ───── 문서 ─────

  /** 세션 목록과 workspace를 합쳐 문서로 만든다. 프롬프트는 캐시에서(없으면 비어 있다). */
  private async docs(): Promise<SessionDoc[]> {
    const sessions = await this.deps.sessions();
    const owner = new Map<number, { wsId: string; ws: string; stream: string | null; member: string }>();
    for (const w of this.deps.workspaces()) {
      for (const m of w.members) owner.set(m.sessionId, { wsId: w.id, ws: w.name, stream: w.stream, member: m.name });
    }
    return sessions.map((s) => {
      const o = owner.get(s.id);
      return {
        id: s.id,
        workspaceId: o?.wsId ?? null,
        workspace: o?.ws ?? '',
        member: o?.member ?? '',
        stream: o?.stream ?? null,
        title: s.title,
        note: s.note,
        prompts: this.prompts.get(s.id)?.prompts ?? [],
      };
    });
  }

  /**
   * 프롬프트 캐시를 채운다. 처음엔 세션마다 transcript를 읽어야 해서 느리므로 INDEX_WAIT_MS까지만
   * 기다리고, 못 끝낸 것은 뒤에서 마저 한다(그 사이 검색은 제목·노트만으로 답한다).
   */
  private async warm(): Promise<void> {
    const sessions = await this.deps.sessions();
    const t = this.now();
    const stale = sessions.filter((s) => {
      const e = this.prompts.get(s.id);
      return !e || (e.seq !== s.lastSeq && t - e.at > PROMPT_FRESH_MS);
    });
    if (stale.length === 0) return;
    if (!this.building) {
      this.building = (async () => {
        let next = 0;
        const worker = async () => {
          while (next < stale.length) {
            const s = stale[next++]!;
            const texts = await this.deps.userTexts(s.id).catch(() => [] as string[]);
            this.prompts.set(s.id, { seq: s.lastSeq, at: this.now(), prompts: pickPrompts(texts) });
          }
        };
        await Promise.all(Array.from({ length: Math.min(INDEX_PARALLEL, stale.length) }, worker));
      })().finally(() => { this.building = null; });
    }
    await Promise.race([this.building, new Promise<void>((r) => setTimeout(r, INDEX_WAIT_MS))]);
  }

  // ───── 검색 ─────

  async searchLex(query: string): Promise<SearchResponse> {
    const q = query.trim();
    if (!q) return { query: q, hits: [] };
    await this.warm();
    const hits: SearchHit[] = [];
    for (const d of await this.docs()) {
      const p = lexicalScore(q, localText(d));
      if (p >= LEX_MIN) hits.push(toHit(d, p, 'lex'));
    }
    hits.sort((a, b) => b.p - a.p);
    return { query: q, hits: hits.slice(0, LEX_LIMIT) };
  }

  async searchAi(query: string): Promise<SearchResponse> {
    const q = query.trim();
    if (!q) return { query: q, hits: [], ai: { state: 'ok', ms: 0, cost: null, asked: 0 } };
    const cached = this.answers.get(q);
    if (cached && this.now() - cached.at < ANSWER_CACHE_MS) return cached.response;

    const key = await this.resolveKey();
    if (!key) return { query: q, hits: [], ai: { state: 'no-key' } };
    const settings = resolveSettings(this.deps.config());
    await this.warm();
    const docs = (await this.docs()).filter((d) => !(d.stream && settings.excludeStreams.has(d.stream)));

    const questions: Record<string, NoulQuestion> = {};
    const byName = new Map<string, SessionDoc>();
    for (const d of docs) {
      const text = aiText(d, settings.withPrompts);
      if (!text) continue;
      const name = `s${d.id}`;
      questions[name] = {
        instructions: `Is this terminal session what the user is searching for? Session: ${text}`,
        criteria: { true: "The session's topic matches the search query.", false: 'The session is about something else.' },
      };
      byName.set(name, d);
    }
    if (byName.size === 0) return { query: q, hits: [], ai: { state: 'ok', ms: 0, cost: null, asked: 0 } };

    const cfg: DecisionsConfig = { url: settings.url, model: settings.model, key: key.key, timeoutMs: settings.timeoutMs };
    const started = this.now();
    try {
      const r = await askNoul(cfg, { search_query: q }, questions, this.deps.fetch);
      const hits: SearchHit[] = [];
      for (const [name, p] of Object.entries(r.noul)) {
        const d = byName.get(name);
        if (d && p >= AI_MIN_P) hits.push(toHit(d, p, 'ai'));
      }
      hits.sort((a, b) => b.p - a.p);
      const response: SearchResponse = {
        query: q,
        hits: hits.slice(0, AI_LIMIT),
        ai: { state: 'ok', ms: this.now() - started, cost: r.cost, asked: byName.size },
      };
      this.answers.set(q, { at: this.now(), response });
      if (this.answers.size > 50) this.answers.delete(this.answers.keys().next().value as string);
      return response;
    } catch (e) {
      const error = e instanceof DecisionsError ? e.message : String((e as Error).message ?? e);
      this.deps.log?.(`SEARCH ai failed: ${error}`);
      return { query: q, hits: [], ai: { state: 'error', error: error.slice(0, 200), ms: this.now() - started } };
    }
  }
}

function toHit(d: SessionDoc, p: number, via: 'ai' | 'lex'): SearchHit {
  return { id: d.id, workspaceId: d.workspaceId, workspace: d.workspace, member: d.member, title: d.title, note: d.note, p: Math.round(p * 100) / 100, via };
}
