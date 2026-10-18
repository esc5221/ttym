import { request, type BaseUrl } from './transport.js';

export interface SearchHit {
  id: number;
  workspaceId: string | null;
  workspace: string;
  member: string;
  title: string;
  note: string;
  /** ai: 찾는 것일 확률. lex: 질의 글자쌍이 문서에 있는 비율. */
  p: number;
  via: 'ai' | 'lex';
}

export type SearchAiState =
  | { state: 'ok'; ms: number; cost: number | null; asked: number }
  | { state: 'no-key' }
  | { state: 'error'; error: string; ms: number };

export interface SearchAnswer {
  query: string;
  hits: SearchHit[];
  /** lex 요청에는 없다. */
  ai?: SearchAiState;
}

/** 질의 한 줄로 세션 찾기. `lex`는 이 머신 안에서 즉시, `ai`는 decisions 모델에 묻는다(키가 있을 때). */
export function searchSessions(base: BaseUrl, q: string, mode: 'lex' | 'ai', signal?: AbortSignal): Promise<SearchAnswer> {
  return request(base, '/api/search', { query: { q, mode }, signal });
}

/** 검색 API 키는 write-only다 — 있는지와 출처만 돌아온다. */
export function getSearchKeyState(base: BaseUrl): Promise<{ set: boolean; source: 'file' | 'env' | null }> {
  return request(base, '/api/search/api-key');
}

export function setSearchKey(base: BaseUrl, key: string): Promise<{ set: boolean; source: 'file' | 'env' | null }> {
  return request(base, '/api/search/api-key', { method: 'POST', body: { key } });
}
