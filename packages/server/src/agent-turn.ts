import { open } from 'node:fs/promises';

/**
 * 에이전트의 한 턴을 transcript(JSONL)에서 그대로 읽는다.
 *
 * await의 기본 반환은 이 턴의 마지막 text 하나다(agent-providers의 claudeStructuredTranscript).
 * 그 밖의 것 — 중간에 한 말, 도구 호출과 결과 — 은 버리지 않고 필요할 때 여기서 다시 읽는다.
 * 저장하는 것은 없다. 경로와 시간 범위만 있으면 언제든 같은 결과가 나온다.
 *
 *   outline  text 전부 + 도구마다 한 줄(이름·대상)
 *   full     도구 입력·출력까지, 도구 하나당 길이 제한
 *   summary  걸린 시간, 도구 횟수, 수정한 파일 — await 결과 아래 한 줄의 재료
 */

export interface TurnRange {
  path: string;
  /** 이 시각 이후의 항목만 (프롬프트를 보낸 시각 - 여유). */
  sinceMs: number;
  /** 이 시각까지 (Stop 시각 + 여유). 없으면 끝까지. */
  untilMs?: number;
}

export type TurnEvent =
  | { kind: 'text'; at: number; text: string }
  | { kind: 'tool'; at: number; id: string; name: string; input: Record<string, unknown> }
  | { kind: 'result'; at: number; id: string; text: string; isError: boolean };

export interface TurnSummary {
  durationMs: number | null;
  tools: Record<string, number>;
  toolCount: number;
  /** Edit·Write·NotebookEdit가 건드린 파일. */
  filesEdited: string[];
  errors: number;
  textBlocks: number;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

async function readTail(path: string, bytes: number): Promise<string> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await fh.close();
  }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : '')).join('\n');
  }
  return '';
}

/** JSONL 텍스트에서 범위 안의 이벤트만 순서대로. subagent(isSidechain) 항목은 뺀다. */
export function parseTurn(jsonl: string, sinceMs: number, untilMs = Infinity): TurnEvent[] {
  const out: TurnEvent[] = [];
  for (const raw of jsonl.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let e: { type?: string; timestamp?: string; isSidechain?: boolean; message?: { content?: unknown } };
    try { e = JSON.parse(line); } catch { continue; }
    if (e.isSidechain) continue;
    if (e.type !== 'assistant' && e.type !== 'user') continue;
    const at = Date.parse(e.timestamp ?? '');
    if (!Number.isFinite(at) || at < sinceMs || at > untilMs) continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      const block = b as Record<string, unknown>;
      if (e.type === 'assistant' && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.push({ kind: 'text', at, text: block.text.trim() });
      } else if (e.type === 'assistant' && block.type === 'tool_use') {
        out.push({ kind: 'tool', at, id: String(block.id ?? ''), name: String(block.name ?? '?'), input: (block.input as Record<string, unknown>) ?? {} });
      } else if (e.type === 'user' && block.type === 'tool_result') {
        out.push({ kind: 'result', at, id: String(block.tool_use_id ?? ''), text: resultText(block.content), isError: block.is_error === true });
      }
    }
  }
  return out;
}

export async function readTurn(range: TurnRange): Promise<TurnEvent[]> {
  const jsonl = await readTail(range.path, 8 * 1024 * 1024);
  return parseTurn(jsonl, range.sinceMs, range.untilMs);
}

export function summarize(events: TurnEvent[], startedAt?: number, endedAt?: number): TurnSummary {
  const tools: Record<string, number> = {};
  const files = new Set<string>();
  let toolCount = 0, errors = 0, textBlocks = 0;
  for (const ev of events) {
    if (ev.kind === 'text') textBlocks++;
    else if (ev.kind === 'result') { if (ev.isError) errors++; }
    else {
      toolCount++;
      tools[ev.name] = (tools[ev.name] ?? 0) + 1;
      const fp = ev.input.file_path ?? ev.input.notebook_path;
      if (EDIT_TOOLS.has(ev.name) && typeof fp === 'string') files.add(fp);
    }
  }
  return {
    durationMs: startedAt !== undefined && endedAt !== undefined ? endedAt - startedAt : null,
    tools, toolCount, filesEdited: [...files], errors, textBlocks,
  };
}

/** 도구 한 줄 — 이름과 가장 알아보기 쉬운 대상 하나. */
export function toolLine(name: string, input: Record<string, unknown>): string {
  const pick = input.command ?? input.file_path ?? input.notebook_path ?? input.pattern ?? input.url ?? input.query
    ?? input.description ?? input.prompt ?? input.skill;
  const target = typeof pick === 'string' ? pick.replace(/\s+/g, ' ').trim() : '';
  return target ? `${name}: ${clip(target, 120)}` : name;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function renderOutline(events: TurnEvent[]): string {
  const lines: string[] = [];
  const errored = new Set(events.filter((e) => e.kind === 'result' && e.isError).map((e) => (e as { id: string }).id));
  for (const ev of events) {
    if (ev.kind === 'text') lines.push(ev.text, '');
    else if (ev.kind === 'tool') lines.push(`  → ${toolLine(ev.name, ev.input)}${errored.has(ev.id) ? '  (error)' : ''}`);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').trimEnd();
}

/** 도구 입력·결과까지. 결과는 도구마다 `perTool`자에서 자르고 잘렸다고 적는다. */
export function renderFull(events: TurnEvent[], perTool = 2000): string {
  const lines: string[] = [];
  for (const ev of events) {
    if (ev.kind === 'text') lines.push(ev.text, '');
    else if (ev.kind === 'tool') lines.push(`── ${ev.name} ${clip(JSON.stringify(ev.input), perTool)}`);
    else {
      const t = ev.text.trim();
      const cut = t.length > perTool ? `${t.slice(0, perTool)}\n… (${t.length - perTool} more chars)` : t;
      lines.push(`${ev.isError ? '✗ error' : '⤷ result'}`, cut, '');
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
