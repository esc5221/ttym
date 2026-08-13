import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
const __dirname = dirname(fileURLToPath(import.meta.url));
import { readPid, GLOBAL, EXIT, getPort, apiBase, legacyBody, fetchJson, fetchPatch, fetchPost, fetchDelete, fetchRequest, ensureCompatibleServer, shellAwait, stripAnsi, cleanShellOutput, hasFlag, readOption, printOutput, encodeFrame, encodeDataFrame, decodeFrame, parseFrameJson, CMD, encoder, decoder, HOME_DIR, PID_FILE, LOG_FILE, SERVER_JS, HOLDER_BIN, HTTP_TIMEOUT_MS, ATTACH_RETRY_MS, DETACH_KEY } from './common.js';
import { isRuntimeMetaKey } from '@ttym/protocol';
import { listProjects, listWorkspaces, resolveCurrentWorkspace, resolveWorkspace, findMemberInWorkspace, createWorkspaceMember, requireMember, patchSessionMeta, memberAddress, normalizeAddressToken, getWorkspaceById, findWorkspaceBySessionId, getSessionIdsFromLayout } from './addresses.js';
// 이 파일은 C4b 분할로 main.ts에서 나왔다 — 동작 이동 없음, 구조 이동만.
export async function cmdMeta() {
  const sessionId = process.argv[3];
  if (!sessionId || isNaN(parseInt(sessionId, 10))) {
    console.error('usage: ttym meta <session-id> [--set key=value ...] [--claude-session <id>] [--claude-source <source>] [--clear-claude-session [id]] [--codex-session <id>] [--clear-codex-session [id]]');
    process.exit(EXIT.USAGE);
  }
  const id = parseInt(sessionId, 10);
  const port = getPort();
  await ensureCompatibleServer(port);
  const now = new Date().toISOString();

  // Collect --set key=value pairs and --claude-session shorthand
  const patch: Record<string, unknown> = {};
  let hasPatch = false;
  const args = process.argv.slice(4);
  let pendingClaudeSource = null;
  let pendingCodexSource = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--set' && args[i + 1]) {
      const [k, ...vParts] = args[i + 1].split('=');
      if (k && vParts.length > 0) {
        patch[k] = vParts.join('=');
        hasPatch = true;
      }
      i++;
    } else if (args[i] === '--claude-session' && args[i + 1]) {
      patch.claudeSessionId = args[i + 1];
      patch.claudeLastSessionId = args[i + 1];
      patch.claudeActive = true;
      patch.claudeLastStartedAt = now;
      patch.claudeLastStoppedAt = null;
      if (pendingClaudeSource) patch.claudeSessionSource = pendingClaudeSource;
      hasPatch = true;
      i++;
    } else if (args[i] === '--claude-source' && args[i + 1]) {
      pendingClaudeSource = args[i + 1];
      patch.claudeSessionSource = pendingClaudeSource;
      hasPatch = true;
      i++;
    } else if (args[i] === '--clear-claude-session') {
      const expectedId = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
      patch.claudeSessionId = null;
      patch.claudeActive = false;
      patch.claudeLastStoppedAt = now;
      if (expectedId) {
        patch.claudeLastSessionId = expectedId;
        i++;
      }
      hasPatch = true;
    } else if (args[i] === '--codex-session' && args[i + 1]) {
      patch.codexSessionId = args[i + 1];
      patch.codexLastSessionId = args[i + 1];
      patch.codexActive = true;
      patch.codexLastStartedAt = now;
      patch.codexLastStoppedAt = null;
      if (pendingCodexSource) patch.codexSessionSource = pendingCodexSource;
      hasPatch = true;
      i++;
    } else if (args[i] === '--codex-source' && args[i + 1]) {
      pendingCodexSource = args[i + 1];
      patch.codexSessionSource = pendingCodexSource;
      hasPatch = true;
      i++;
    } else if (args[i] === '--clear-codex-session') {
      const expectedId = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
      patch.codexSessionId = null;
      patch.codexActive = false;
      patch.codexLastStoppedAt = now;
      if (expectedId) {
        patch.codexLastSessionId = expectedId;
        i++;
      }
      hasPatch = true;
    }
  }

  try {
    if (hasPatch) {
      // Runtime keys (the agent mapping the hooks maintain) are server-owned
      // and travel through the internal endpoint; the public PATCH rejects
      // them. Annotations keep going through the public surface. One command
      // can carry both, so the patch is split.
      const runtime = {};
      const annotations = {};
      for (const [key, value] of Object.entries(patch)) {
        (isRuntimeMetaKey(key) ? runtime : annotations)[key] = value;
      }
      let result = null;
      if (Object.keys(runtime).length > 0) {
        result = await fetchPost(port, `/api/internal/sessions/${id}/agent`, runtime);
        // A pre-split server has no internal endpoint but accepts runtime keys
        // on the public PATCH; fall back so the hooks keep working against it.
        if (result && result.error) {
          result = await fetchPatch(port, `/api/sessions/${id}/meta`, runtime);
        }
      }
      if (Object.keys(annotations).length > 0) {
        result = await fetchPatch(port, `/api/sessions/${id}/meta`, annotations);
      }
      console.log(JSON.stringify(result, null, 2));
    } else {
      const result = await fetchJson(port, `/api/sessions/${id}/meta`);
      console.log(JSON.stringify(result, null, 2));
    }
  } catch {
    console.error('failed to connect to ttym server');
    process.exit(EXIT.NO_SERVER);
  }
}
export async function cmdCurrent() {
  const port = getPort();
  await ensureCompatibleServer(port);
  const asJson = hasFlag('--json');
  const workspace = await resolveCurrentWorkspace(port);
  const sessionId = parseInt(process.env.TTYM_SESSION_ID, 10);
  const member = (workspace.members || []).find((entry) => entry.sessionId === sessionId) || null;
  const result = {
    project: workspace.project,
    workspace: {
      id: workspace.id,
      name: workspace.name,
      address: `${workspace.project}/${workspace.name}`,
    },
    member: member ? {
      name: member.name,
      role: member.role || null,
      sessionId: member.sessionId,
      address: memberAddress(workspace, member),
    } : null,
    sessionId,
  };
  if (asJson) return printOutput(result, true);
  console.log(`project:   ${result.project}`);
  console.log(`workspace: ${result.workspace.address}`);
  if (result.member) console.log(`member:    ${result.member.name} (#${result.member.sessionId})`);
  console.log(`session:   #${result.sessionId}`);
}

export async function cmdProject() {
  const action = process.argv[3];
  const port = getPort();
  await ensureCompatibleServer(port);
  const asJson = hasFlag('--json');

  if (action === 'list') {
    const projects = await listProjects(port);
    if (asJson) return printOutput(projects, true);
    for (const project of projects) {
      console.log(`${project.name}  workspaces=${project.workspaceCount} members=${project.memberCount}`);
    }
    return;
  }

  console.log('usage: ttym project list [--json]');
  process.exit(EXIT.USAGE);
}

export async function cmdWorkspace() {
  const action = process.argv[3];
  const args = process.argv.slice(4);
  const port = getPort();
  await ensureCompatibleServer(port);
  const asJson = hasFlag('--json');

  if (action === 'list') {
    const targetProject = args[0] && !args[0].startsWith('--') ? args[0] : null;
    const workspaces = await listWorkspaces(port, targetProject);
    if (asJson) return printOutput(workspaces, true);
    for (const workspace of workspaces) {
      console.log(`${workspace.project}/${workspace.name}  id=${workspace.id}  members=${workspace.members.length}`);
    }
    return;
  }

  if (action === 'info') {
    const token = args[0];
    const workspace = await resolveWorkspace(port, token);
    const result = {
      workspaceId: workspace.id,
      project: workspace.project,
      name: workspace.name,
      address: `${workspace.project}/${workspace.name}`,
      members: (workspace.members || []).map((member) => ({
        name: member.name,
        role: member.role || null,
        sessionId: member.sessionId,
        status: null,
      })),
    };
    const sessions = await fetchJson(port, '/api/sessions').catch(() => []);
    const sessionById = new Map((Array.isArray(sessions) ? sessions : []).map((session) => [session.id, session]));
    result.members = result.members.map((member) => ({
      ...member,
      status: sessionById.get(member.sessionId)?.status ?? 'missing',
      cmd: sessionById.get(member.sessionId)?.cmd ?? [],
    }));
    if (asJson) return printOutput(result, true);
    console.log(`${result.address} (${result.workspaceId})`);
    for (const member of result.members) {
      console.log(`  - ${member.name}  #${member.sessionId}  [${member.status}] ${member.cmd.join(' ')}`);
    }
    return;
  }

  if (action === 'create') {
    const project = args[0] && !args[0].startsWith('--') ? args[0] : 'default';
    const name = readOption(args, '--name');
    if (!name) {
      console.error('usage: ttym workspace create <project> --name <name> [--json]');
      process.exit(EXIT.USAGE);
    }
    const id = randomUUID().slice(0, 8);
    const workspace = await fetchPost(port, '/api/workspaces', {
      id,
      project,
      name,
      layout: { type: 'pane', sessionId: 0 },
      members: [],
    });
    if (asJson) return printOutput(workspace, true);
    console.log(`${workspace.project}/${workspace.name} (${workspace.id})`);
    return;
  }

  if (action === 'delete') {
    const workspace = await resolveWorkspace(port, args[0]);
    for (const member of workspace.members || []) {
      await fetchDelete(port, `/api/sessions/${member.sessionId}`);
    }
    await fetchDelete(port, `/api/workspaces/${encodeURIComponent(workspace.id)}`);
    if (asJson) return printOutput({ ok: true, deleted: workspace.id }, true);
    console.log(`deleted ${workspace.project}/${workspace.name}`);
    return;
  }

  if (action === 'layout') {
    const workspace = await resolveWorkspace(port, args[0]);
    const spec = args[1];
    if (!spec) {
      console.error('usage: ttym workspace layout <workspace|--current> <even-h|even-v|main-v|tiled|auto|layout-json>');
      process.exit(EXIT.USAGE);
    }
    // tmux select-layout: 프리셋 이름과 커스텀 트리를 같은 입구로 받는다.
    const presets = ['even-h', 'even-v', 'main-v', 'tiled', 'auto'];
    const patch = presets.includes(spec) ? { preset: spec } : { layout: JSON.parse(spec) };
    const next = await fetchPatch(port, `/api/workspaces/${encodeURIComponent(workspace.id)}`, patch);
    if (asJson) return printOutput(next, true);
    console.log(`${next.project}/${next.name} layout updated`);
    return;
  }

  if (action === 'rename') {
    const workspace = await resolveWorkspace(port, args[0]);
    const name = readOption(args, '--name');
    if (!name) {
      console.error('usage: ttym workspace rename <workspace|--current> --name <name>');
      process.exit(EXIT.USAGE);
    }
    const next = await fetchPatch(port, `/api/workspaces/${encodeURIComponent(workspace.id)}`, { name });
    if (asJson) return printOutput(next, true);
    console.log(`${next.project}/${next.name}`);
    return;
  }

  if (action === 'add') {
    const workspace = await resolveWorkspace(port, args[0]);
    const name = readOption(args, '--name');
    const role = readOption(args, '--role');
    const cmdIndex = args.indexOf('--cmd');
    const cmd = cmdIndex !== -1 ? args.slice(cmdIndex + 1).filter((value) => value !== '--json') : null;
    try {
      const { workspace: updated, member, session } = await createWorkspaceMember(port, workspace, {
        name, role, cmd,
      });
      const result = {
        workspace: `${updated.project}/${updated.name}`,
        member: { ...member, address: memberAddress(updated, member) },
        session,
      };
      if (asJson) return printOutput(result, true);
      console.log(`added ${result.member.address} -> #${session.id}`);
    } catch (e) {
      if (asJson) return printOutput({ error: e.message }, true);
      console.error(`workspace add failed: ${e.message}`);
      process.exit(EXIT.FAIL);
    }
    return;
  }

  if (action === 'terminate') {
    // 처음부터 remove와 동일 동작이었다(v2 잔재). 이름 하나, 동작 하나.
    console.error("`terminate` is gone — use: ttym workspace remove <workspace|--current> <member>");
    process.exit(EXIT.USAGE);
  }

  if (action === 'remove' || action === 'detach') {
    const workspace = await resolveWorkspace(port, args[0]);
    const member = requireMember(workspace, args[1]);
    await fetchDelete(port, `/api/workspaces/${encodeURIComponent(workspace.id)}/members/${member.sessionId}`);
    if (action === 'detach') {
      await patchSessionMeta(port, member.sessionId, {
        project: null,
        workspaceId: null,
        workspaceName: null,
      });
    }
    if (action === 'remove') {
      await fetchDelete(port, `/api/sessions/${member.sessionId}`);
    }
    const result = { ok: true, action, workspace: `${workspace.project}/${workspace.name}`, member: member.name, sessionId: member.sessionId };
    if (asJson) return printOutput(result, true);
    console.log(`${action}d ${workspace.project}/${workspace.name}/${member.name} (#${member.sessionId})`);
    return;
  }

  if (action === 'send') {
    const sep = args.indexOf('--');
    const payload = sep !== -1 ? args.slice(sep + 1).join(' ') : '';
    const workspace = await resolveWorkspace(port, args[0]);
    const member = requireMember(workspace, args[1]);
    if (!payload) {
      console.error('usage: ttym workspace send <workspace|--current> <member> -- "command\\n"');
      process.exit(EXIT.USAGE);
    }
    const result = await fetchPost(port, `/api/sessions/${member.sessionId}/send`, { data: payload });
    if (asJson) return printOutput(result, true);
    console.log(`sent to ${workspace.project}/${workspace.name}/${member.name}`);
    return;
  }

  if (action === 'await') {
    const workspace = await resolveWorkspace(port, args[0]);
    const member = requireMember(workspace, args[1]);
    const sep = args.indexOf('--');
    const payload = sep !== -1 ? args.slice(sep + 1).join(' ') : '';
    const timeoutMs = parseInt(readOption(args, '--timeout') || '120000', 10);

    // The server owns the request/response pairing now: it marks the buffer,
    // submits the prompt, and holds the reply until the agent's hook settles
    // it. Nothing polls, so a fast answer comes back as fast as it lands.
    const text = payload.replace(/[\r\n]+$/, '');

    // 쉘 통합 세션이면 명령 실행 경로 — 완료 신호는 hook이 아니라 133;D다.
    const shell = await shellAwait(port, member.sessionId, text, timeoutMs);
    if (shell) {
      const output = shell.output === null ? null : (hasFlag('--raw') ? shell.output : cleanShellOutput(shell.output));
      const result = {
        workspace: `${workspace.project}/${workspace.name}`,
        member: member.name,
        sessionId: member.sessionId,
        interaction: null,
        shell: shell.command ? {
          n: shell.command.n, cmdline: shell.command.cmdline,
          exitCode: shell.command.exitCode, durationMs: (shell.command.endedAt ?? 0) - shell.command.startedAt,
          truncated: shell.truncated,
        } : null,
        completed: shell.completed === true,
        screen: output,
      };
      if (asJson) return printOutput(result, true);
      if (!shell.completed) {
        console.error(`timeout: command still running after ${timeoutMs}ms`);
        process.exit(EXIT.FAIL);
      }
      if (shell.command.exitCode !== null && shell.command.exitCode !== 0) console.error(`exit ${shell.command.exitCode}`);
      if (output) process.stdout.write(output.endsWith('\n') ? output : output + '\n');
      return;
    }
    // The server holds this request open until the agent's hook settles it, so
    // the socket timeout has to outlast the interaction timeout, not the
    // default 5s meant for ordinary calls.
    const response = await fetchRequest(port, 'POST', `/api/sessions/${member.sessionId}/interactions`, {
      prompt: text,
      timeoutMs,
      submit: 'cr',
    }, timeoutMs + 15_000);
    const interaction = response?.interaction ?? null;
    const completed = interaction?.status === 'completed';

    // A transcript read off a degraded screen (gap recovery, not yet
    // repainted) is approximate — say so instead of letting it pass as exact.
    if (interaction?.integrity === 'degraded') {
      process.stderr.write('warning: screen integrity is degraded — transcript may be approximate\n');
    }
    // `--raw` predates transcripts and meant "the screen with its escapes".
    // Keep that meaning, and fall back to it when the marked rows are gone.
    let output = interaction?.transcript ?? null;
    if (hasFlag('--raw') || output === null) {
      const screen = await fetchJson(port, `/api/sessions/${member.sessionId}/screen`).catch(() => null);
      output = screen?.screen ?? '';
    }

    const result = {
      workspace: `${workspace.project}/${workspace.name}`,
      member: member.name,
      sessionId: member.sessionId,
      interaction: interaction ? {
        id: interaction.id,
        status: interaction.status,
        // 추출 품질은 숨기지 않는다 — 어디서 온 답인지, 화면이 온전했는지.
        transcriptSource: interaction.transcriptSource ?? null,
        integrity: interaction.integrity ?? null,
      } : null,
      completed,
      screen: output,
    };
    if (asJson) return printOutput(result, true);
    if (interaction?.status === 'pending') {
      console.error(`timeout: still running after ${timeoutMs}ms — resume with id ${interaction.id}`);
    } else if (interaction?.status === 'failed') {
      console.error('agent ended the turn without answering');
    } else if (interaction && interaction.transcript === null) {
      console.error('transcript unavailable: the marked rows scrolled out of the buffer');
    }
    process.stdout.write(output);
    if (output && !output.endsWith('\n')) process.stdout.write('\n');
    return;
  }

  if (action === 'screen') {
    const workspace = await resolveWorkspace(port, args[0]);
    const member = requireMember(workspace, args[1]);
    const result = await fetchJson(port, `/api/sessions/${member.sessionId}/screen`);
    if (asJson) return printOutput({
      workspace: `${workspace.project}/${workspace.name}`,
      member: member.name,
      sessionId: member.sessionId,
      screen: result?.screen ?? '',
    }, true);
    process.stdout.write(result?.screen ?? '');
    return;
  }

  if (action === 'member' && args[0] === 'rename') {
    const workspace = await resolveWorkspace(port, args[1]);
    const member = requireMember(workspace, args[2]);
    const name = readOption(args, '--name');
    if (!name) {
      console.error('usage: ttym workspace member rename <workspace|--current> <member> --name <name>');
      process.exit(EXIT.USAGE);
    }
    const updated = await fetchPatch(port, `/api/workspaces/${encodeURIComponent(workspace.id)}/members/${member.sessionId}`, { name });
    await patchSessionMeta(port, member.sessionId, {
      project: updated.project,
      workspaceId: updated.id,
      workspaceName: updated.name,
      memberName: name,
      name,
    });
    const renamed = updated.members.find((entry) => entry.sessionId === member.sessionId);
    if (asJson) return printOutput(renamed, true);
    console.log(`${updated.project}/${updated.name}/${renamed.name}`);
    return;
  }

  console.log('usage: ttym workspace <command>');
  console.log('');
  console.log('commands:');
  console.log('  list [project] [--json]');
  console.log('  info <workspace|--current> [--json]');
  console.log('  create <project> --name <name> [--json]');
  console.log('  rename <workspace|--current> --name <name>');
  console.log('  delete <workspace|--current> [--json]');
  console.log('  add <workspace|--current> [--name <name>] [--role <role>] [--cmd ...] [--json]');
  console.log('  remove <workspace|--current> <member> [--json]');
  console.log('  detach <workspace|--current> <member> [--json]');
  console.log('  send <workspace|--current> <member> -- \"command\\\\n\"');
  console.log('  await <workspace|--current> <member> [-- \"prompt\"] [--timeout ms] [--json]');
  console.log('  screen <workspace|--current> <member> [--json]');
  console.log('  member rename <workspace|--current> <member> --name <name>');
  process.exit(EXIT.USAGE);
}
