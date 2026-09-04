import { request, type BaseUrl } from './transport.js';
import type { ViewerState, ViewPresentation } from '@ttym/protocol';

/** `ttym open` over HTTP. The state comes back whole; CMD.VIEW pushes the same shape. */

export interface OpenViewsResult {
  state: ViewerState | null;
  results: Array<{ target: string; ok: true; id: string; rev: number } | { target: string; ok: false; error: string }>;
}

export function getViews(base: BaseUrl, sessionId: number): Promise<ViewerState | null> {
  return request(base, `/api/sessions/${sessionId}/views`);
}

export function openViews(
  base: BaseUrl,
  sessionId: number,
  options: { targets: string[]; presentation?: ViewPresentation; root?: string },
): Promise<OpenViewsResult> {
  return request(base, `/api/sessions/${sessionId}/views`, { method: 'POST', body: options });
}

export function closeView(base: BaseUrl, sessionId: number, viewId: string): Promise<{ state: ViewerState | null }> {
  return request(base, `/api/sessions/${sessionId}/views/${encodeURIComponent(viewId)}`, { method: 'DELETE' });
}

export function closeAllViews(base: BaseUrl, sessionId: number): Promise<{ state: null }> {
  return request(base, `/api/sessions/${sessionId}/views`, { method: 'DELETE' });
}
