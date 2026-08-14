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
export async function cmdNew() {
  const args = process.argv.slice(3);
  const name = args[0] && !args[0].startsWith('-') ? args[0] : null;
  if (!name) {
    console.error('usage: ttym new <name> [-- <cmd...>]');
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
  const { workspace: updated, member, session } = await createWorkspaceMember(port, workspace, { name, cmd });
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
    console.error('usage: ttym split <ws:name|:name> <new-name> [-- <cmd...>]');
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
  const body: Record<string, unknown> = { targetSessionId: target.sessionId, name };
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

export async function cmdScreenAddr() {
  const args = process.argv.slice(3);
  const token = args[0];
  if (!token) {
    console.error('usage: ttym screen <ws:name|:name|#id | --match \"expr\"> [--json]');
    process.exit(EXIT.USAGE);
  }
  const port = getPort();
  await ensureCompatibleServer(port);
  if (token === '--match') {
    const targets = await resolveMatches(port, args[1] ?? '');
    const screens = [];
    for (const target of targets) {
      const result = await fetchJson(port, `/api/sessions/${target.sessionId}/screen`);
      screens.push({ target: target.label, screen: result?.screen ?? '' });
    }
    if (hasFlag('--json')) return printOutput(screens, true);
    for (const entry of screens) {
      console.log(`── ${entry.target} ──`);
      process.stdout.write(entry.screen.endsWith('\n') ? entry.screen : entry.screen + '\n');
    }
    return;
  }
  const target = await resolveAddress(port, token);
  const result = await fetchJson(port, `/api/sessions/${target.sessionId}/screen`);
  if (hasFlag('--json')) return printOutput({ target: target.label, screen: result?.screen ?? '' }, true);
  process.stdout.write(result?.screen ?? '');
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

export async function cmdAwaitAddr() {
  const args = process.argv.slice(3);
  const sep = args.indexOf('--');
  const prompt = sep !== -1 ? args.slice(sep + 1).join(' ') : '';
  const token = args[0];
  if (!token || !prompt) {
    console.error('usage: ttym await <ws:name|:name|#id | --match \"expr\"> [--timeout ms] -- "prompt"');
    process.exit(EXIT.USAGE);
  }
  const port = getPort();
  await ensureCompatibleServer(port);
  const timeoutMs = parseInt(readOption(args, '--timeout') || '120000', 10);
  if (token === '--match') {
    // 매칭된 멤버 각각에 순차 await — Stop hook 완료 감지가 멤버별 독립이라
    // 병렬도 되지만, 출력이 섞이지 않게 순서대로 묻는다.
    const targets = await resolveMatches(port, args[1] ?? '');
    const results = [];
    for (const t of targets) {
      const response = await fetchRequest(port, 'POST', `/api/sessions/${t.sessionId}/interactions`, {
        prompt: prompt.replace(/[\r\n]+$/, ''),
        timeoutMs,
        submit: 'cr',
      }, timeoutMs + 15_000);
      results.push({ target: t.label, interaction: response?.interaction ?? null });
    }
    if (hasFlag('--json')) return printOutput(results, true);
    for (const entry of results) {
      console.log(`── ${entry.target} ──`);
      console.log(entry.interaction?.transcript ?? `(${entry.interaction?.status ?? 'no response'})`);
    }
    return;
  }
  const target = await resolveAddress(port, token);

  // 쉘 통합 신호가 보이는 세션이면 명령으로 실행한다 — Stop hook 없이
  // 133;D가 완료 신호이고, 답은 그 명령의 출력 구간이다.
  const shell = await shellAwait(port, target.sessionId, prompt.replace(/[\r\n]+$/, ''), timeoutMs);
  if (shell) {
    const output = shell.output === null ? null : (hasFlag('--raw') ? shell.output : cleanShellOutput(shell.output));
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

  const response = await fetchRequest(port, 'POST', `/api/sessions/${target.sessionId}/interactions`, {
    prompt: prompt.replace(/[\r\n]+$/, ''),
    timeoutMs,
    submit: 'cr',
  }, timeoutMs + 15_000);
  const interaction = response?.interaction ?? null;

  let output = interaction?.transcript ?? null;
  if (output === null) {
    const screen = await fetchJson(port, `/api/sessions/${target.sessionId}/screen`).catch(() => null);
    output = screen?.screen ?? '';
  }
  if (hasFlag('--json')) {
    return printOutput({
      target: target.label,
      interaction: interaction ? {
        id: interaction.id,
        status: interaction.status,
        // 추출 품질은 숨기지 않는다 — 어디서 온 답인지, 화면이 온전했는지.
        transcriptSource: interaction.transcriptSource ?? null,
        integrity: interaction.integrity ?? null,
      } : null,
      completed: interaction?.status === 'completed',
      output,
    }, true);
  }
  if (interaction?.status === 'pending') {
    console.error(`timeout: still running after ${timeoutMs}ms — resume with id ${interaction.id}`);
  } else if (interaction?.status === 'failed') {
    console.error('agent ended the turn without answering');
  }
  process.stdout.write(output);
  if (output && !output.endsWith('\n')) process.stdout.write('\n');
}
