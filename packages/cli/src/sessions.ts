import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
const __dirname = dirname(fileURLToPath(import.meta.url));
import { readPid, GLOBAL, EXIT, getPort, apiBase, legacyBody, fetchJson, fetchPatch, fetchPost, fetchDelete, fetchRequest, ensureCompatibleServer, shellAwait, stripAnsi, cleanShellOutput, hasFlag, readOption, printOutput, encodeFrame, encodeDataFrame, decodeFrame, parseFrameJson, CMD, encoder, decoder, HOME_DIR, PID_FILE, LOG_FILE, SERVER_JS, HOLDER_BIN, HTTP_TIMEOUT_MS, ATTACH_RETRY_MS, DETACH_KEY } from './common.js';
import { resolveAddress, resolveMatches, ensureDefaultWorkspace, createWorkspaceMember, requireMember, resolveWorkspace, patchSessionMeta, memberAddress } from './addresses.js';
import { ensureServerRunning } from './lifecycle.js';
// 이 파일은 C4b 분할로 main.ts에서 나왔다 — 동작 이동 없음, 구조 이동만.
/**
 * --cwd 와 --size 를 서버가 받는 필드로 옮긴다.
 *
 * 서버의 /split 은 처음부터 cwd·cols·rows 를 받아왔는데 CLI 가 채우지 않았다.
 * 그래서 에이전트를 워크트리에서 띄우려면 `-- codex -C <경로>` 처럼 띄우는
 * 명령의 플래그에 기대야 했고, 그런 플래그가 없는 claude 에는 방법이 없었다.
 * 크기도 마찬가지다 — 기본 80x24 는 TUI 에이전트에 좁아서 띄운 뒤 resize 를
 * 다시 부르는 왕복이 생겼다.
 */
export function geometryOptions(args: string[]): Record<string, unknown> {
  const sep = args.indexOf('--');
  const ownArgs = sep === -1 ? args : args.slice(0, sep);
  const out: Record<string, unknown> = {};
  const cwd = readOption(ownArgs, '--cwd');
  if (cwd) out.cwd = resolve(cwd.replace(/^~(?=\/|$)/, HOME_DIR));
  const size = readOption(ownArgs, '--size');
  if (size) {
    const m = /^(\d+)x(\d+)$/.exec(size.trim());
    if (!m || Number(m[1]) <= 0 || Number(m[2]) <= 0) {
      console.error(`--size must look like <cols>x<rows>, got: ${size}`);
      process.exit(EXIT.USAGE);
    }
    out.cols = Number(m[1]);
    out.rows = Number(m[2]);
  }
  return out;
}

export async function cmdNew() {
  const args = process.argv.slice(3);
  const name = args[0] && !args[0].startsWith('-') ? args[0] : null;
  if (!name) {
    console.error('usage: ttym new <name> [--cwd <dir>] [--size <cols>x<rows>] [-- <cmd...>]');
    process.exit(EXIT.USAGE);
  }
  const port = getPort();
  await ensureServerRunning(port); // 진입 동사 — 서버 없으면 띄운다
  await ensureCompatibleServer(port);
  const sep = args.indexOf('--');
  const cmd = sep !== -1 ? args.slice(sep + 1) : null;
  const asJson = hasFlag('--json');

  // Membership is a CLI convenience here, not a storage invariant: the session
  // gets a name by being filed in the default workspace (ADR-0001 Q1).
  const workspace = await ensureDefaultWorkspace(port);
  const { workspace: updated, member, session } = await createWorkspaceMember(port, workspace, { name, cmd, ...geometryOptions(args) });
  const result = {
    address: `${updated.name}:${member.name}`,
    sessionId: session.id,
    workspace: updated.name,
  };
  if (asJson) return printOutput(result, true);
  console.log(`${result.address}  #${session.id}`);
}

export async function cmdSplit() {
  const args = process.argv.slice(3);
  const targetToken = args[0];
  const name = args[1] && !args[1].startsWith('-') ? args[1] : null;
  if (!targetToken || !name) {
    console.error('usage: ttym split <ws:name|:name> <new-name> [--cwd <dir>] [--size <cols>x<rows>] [-- <cmd...>]');
    process.exit(EXIT.USAGE);
  }
  const port = getPort();
  await ensureServerRunning(port); // 진입 동사 — 서버 없으면 띄운다
  await ensureCompatibleServer(port);
  const sep = args.indexOf('--');
  const cmd = sep !== -1 ? args.slice(sep + 1) : null;
  const asJson = hasFlag('--json');

  const target = await resolveAddress(port, targetToken);
  if (!target.workspace) {
    console.error('split needs a workspace member as its target, not a bare session id');
    process.exit(EXIT.USAGE);
  }
  const body: Record<string, unknown> = { targetSessionId: target.sessionId, name, ...geometryOptions(args) };
  if (cmd) body.cmd = cmd;
  const data = await fetchPost(port, `/api/workspaces/${encodeURIComponent(target.workspace.id)}/split`, body);
  if (!data || data.error || !data.session) {
    console.error(`split failed: ${data?.error ?? 'no session returned'}`);
    process.exit(EXIT.FAIL);
  }
  const result = {
    address: `${target.workspace.name}:${name}`,
    sessionId: data.session.id,
  };
  if (asJson) return printOutput(result, true);
  console.log(`${result.address}  #${data.session.id}`);
}

export async function cmdSendAddr() {
  const args = process.argv.slice(3);
  const sep = args.indexOf('--');
  const payload = sep !== -1 ? args.slice(sep + 1).join(' ') : '';
  const token = args[0];
  if (!token || !payload) {
    console.error('usage: ttym send <ws:name|:name|#id | --match "expr"> -- "data"');
    process.exit(EXIT.USAGE);
  }
  const port = getPort();
  await ensureCompatibleServer(port);
  if (token === '--match') {
    const targets = await resolveMatches(port, args[1] ?? '');
    for (const target of targets) {
      await fetchPost(port, `/api/sessions/${target.sessionId}/send`, { data: payload });
      console.log(`sent to ${target.label}`);
    }
    return;
  }
  const target = await resolveAddress(port, token);
  const result = await fetchPost(port, `/api/sessions/${target.sessionId}/send`, { data: payload });
  if (hasFlag('--json')) return printOutput(result, true);
  console.log(`sent to ${target.label}`);
}

/** 계약 조항 "비대화형 resize": ttym resize <addr> <cols> <rows> */
export async function cmdResizeAddr() {
  const token = process.argv[3];
  const cols = parseInt(process.argv[4], 10);
  const rows = parseInt(process.argv[5], 10);
  if (!token || !Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
    console.error('usage: ttym resize <ws:name|:name|#id> <cols> <rows>');
    process.exit(EXIT.USAGE);
  }
  const port = getPort();
  const target = await resolveAddress(port, token);
  await fetchPost(port, `/api/sessions/${target.sessionId}/resize`, { cols, rows });
  if (hasFlag('--json')) return printOutput({ ok: true, sessionId: target.sessionId, cols, rows }, true);
  console.log(`resized #${target.sessionId} to ${cols}x${rows}`);
}

/** 계약 조항 "비대화형 종료": ttym kill <addr> — 세션과 holder까지 끝낸다. */
export async function cmdKillAddr() {
  const token = process.argv[3];
  if (!token) {
    console.error('usage: ttym kill <ws:name|:name|#id>');
    process.exit(EXIT.USAGE);
  }
  const port = getPort();
  const target = await resolveAddress(port, token);
  await fetchDelete(port, `/api/sessions/${target.sessionId}`);
  if (hasFlag('--json')) return printOutput({ ok: true, sessionId: target.sessionId }, true);
  console.log(`killed #${target.sessionId}`);
}

/**
 * screen 의 기본은 제어문자를 벗긴 화면이다. --raw 를 주면 원본 그대로.
 *
 * 전에는 기본이 원본이었다. 사람이 읽든 에이전트가 읽든 그대로는 못 읽으니,
 * 실제 사용처에서는 매번 이런 파이프를 붙였다(실측):
 *   LC_ALL=C ttym screen :x | LC_ALL=C sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g'
 * 도구가 할 일을 부르는 쪽에 떠넘기고 있었다. stripAnsi 는 이미 있었다.
 */
function renderScreen(screen: string): string {
  return hasFlag('--raw') ? screen : stripAnsi(screen);
}

/**
 * 화면 한 장. --raw가 아니면 서버가 터미널 버퍼에서 읽은 평문(format=text)을 받는다 —
 * ANSI를 정규식으로 벗기면 커서 이동으로 그린 공백이 사라져 단어가 붙었다("Doyouwanttoproceed?").
 * 옛 서버는 format을 모르고 ANSI를 준다; 그때만 벗긴다.
 */
async function fetchScreen(port: number, sessionId: number): Promise<string> {
  const raw = hasFlag('--raw');
  const result = await fetchJson(port, `/api/sessions/${sessionId}/screen${raw ? '' : '?format=text'}`);
  const screen = result?.screen ?? '';
  return result?.format === 'text' ? (screen.endsWith('\n') || !screen ? screen : `${screen}\n`) : renderScreen(screen);
}

export async function cmdScreenAddr() {
  const args = process.argv.slice(3);
  const token = args[0];
  if (!token) {
    console.error('usage: ttym screen <ws:name|:name|#id | --match \"expr\"> [--raw] [--json]');
    process.exit(EXIT.USAGE);
  }
  const port = getPort();
  await ensureCompatibleServer(port);
  if (token === '--match') {
    const targets = await resolveMatches(port, args[1] ?? '');
    const screens = [];
    for (const target of targets) {
      screens.push({ target: target.label, screen: await fetchScreen(port, target.sessionId) });
    }
    if (hasFlag('--json')) return printOutput(screens, true);
    for (const entry of screens) {
      console.log(`── ${entry.target} ──`);
      process.stdout.write(entry.screen.endsWith('\n') ? entry.screen : entry.screen + '\n');
    }
    return;
  }
  const target = await resolveAddress(port, token);
  const screen = await fetchScreen(port, target.sessionId);
  if (hasFlag('--json')) return printOutput({ target: target.label, screen }, true);
  process.stdout.write(screen);
}

export async function cmdCommandsAddr() {
  const args = process.argv.slice(3);
  const token = args[0];
  if (!token) {
    console.error('usage: ttym commands <ws:name|:name|#id> [--limit N] [--json]');
    process.exit(EXIT.USAGE);
  }
  const port = getPort();
  await ensureCompatibleServer(port);
  const target = await resolveAddress(port, token);
  const limit = parseInt(readOption(args, '--limit') || '50', 10);
  const result = await fetchJson(port, `/api/sessions/${target.sessionId}/commands?limit=${limit}`);
  if (hasFlag('--json')) return printOutput({ target: target.label, ...result }, true);
  if (!result.integration) {
    console.error('no shell integration signals — source scripts/ttym-shell-integration.zsh in that pane');
    return;
  }
  for (const c of result.commands) {
    const t = new Date(c.startedAt).toTimeString().slice(0, 8);
    const mark = c.endedAt === null ? '…' : c.exitCode === null ? '?' : c.exitCode === 0 ? '✓' : '✗';
    const dur = c.endedAt === null ? 'running' : `${((c.endedAt - c.startedAt) / 1000).toFixed(1)}s`;
    const code = c.exitCode === null ? '' : String(c.exitCode);
    console.log(`${t}  ${mark} ${code.padStart(3)}  ${dur.padStart(8)}  ${c.cmdline ?? '(unknown)'}`);
  }
  if (result.total > result.commands.length) {
    console.error(`(${result.total - result.commands.length} earlier commands not shown — --limit)`);
  }
}

export async function cmdOutputAddr() {
  const args = process.argv.slice(3);
  const token = args[0];
  if (!token) {
    console.error('usage: ttym output <ws:name|:name|#id> [--cmd N] [--raw] [--json]');
    process.exit(EXIT.USAGE);
  }
  const port = getPort();
  await ensureCompatibleServer(port);
  const target = await resolveAddress(port, token);
  const which = readOption(args, '--cmd') || 'last';
  const result = await fetchJson(port, `/api/sessions/${target.sessionId}/commands/${which}/output`).catch(() => null);
  if (!result || result.error) {
    console.error(`no such command in #${target.sessionId} — see: ttym commands ${token}`);
    process.exit(EXIT.NOT_FOUND);
  }
  const output = hasFlag('--raw') ? result.output : cleanShellOutput(result.output);
  if (hasFlag('--json')) return printOutput({ target: target.label, ...result, output }, true);
  if (result.truncated) console.error('warning: output partially evicted from the ring — head is missing');
  if (result.running) console.error('note: command still running — output so far');
  process.stdout.write(output);
  if (output && !output.endsWith('\n')) process.stdout.write('\n');
}

/**
 * await 가 왜 끝났는지 한 필드로 읽게 한다.
 *
 * status 만으로는 부르는 쪽이 "안 끝난 것"과 "끝났는데 답이 없는 것"을 가르기
 * 어려웠다. 실제로 await 가 답 없이 돌아왔을 때, 부르는 쪽이 서버 생존을 따로
 * 확인하고 결과 파일이 생겼는지로 완료를 짐작하는 우회가 나왔다.
 *
 *   done      정상 종료. output 이 답이다
 *   timeout   아직 돌고 있다. interaction.id 로 이어받을 수 있다
 *   failed    턴이 답 없이 끝났다. 세션은 살아 있다
 */
function awaitReason(status: string | null): 'done' | 'timeout' | 'failed' | 'unknown' {
  if (status === 'completed') return 'done';
  if (status === 'pending') return 'timeout';
  if (status === 'failed') return 'failed';
  return 'unknown';
}

/**
 * 단일 대상과 --match 가 같은 모양을 내놓게 하는 한 군데.
 *
 * output 은 경로와 무관하게 벗긴 평문이다 — transcript 는 서버가 이미
 * 평문으로 주지만 그게 null 이면 폴백하는 화면은 ANSI 원본이라,
 * 부르는 쪽은 같은 필드에서 둘 중 무엇을 받았는지 구분할 수 없었다.
 */
async function awaitInteraction(port: number, sessionId: number, prompt: string, timeoutMs: number, raw: boolean) {
  const response = await fetchRequest(port, 'POST', `/api/sessions/${sessionId}/interactions`, {
    prompt: prompt.replace(/[\r\n]+$/, ''),
    timeoutMs,
    submit: 'cr',
  }, timeoutMs + 15_000);
  return awaitResult(port, sessionId, response?.interaction ?? null, raw);
}

/**
 * 서버의 interaction 하나를 await 결과 모양으로. 새로 보낸 것과 --id로 이어받은 것이 같은 길을 탄다.
 *
 * output은 답뿐이다 — 에이전트가 한 말(transcript) 또는 서버가 잘라 준 화면 구간. 답이 없는데
 * (timeout·신호 없는 터미널) 지금 화면을 output에 넣으면 부르는 쪽이 진행 중인 화면을 답으로
 * 읽는다. 그 화면은 screen에 따로 담는다.
 */
async function awaitResult(port: number, sessionId: number, interaction: any, raw: boolean) {
  const output = interaction?.transcript ?? null;
  let screen: string | null = null;
  if (output === null) {
    const res = await fetchJson(port, `/api/sessions/${sessionId}/screen${raw ? '' : '?format=text'}`).catch(() => null);
    screen = typeof res?.screen === 'string' ? res.screen : null;
  }
  const clean = (text: string | null) => (text === null ? null : raw ? text : stripAnsi(text));
  const agent = await isAgentSession(port, sessionId);
  return {
    agent,
    interaction: interaction ? {
      id: interaction.id,
      status: interaction.status,
      // 추출 품질은 숨기지 않는다 — 어디서 온 답인지, 화면이 온전했는지.
      transcriptSource: interaction.transcriptSource ?? null,
      integrity: interaction.integrity ?? null,
      // 턴 크기와 더 보는 법 — 기본 답은 마지막 text 하나라, 무엇이 빠졌는지 판단할 근거를 같이 준다.
      summary: interaction.summary ?? null,
      more: interaction.turnPath ? { outline: `ttym turn ${interaction.id}`, full: `ttym turn ${interaction.id} --full`, path: interaction.turnPath } : null,
    } : null,
    completed: interaction?.status === 'completed',
    reason: awaitReason(interaction?.status ?? null),
    output: clean(output),
    screen: clean(screen),
  };
}

/**
 * 보낸 사람 머리말. 에이전트 pane에서 부르면 받는 쪽이 사용자 입력과 동료의 질문을 가를 수 있게
 * 한 줄 앞에 붙인다. 답하는 법은 적지 않는다 — 받는 쪽은 평소처럼 답하고, 그 말을 그대로 읽어 온다.
 * 줄바꿈 없이 같은 줄: TUI 입력창에 LF를 쓰면 에이전트마다 다르게 먹는다.
 */
/** 에이전트(Claude Code·Codex)가 붙은 적 있는 세션인가 — 훅이 서버 meta에 그 세션 id를 남긴다. */
async function isAgentSession(port: number, sessionId: number): Promise<boolean> {
  const meta = await fetchJson(port, `/api/sessions/${sessionId}/meta`).catch(() => null);
  return Boolean(meta && (meta.claudeSessionId || meta.claudeLastSessionId || meta.codexSessionId || meta.codexLastSessionId));
}

async function senderPrefix(port: number, ownArgs: string[], targetSessionId: number): Promise<string> {
  if (ownArgs.includes('--no-from')) return '';
  const sid = parseInt(process.env.TTYM_SESSION_ID ?? '', 10);
  if (!Number.isFinite(sid)) return '';
  // 에이전트에게만. 셸 통합 없는 셸에 붙이면 머리말이 명령의 일부로 실행된다(`[` 명령).
  if (!await isAgentSession(port, targetSessionId)) return '';
  const list = await fetchJson(port, '/api/workspaces').catch(() => null);
  const workspaces = Array.isArray(list) ? list : (list?.workspaces ?? []);
  for (const ws of workspaces) {
    const m = (ws.members ?? []).find((x: any) => x.sessionId === sid);
    // 받는 쪽이 그대로 복사해 되물을 수 있는 주소 — memberAddress의 ws/name은 주소 문법이 아니다.
    if (m) return `[ttym · from ${ws.name}:${m.name}] `;
  }
  return `[ttym · from #${sid}] `;
}

function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '';
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

/** 답 아래 두 줄: 턴 크기, 그리고 더 보는 명령. */
function footerLines(interaction: any): string[] {
  if (!interaction?.more) return [];
  const s = interaction.summary;
  const parts = [`turn ${interaction.id}`];
  if (s) {
    const d = formatDuration(s.durationMs);
    if (d) parts.push(d);
    const tools = Object.entries(s.tools as Record<string, number>).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${c}`).join(', ');
    parts.push(s.toolCount ? `tools ${s.toolCount} (${tools})` : 'no tools');
    if (s.filesEdited.length) parts.push(`edited ${s.filesEdited.length}: ${s.filesEdited.map((f: string) => f.split('/').pop()).slice(0, 4).join(', ')}${s.filesEdited.length > 4 ? ', …' : ''}`);
    if (s.errors) parts.push(`${s.errors} tool errors`);
  }
  return [`── ${parts.join(' · ')}`, `   more: ${interaction.more.outline}   (--full: tool inputs/outputs)`];
}

function printAwaitText(result: any, bare: boolean) {
  if (!result.output) return;
  process.stdout.write(result.output);
  if (!result.output.endsWith('\n')) process.stdout.write('\n');
  if (!bare) for (const line of footerLines(result.interaction)) process.stdout.write(`${line}\n`);
}

/** ttym await --id <interaction> — timeout으로 끊긴 요청을 이어서 기다린다. 요청은 서버에서 계속 돌고 있다. */
async function resumeAwait(port: number, iid: string, timeoutMs: number, raw: boolean, ownArgs: string[]) {
  const found = await fetchJson(port, `/api/interactions/${encodeURIComponent(iid)}`).catch(() => null);
  if (!found?.interaction) { console.error(`no interaction ${iid} (the server keeps them for a while after they settle)`); process.exit(EXIT.NOT_FOUND); }
  const sid = found.interaction.sessionId;
  const waited = await fetchRequest(port, 'GET', `/api/sessions/${sid}/interactions/${encodeURIComponent(iid)}?wait=${timeoutMs}`, undefined, timeoutMs + 15_000);
  const result = await awaitResult(port, sid, waited?.interaction ?? found.interaction, raw);
  if (hasFlag('--json')) return printOutput({ target: `#${sid}`, ...result }, true);
  reportAwaitStatus(result, timeoutMs);
  printAwaitText(result, ownArgs.includes('--bare'));
}

/**
 * timeout이면 여기서 끝낸다. 예전에는 그 순간의 화면을 답처럼 stdout에 찍고 0으로 나갔다 —
 * 백그라운드로 걸어 둔 에이전트는 그걸 "끝났다"로 읽는다. 화면이 필요하면 ttym screen.
 */
function reportAwaitStatus(result: any, timeoutMs: number) {
  if (result.interaction?.status === 'pending') {
    console.error(`timeout: still running after ${timeoutMs}ms — keep waiting: ttym await --id ${result.interaction.id}`);
    // 에이전트면 일부러 짧게 끊은 것(티켓)일 수 있다. 끝 신호가 없는 터미널일 때만 다른 길을 알려준다.
    if (!result.agent) console.error('  (no agent on that pane to signal the end: drive it with send and read it with ttym screen)');
    process.exit(EXIT.TIMEOUT);
  } else if (result.interaction?.status === 'failed') {
    console.error('agent ended the turn without answering');
  }
}

/** ttym turn <interaction> [--full|--path] — 끝난 턴을 transcript에서 다시 읽는다. */
export async function cmdTurn() {
  const args = process.argv.slice(3);
  const iid = args.find((a) => !a.startsWith('--'));
  if (!iid || args.includes('--help')) {
    console.error('usage: ttym turn <interaction-id> [--full | --path | --json]');
    console.error('  what an agent did in one await: every message, one line per tool call (--full: inputs/outputs).');
    console.error('  the id is on the footer under an await answer ("── turn int_…"), or interaction.id with --json.');
    process.exit(EXIT.USAGE);
  }
  // `ttym turn … | head` 가 파이프를 닫아도 스택을 찍지 않는다.
  process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
  const port = getPort();
  await ensureCompatibleServer(port);
  const detail = args.includes('--full') ? 'full' : 'outline';
  const res = await fetchJson(port, `/api/interactions/${encodeURIComponent(iid)}?detail=${detail}`).catch(() => null);
  if (!res?.interaction) { console.error(res?.error ?? `no interaction ${iid}`); process.exit(EXIT.NOT_FOUND); }
  if (args.includes('--path')) { console.log(res.interaction.turnPath ?? ''); return; }
  if (hasFlag('--json')) return printOutput(res, true);
  if (res.detail === null) { console.error(res.reason ?? 'no transcript for this turn'); process.exit(EXIT.FAIL); }
  process.stdout.write(res.detail.endsWith('\n') ? res.detail : `${res.detail}\n`);
}

export async function cmdAwaitAddr() {
  const args = process.argv.slice(3);
  const sep = args.indexOf('--');
  const prompt = sep !== -1 ? args.slice(sep + 1).join(' ') : '';
  const ownArgs = sep === -1 ? args : args.slice(0, sep);
  const token = args[0];
  const resumeId = readOption(ownArgs, '--id');
  if (resumeId) {
    const port = getPort();
    await ensureCompatibleServer(port);
    return resumeAwait(port, resumeId, parseInt(readOption(ownArgs, '--timeout') || '120000', 10), ownArgs.includes('--raw'), ownArgs);
  }
  if (!token || !prompt) {
    console.error('usage: ttym await <ws:name|:name|#id | --match \"expr\"> [--timeout ms] [--raw] [--bare] [--no-from] -- "prompt"');
    console.error('       ttym await --id <interaction> [--timeout ms]     keep waiting on one that timed out');
    process.exit(EXIT.USAGE);
  }
  const port = getPort();
  await ensureCompatibleServer(port);
  // 프롬프트는 -- 뒤에 온다. 플래그를 argv 전체에서 찾으면 프롬프트 본문의
  // '--raw' 나 '--timeout' 이 CLI 의 플래그로 읽힌다.
  const raw = ownArgs.includes('--raw');
  const timeoutMs = parseInt(readOption(ownArgs, '--timeout') || '120000', 10);
  if (token === '--match') {
    // 매칭된 멤버 각각에 순차 await — Stop hook 완료 감지가 멤버별 독립이라
    // 병렬도 되지만, 출력이 섞이지 않게 순서대로 묻는다.
    const targets = await resolveMatches(port, args[1] ?? '');
    const results = [];
    for (const t of targets) {
      const from = await senderPrefix(port, ownArgs, t.sessionId);
      results.push({ target: t.label, ...await awaitInteraction(port, t.sessionId, from + prompt, timeoutMs, raw) });
    }
    if (hasFlag('--json')) return printOutput(results, true);
    for (const entry of results) {
      console.log(`── ${entry.target} ──`);
      if (entry.output) printAwaitText(entry, ownArgs.includes('--bare'));
      else console.log(`(${entry.reason})`);
    }
    return;
  }
  const target = await resolveAddress(port, token);

  // 쉘 통합 신호가 보이는 세션이면 명령으로 실행한다 — Stop hook 없이
  // 133;D가 완료 신호이고, 답은 그 명령의 출력 구간이다.
  const shell = await shellAwait(port, target.sessionId, prompt.replace(/[\r\n]+$/, ''), timeoutMs);
  if (shell) {
    const output = shell.output === null ? null : (raw ? shell.output : cleanShellOutput(shell.output));
    if (hasFlag('--json')) {
      return printOutput({
        target: target.label,
        interaction: null,
        shell: shell.command ? {
          n: shell.command.n, cmdline: shell.command.cmdline,
          exitCode: shell.command.exitCode, durationMs: (shell.command.endedAt ?? 0) - shell.command.startedAt,
          truncated: shell.truncated,
        } : null,
        completed: shell.completed === true,
        reason: shell.completed === true ? 'done' : 'timeout',
        output,
      }, true);
    }
    if (!shell.completed) {
      console.error(`timeout: command still running after ${timeoutMs}ms`);
      process.exit(EXIT.FAIL);
    }
    if (shell.command.exitCode !== null && shell.command.exitCode !== 0) {
      console.error(`exit ${shell.command.exitCode}`);
    }
    if (output) process.stdout.write(output.endsWith('\n') ? output : output + '\n');
    return;
  }

  const from = await senderPrefix(port, ownArgs, target.sessionId);
  const result = await awaitInteraction(port, target.sessionId, from + prompt, timeoutMs, raw);
  if (hasFlag('--json')) return printOutput({ target: target.label, ...result }, true);
  reportAwaitStatus(result, timeoutMs);
  printAwaitText(result, ownArgs.includes('--bare'));
}
