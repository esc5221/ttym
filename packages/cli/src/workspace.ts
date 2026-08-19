import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
const __dirname = dirname(fileURLToPath(import.meta.url));
import { readPid, GLOBAL, EXIT, getPort, apiBase, legacyBody, fetchJson, fetchPatch, fetchPost, fetchDelete, fetchRequest, ensureCompatibleServer, shellAwait, stripAnsi, cleanShellOutput, hasFlag, readOption, printOutput, encodeFrame, encodeDataFrame, decodeFrame, parseFrameJson, CMD, encoder, decoder, HOME_DIR, PID_FILE, LOG_FILE, SERVER_JS, HOLDER_BIN, HTTP_TIMEOUT_MS, ATTACH_RETRY_MS, DETACH_KEY } from './common.js';
import { isRuntimeMetaKey } from '@ttym/protocol';
import { listWorkspaces, resolveCurrentWorkspace, resolveWorkspace, findMemberInWorkspace, createWorkspaceMember, requireMember, patchSessionMeta, memberAddress, normalizeAddressToken, getWorkspaceById, findWorkspaceBySessionId, getSessionIdsFromLayout } from './addresses.js';
import { geometryOptions } from './sessions.js';
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
    workspace: {
      id: workspace.id,
      name: workspace.name,
      address: workspace.name,
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
  console.log(`workspace: ${result.workspace.address}`);
  if (result.member) console.log(`member:    ${result.member.name} (#${result.member.sessionId})`);
  console.log(`session:   #${result.sessionId}`);
}

export async function cmdWorkspace() {
  const action = process.argv[3];
  const args = process.argv.slice(4);
  const port = getPort();
  await ensureCompatibleServer(port);
  const asJson = hasFlag('--json');

  if (action === 'list') {
    const workspaces = await listWorkspaces(port);
    if (asJson) return printOutput(workspaces, true);
    for (const workspace of workspaces) {
      console.log(`${workspace.name}  id=${workspace.id}  members=${workspace.members.length}`);
    }
    return;
  }

  if (action === 'info') {
    const token = args[0];
    const workspace = await resolveWorkspace(port, token);
    const result = {
      workspaceId: workspace.id,
        name: workspace.name,
      address: workspace.name,
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
    // 이름이 곧 주소다: ttym workspace create mathking
    const positional = args[0] && !args[0].startsWith('--') ? args[0] : null;
    const flagged = readOption(args, '--name');
    if (positional && flagged && positional !== flagged) {
      console.error(`conflicting names: "${positional}" vs --name "${flagged}" (projects are gone — one name is the address)`);
      process.exit(EXIT.USAGE);
    }
    const name = positional || flagged;
    if (!name) {
      console.error('usage: ttym workspace create <name> [--json]');
      process.exit(EXIT.USAGE);
    }
    const id = randomUUID().slice(0, 8);
    const workspace = await fetchPost(port, '/api/workspaces', {
      id,
      name,
      layout: { type: 'pane', sessionId: 0 },
      members: [],
    });
    if (asJson) return printOutput(workspace, true);
    console.log(`${workspace.name} (${workspace.id})`);
    return;
  }

  if (action === 'delete') {
    const workspace = await resolveWorkspace(port, args[0]);
    for (const member of workspace.members || []) {
      await fetchDelete(port, `/api/sessions/${member.sessionId}`);
    }
    await fetchDelete(port, `/api/workspaces/${encodeURIComponent(workspace.id)}`);
    if (asJson) return printOutput({ ok: true, deleted: workspace.id }, true);
    console.log(`deleted ${workspace.name}`);
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
    console.log(`${next.name} layout updated`);
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
    console.log(`${next.name}`);
    return;
  }

  if (action === 'add') {
    const workspace = await resolveWorkspace(port, args[0]);
    const cmdIndex = args.indexOf('--cmd');
    const ownArgs = cmdIndex === -1 ? args : args.slice(0, cmdIndex);
    const name = readOption(ownArgs, '--name');
    const role = readOption(ownArgs, '--role');
    const cmd = cmdIndex !== -1 ? args.slice(cmdIndex + 1).filter((value) => value !== '--json') : null;
    try {
      const { workspace: updated, member, session } = await createWorkspaceMember(port, workspace, {
        name, role, cmd, ...geometryOptions(ownArgs),
      });
      const result = {
        workspace: `${updated.name}`,
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

  if (action === 'remove' || action === 'detach') {
    const workspace = await resolveWorkspace(port, args[0]);
    const member = requireMember(workspace, args[1]);
    await fetchDelete(port, `/api/workspaces/${encodeURIComponent(workspace.id)}/members/${member.sessionId}`);
    if (action === 'detach') {
      await patchSessionMeta(port, member.sessionId, {
        workspaceId: null,
        workspaceName: null,
      });
    }
    if (action === 'remove') {
      await fetchDelete(port, `/api/sessions/${member.sessionId}`);
    }
    const result = { ok: true, action, workspace: `${workspace.name}`, member: member.name, sessionId: member.sessionId };
    if (asJson) return printOutput(result, true);
    console.log(`${action}d ${workspace.name}/${member.name} (#${member.sessionId})`);
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
      workspaceId: updated.id,
      workspaceName: updated.name,
      memberName: name,
      name,
    });
    const renamed = updated.members.find((entry) => entry.sessionId === member.sessionId);
    if (asJson) return printOutput(renamed, true);
    console.log(`${updated.name}/${renamed.name}`);
    return;
  }

  console.log('usage: ttym workspace <command>');
  console.log('');
  console.log('commands:');
  console.log('  list [--json]');
  console.log('  info <workspace|--current> [--json]');
  console.log('  create <name> [--json]');
  console.log('  rename <workspace|--current> --name <name>');
  console.log('  delete <workspace|--current> [--json]');
  console.log('  add <workspace|--current> [--name <name>] [--role <role>] [--cwd <dir>] [--size <cols>x<rows>] [--cmd ...] [--json]');
  console.log('  remove <workspace|--current> <member> [--json]');
  console.log('  detach <workspace|--current> <member> [--json]');
  console.log('  send <workspace|--current> <member> -- \"command\\\\n\"');
  console.log('  await <workspace|--current> <member> [-- \"prompt\"] [--timeout ms] [--json]');
  console.log('  screen <workspace|--current> <member> [--json]');
  console.log('  member rename <workspace|--current> <member> --name <name>');
  process.exit(EXIT.USAGE);
}
