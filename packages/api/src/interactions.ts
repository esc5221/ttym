import { request, type BaseUrl } from './transport.js';
import type { Interaction } from './types.js';

/**
 * Submit a prompt and wait for the agent to finish.
 *
 * Resolves with a completed interaction, or with a pending one if `timeoutMs`
 * elapsed first — a timeout is a deferral, not an error, and the same id can be
 * picked up again with `resumeInteraction`.
 */
export function submitInteraction(
  base: BaseUrl,
  sessionId: number,
  options: { prompt: string; timeoutMs?: number; submit?: 'cr' | 'lf' | 'none' },
): Promise<{ interaction: Interaction }> {
  return request(base, `/api/sessions/${sessionId}/interactions`, { method: 'POST', body: options });
}

export function resumeInteraction(
  base: BaseUrl,
  sessionId: number,
  interactionId: string,
  waitMs = 0,
): Promise<{ interaction: Interaction }> {
  return request(base, `/api/sessions/${sessionId}/interactions/${interactionId}`, {
    query: { wait: waitMs || undefined },
  });
}
