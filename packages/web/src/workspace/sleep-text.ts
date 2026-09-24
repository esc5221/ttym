import type { AgentState } from '../app-shared.js';

/** 절전 상태를 사람 말로 — pane 헤더의 ☾ 툴팁과 하단 알약이 같은 문장을 쓴다. */
export function ageText(since: number): string {
  const m = Math.max(0, Math.round((Date.now() - since) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d`;
}
export function sleepTitle(sleep: NonNullable<AgentState['sleep']>): string {
  const mb = Math.round(sleep.rssBefore / 1048576);
  if (sleep.state === 'sleeping') return `asleep ${ageText(sleep.since)} (${sleep.reason}) · ${mb} MB given back · any input resumes it`;
  if (sleep.state === 'waking') return 'resuming — input is queued until the prompt is back';
  return `resume failed: ${sleep.error ?? 'unknown'}`;
}
