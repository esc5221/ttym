import { open } from 'node:fs/promises';

/**
 * 에이전트의 한 턴을 transcript(JSONL)에서 그대로 읽는다. Claude Code와 Codex 둘 다.
 *
 * await의 기본 반환은 이 턴의 마지막 text 하나다. 보통은 Stop 훅이 넘겨준 값
 * (last_assistant_message)을 쓰고, 없을 때 여기서 읽은 마지막 text를 쓴다.
 * 그 밖의 것 — 중간에 한 말, 도구 호출과 결과 — 은 버리지 않고 필요할 때 여기서 다시 읽는다.
 * 저장하는 것은 없다. 경로와 턴 범위만 있으면 언제든 같은 결과가 나온다.
 *
 *   Claude  ~/.claude/projects/<cwd>/<session>.jsonl — 턴 표시가 없어 시간 범위로 자른다
 *   Codex   $CODEX_HOME/sessions/…/rollout-…-<session>.jsonl — task_started·task_complete의
 *           turn_id로 자른다
 *
 *   outline  text 전부 + 도구마다 한 줄(이름·대상)
 *   full     도구 입력·출력까지, 도구 하나당 길이 제한
 *   summary  걸린 시간, 도구 횟수, 수정한 파일 — await 결과 아래 한 줄의 재료
 */

export interface TurnRange {
  path: string;
  /** Codex: 이 turn_id의 레코드만. 있으면 시간 범위보다 우선한다. */
  turnId?: string;
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

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']);

/**
 * 훅이 알려준 transcript 경로를 믿어도 되는가.
 *
 * /stop은 로컬 훅이 부르지만 원격 접속이 켜진 서버에서는 밖에서도 닿는다. 아무 경로나
 * 받으면 `ttym turn`으로 임의 파일의 일부를 읽는 통로가 된다. 에이전트가 쓰는 모양의
 * 파일만 받는다.
 */
export function isTranscriptPath(path: unknown): path is string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('/../') || !path.endsWith('.jsonl')) return false;
  const base = path.slice(path.lastIndexOf('/') + 1);
  return path.includes('/.claude/projects/') || (path.includes('/sessions/') && base.startsWith('rollout-'));
}

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

/** JSONL 텍스트에서 이 턴의 이벤트만 순서대로. 형식은 줄 모양으로 알아낸다. */
export function parseTurn(jsonl: string, sinceMs: number, untilMs = Infinity, turnId?: string): TurnEvent[] {
  const lines = jsonl.split('\n');
  const codex = lines.some((l) => l.startsWith('{"timestamp"') && l.includes('"payload"'));
  return codex ? parseCodexTurn(lines, sinceMs, untilMs, turnId) : parseClaudeTurn(lines, sinceMs, untilMs);
}

/** Claude: subagent(isSidechain) 항목은 뺀다. */
function parseClaudeTurn(lines: string[], sinceMs: number, untilMs: number): TurnEvent[] {
  const out: TurnEvent[] = [];
  for (const raw of lines) {
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
    // 한 메시지 안의 text 블록은 한 번에 한 말이다 — 이어 붙여 하나로.
    const texts: string[] = [];
    const flush = () => { if (texts.length) { out.push({ kind: 'text', at, text: texts.join('\n').trim() }); texts.length = 0; } };
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      const block = b as Record<string, unknown>;
      if (e.type === 'assistant' && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        texts.push(block.text);
        continue;
      }
      flush();
      if (e.type === 'assistant' && block.type === 'tool_use') {
        out.push({ kind: 'tool', at, id: String(block.id ?? ''), name: String(block.name ?? '?'), input: (block.input as Record<string, unknown>) ?? {} });
      } else if (e.type === 'user' && block.type === 'tool_result') {
        out.push({ kind: 'result', at, id: String(block.tool_use_id ?? ''), text: resultText(block.content), isError: block.is_error === true });
      }
    }
    flush();
  }
  return out;
}

/**
 * Codex rollout. 턴 경계는 task_started ~ task_complete(turn_aborted)이고, 그 사이의
 * response_item이 그 턴의 것이다. 도구는 두 모양이다:
 *   custom_tool_call  name + input(문자열: exec의 JS 한 줄, apply_patch의 패치 본문)
 *   function_call     name(+namespace) + arguments(JSON 문자열)
 * 결과는 call_id로 짝짓는다.
 */
function parseCodexTurn(lines: string[], sinceMs: number, untilMs: number, turnId?: string): TurnEvent[] {
  const out: TurnEvent[] = [];
  let current: string | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let e: { timestamp?: string; type?: string; payload?: Record<string, unknown> };
    try { e = JSON.parse(line); } catch { continue; }
    const p = e.payload ?? {};
    if (e.type === 'event_msg' && p.type === 'task_started') { current = String(p.turn_id ?? ''); continue; }
    if (e.type === 'event_msg' && (p.type === 'task_complete' || p.type === 'turn_aborted')) {
      if (current === p.turn_id) current = null;
      continue;
    }
    if (e.type !== 'response_item') continue;
    const at = Date.parse(e.timestamp ?? '');
    if (turnId !== undefined) { if (current !== turnId) continue; }
    else if (!Number.isFinite(at) || at < sinceMs || at > untilMs) continue;
    if (p.type === 'message' && p.role === 'assistant' && Array.isArray(p.content)) {
      const text = (p.content as Array<Record<string, unknown>>)
        .filter((b) => b.type === 'output_text' && typeof b.text === 'string').map((b) => b.text as string).join('\n').trim();
      if (text) out.push({ kind: 'text', at, text });
    } else if (p.type === 'custom_tool_call') {
      out.push({ kind: 'tool', at, id: String(p.call_id ?? ''), name: String(p.name ?? '?'), input: codexCustomInput(String(p.name ?? ''), p.input) });
    } else if (p.type === 'function_call') {
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(String(p.arguments ?? '{}')); } catch { input = { arguments: p.arguments }; }
      const name = p.namespace ? `${p.namespace}.${p.name}` : String(p.name ?? '?');
      out.push({ kind: 'tool', at, id: String(p.call_id ?? ''), name, input });
    } else if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
      const text = typeof p.output === 'string' ? p.output : resultText((p.output as unknown[] | undefined)?.map((b) => ({ type: 'text', text: (b as { text?: unknown }).text })));
      out.push({ kind: 'result', at, id: String(p.call_id ?? ''), text, isError: /^(Error|error:)|exit code [1-9]|Process exited with code [1-9]/m.test(text.slice(0, 400)) });
    }
  }
  return out;
}

/**
 * Codex custom tool의 입력을 도구 한 줄과 요약에 쓸 모양으로.
 *
 * exec는 JS 스크립트 한 덩이이고, 그 안에서 exec_command와 apply_patch를 여러 번 부를 수 있다
 * (실측: 패치를 적용하고 곧바로 테스트를 돌린 호출이 exec 하나였다). 첫 명령만 보면 수정이 빠진다 —
 * 스크립트 안의 명령과 패치 대상 파일을 전부 꺼낸다. 패치 본문은 스크립트 문자열 안이라 줄바꿈이
 * \n으로 이스케이프돼 있다.
 */
function codexCustomInput(name: string, input: unknown): Record<string, unknown> {
  const text = typeof input === 'string' ? input : JSON.stringify(input ?? '');
  const files = [...new Set([...text.matchAll(/\*\*\* (?:Update|Add|Delete) File: ([^\n"\\]+)/g)].map((m) => m[1].trim()))];
  if (name === 'apply_patch') return { file_path: files[0], files, patch: text };
  // cmd:"…" 또는 cmd:'…' — 모델이 따옴표를 그때그때 고른다(둘 다 실측).
  const cmds = [...text.matchAll(/cmd:\s*(["'])((?:(?!\1)[^\\]|\\.)*)\1/g)].map((m) => m[2].replace(/\\(["'])/g, '$1').replace(/\\n/g, '\n'));
  const parts = [...(files.length ? [`apply_patch ${files.map((f) => f.split('/').pop()).join(', ')}`] : []), ...cmds];
  return { ...(parts.length ? { command: parts.join(' ; ') } : {}), ...(files.length ? { files } : {}), script: text };
}

export async function readTurn(range: TurnRange): Promise<TurnEvent[]> {
  const jsonl = await readTail(range.path, 8 * 1024 * 1024);
  return parseTurn(jsonl, range.sinceMs, range.untilMs, range.turnId);
}

/** 이 턴에서 마지막으로 한 말 — 훅이 답을 못 넘겼을 때 await의 답. */
export function lastText(events: TurnEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.kind === 'text') return ev.text;
  }
  return null;
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
      // Claude는 편집 도구 이름으로, Codex는 패치 대상(files)으로 — exec 안의 apply_patch도 여기 걸린다.
      const list = Array.isArray(ev.input.files) ? ev.input.files
        : EDIT_TOOLS.has(ev.name) ? [ev.input.file_path ?? ev.input.notebook_path] : [];
      for (const fp of list) if (typeof fp === 'string') files.add(fp);
    }
  }
  return {
    durationMs: startedAt !== undefined && endedAt !== undefined ? endedAt - startedAt : null,
    tools, toolCount, filesEdited: [...files], errors, textBlocks,
  };
}

/** 도구 한 줄 — 이름과 가장 알아보기 쉬운 대상 하나. */
export function toolLine(name: string, input: Record<string, unknown>): string {
  const pick = input.command ?? input.cmd ?? input.file_path ?? input.notebook_path ?? input.pattern ?? input.url ?? input.query
    ?? input.description ?? input.prompt ?? input.skill ?? input.script;
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
