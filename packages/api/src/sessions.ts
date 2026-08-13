import { request, type BaseUrl } from './transport.js';
import type { SessionAnnotations, SessionInfo, SessionMeta, SessionRuntime } from './types.js';

export function listSessions(base: BaseUrl): Promise<SessionInfo[]> {
  return request(base, '/api/sessions');
}

export function createSession(
  base: BaseUrl,
  options: { cmd?: string[]; cols?: number; rows?: number; cwd?: string; verify?: boolean } = {},
): Promise<SessionInfo> {
  return request(base, '/api/sessions', { method: 'POST', body: options });
}

export function destroySession(base: BaseUrl, sessionId: number): Promise<void> {
  return request(base, `/api/sessions/${sessionId}`, { method: 'DELETE' });
}

export async function getSessionScreen(base: BaseUrl, sessionId: number): Promise<string> {
  const data = await request<{ screen: string }>(base, `/api/sessions/${sessionId}/screen`);
  return data?.screen ?? '';
}

export function getSessionMeta(base: BaseUrl, sessionId: number): Promise<SessionMeta> {
  return request(base, `/api/sessions/${sessionId}/meta`);
}

export function patchSessionMeta(base: BaseUrl, sessionId: number, patch: SessionMeta): Promise<SessionMeta> {
  return request(base, `/api/sessions/${sessionId}/meta`, { method: 'PATCH', body: patch });
}

/** Raw bytes to the PTY. The caller decides whether a newline belongs. */
export function sendToSession(base: BaseUrl, sessionId: number, data: string): Promise<{ ok: boolean }> {
  return request(base, `/api/sessions/${sessionId}/send`, { method: 'POST', body: { data } });
}

export function resizeSession(base: BaseUrl, sessionId: number, cols: number, rows: number): Promise<{ ok: boolean }> {
  return request(base, `/api/sessions/${sessionId}/resize`, { method: 'POST', body: { cols, rows } });
}

export function getSessionRuntime(base: BaseUrl, sessionId: number): Promise<SessionRuntime> {
  return request(base, `/api/sessions/${sessionId}/runtime`);
}

export function getSessionAnnotations(base: BaseUrl, sessionId: number): Promise<SessionAnnotations> {
  return request(base, `/api/sessions/${sessionId}/annotations`);
}

export function patchSessionAnnotations(
  base: BaseUrl,
  sessionId: number,
  patch: SessionAnnotations,
): Promise<SessionAnnotations> {
  return request(base, `/api/sessions/${sessionId}/annotations`, { method: 'PATCH', body: patch });
}

export function getAgentStates(base: BaseUrl): Promise<Record<number, { kind: string | null; active: boolean }>> {
  return request(base, '/api/agent-states');
}
