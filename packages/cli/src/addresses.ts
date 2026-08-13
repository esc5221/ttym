import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
const __dirname = dirname(fileURLToPath(import.meta.url));
import { readPid, GLOBAL, EXIT, getPort, apiBase, legacyBody, fetchJson, fetchPatch, fetchPost, fetchDelete, fetchRequest, ensureCompatibleServer, hasFlag, readOption, printOutput, encodeFrame, encodeDataFrame, decodeFrame, parseFrameJson, CMD, encoder, decoder, HOME_DIR, PID_FILE, LOG_FILE, SERVER_JS, HOLDER_BIN, HTTP_TIMEOUT_MS, ATTACH_RETRY_MS, DETACH_KEY } from './common.js';
// 이 파일은 C4b 분할로 main.ts에서 나왔다 — 동작 이동 없음, 구조 이동만.
export async function listWorkspaces(port) {
  return await fetchJson(port, '/api/workspaces');
}

export async function getWorkspaceById(port, id) {
  return await fetchJson(port, `/api/workspaces/${encodeURIComponent(id)}`);
}

export function normalizeAddressToken(value) {
  if (!value) return null;
  return value.replace(/^\/+|\/+$/g, '');
}

export function getSessionIdsFromLayout(node) {
  if (!node) return [];
  if (node.type === 'pane') return node.sessionId > 0 ? [node.sessionId] : [];
  return Array.isArray(node.children) ? node.children.flatMap(getSessionIdsFromLayout) : [];
}

export function findWorkspaceBySessionId(workspaces, sessionId) {
  return workspaces.find((workspace) => getSessionIdsFromLayout(workspace.layout).includes(sessionId)) || null;
}

export async function resolveCurrentWorkspace(port) {
  const sid = process.env.TTYM_SESSION_ID;
  if (!sid || isNaN(parseInt(sid, 10))) {
    console.error('current workspace resolution requires TTYM_SESSION_ID');
    process.exit(EXIT.FAIL);
  }
  const sessionId = parseInt(sid, 10);
  const workspaces = await listWorkspaces(port);
  const workspace = findWorkspaceBySessionId(workspaces, sessionId);
  if (!workspace) {
    console.error(`current session #${sessionId} is not assigned to a workspace`);
    process.exit(EXIT.NOT_FOUND);
  }
  return workspace;
}

export async function resolveWorkspace(port, token) {
  if (!token || token === '--current') {
    return resolveCurrentWorkspace(port);
  }

  const normalized = normalizeAddressToken(token);
  if (!normalized) {
    console.error('workspace target is required');
    process.exit(EXIT.USAGE);
  }

  const direct = await getWorkspaceById(port, normalized);
  if (direct?.id) return direct;

  const workspaces = await listWorkspaces(port);
  const match = workspaces.find((workspace) => workspace.name === normalized);
  if (match) return match;

  console.error(`workspace not found: ${token}`);
  process.exit(EXIT.NOT_FOUND);
}

export async function resolveAttachTarget(port, token, options: Record<string, any> = {}) {
  const { createIfMissing = false, createOptions = {} } = options;
  const normalized = normalizeAddressToken(token);
  if (!normalized) {
    console.error('attach target is required');
    process.exit(EXIT.USAGE);
  }

  if (/^\d+$/.test(normalized)) {
    if (createIfMissing) {
      console.error('--new requires a workspace/member address, not a raw session id');
      process.exit(EXIT.USAGE);
    }
    const sessionId = parseInt(normalized, 10);
    return {
      sessionId,
      label: `#${sessionId}`,
      workspace: null,
      member: null,
    };
  }

  const parts = normalized.split('/');
  let workspace = null;
  let memberToken = null;

  const workspaces = await listWorkspaces(port);
  if (parts.length === 2) {
    const [workspaceName, rest] = parts;
    workspace = workspaces.find((ws) => ws.name === workspaceName) ?? null;
    memberToken = rest;
  } else if (parts.length === 1) {
    // tmux 문법: `ttym attach work` — 이름만으로 도달하고, --new 면 만들어서 들어간다.
    workspace = workspaces.find((ws) => ws.name === normalized) ?? null;
    if (workspace) {
      const members = workspace.members || [];
      if (members.length === 0 && !createIfMissing) {
        console.error(`workspace has no members: ${normalized}`);
        process.exit(EXIT.NOT_FOUND);
      }
      // 멤버 하나면 그것, 여럿이면 첫 멤버 — 이후 C-b n/p 로 순회
      memberToken = members[0]?.name ?? 'main';
    } else if (createIfMissing) {
      workspace = await fetchPost(port, '/api/workspaces', {
        id: randomUUID().slice(0, 8),
        name: normalized,
        layout: { type: 'pane', sessionId: 0 },
        members: [],
      });
      memberToken = 'main';
    }
  }

  if (!workspace) {
    console.error(`attach target not found: ${token}`);
    process.exit(EXIT.NOT_FOUND);
  }

  const existing = findMemberInWorkspace(workspace, memberToken);
  if (existing) {
    return {
      sessionId: existing.sessionId,
      label: memberAddress(workspace, existing),
      workspace,
      member: existing,
    };
  }

  if (!createIfMissing) {
    console.error(`member not found: ${memberToken}`);
    process.exit(EXIT.NOT_FOUND);
  }

  if (/^\d+$/.test(normalizeAddressToken(memberToken) || '')) {
    console.error('--new requires a member name, not a session id');
    process.exit(EXIT.USAGE);
  }

  const created = await createWorkspaceMember(port, workspace, {
    ...createOptions,
    name: createOptions.name || memberToken,
  });
  return {
    sessionId: created.session.id,
    label: memberAddress(created.workspace, created.member),
    workspace: created.workspace,
    member: created.member,
  };
}

export function findMemberInWorkspace(workspace, token) {
  const normalized = normalizeAddressToken(token);
  if (!normalized) return null;
  const members = workspace.members || [];
  const byName = members.find((m) => m.name === normalized);
  if (byName) return byName;
  if (/^\d+$/.test(normalized)) {
    const sid = parseInt(normalized, 10);
    return members.find((m) => m.sessionId === sid) || null;
  }
  return null;
}

export async function createWorkspaceMember(port, workspace, opts: Record<string, any> = {}) {
  const { name, role = null, cmd = null, cwd = null } = opts;
  const usedNames = new Set((workspace.members || []).map((m) => m.name));
  let memberName = name;
  if (!memberName) {
    let index = 1;
    while (usedNames.has(`term-${index}`)) index += 1;
    memberName = `term-${index}`;
  } else if (usedNames.has(memberName)) {
    throw new Error(`member name already exists: ${memberName}`);
  }
  const sessionBody: Record<string, unknown> = {
    cmd: cmd && cmd.length > 0 ? cmd : [process.env.SHELL || '/bin/bash'],
    cols: 80,
    rows: 24,
    verify: true,
  };
  if (cwd) sessionBody.cwd = cwd;
  const created = await fetchPost(port, '/api/sessions', sessionBody);
  if (created.error) {
    throw new Error(created.error);
  }
  const updated = await fetchPost(port, `/api/workspaces/${encodeURIComponent(workspace.id)}/members`, {
    sessionId: created.id,
    name: memberName,
    role: role || undefined,
    tags: [],
  });
  await patchSessionMeta(port, created.id, {
    workspaceId: updated.id,
    workspaceName: updated.name,
    memberName,
    role: role || null,
    name: memberName,
  });
  const member = updated.members.find((entry) => entry.sessionId === created.id);
  return { workspace: updated, member, session: created };
}

export function requireMember(workspace, token) {
  const normalized = normalizeAddressToken(token);
  if (!normalized) {
    console.error('member target is required');
    process.exit(EXIT.USAGE);
  }

  const byName = (workspace.members || []).filter((member) => member.name === normalized);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    console.error(`member name is ambiguous: ${normalized}`);
    process.exit(EXIT.NOT_FOUND);
  }

  if (/^\d+$/.test(normalized)) {
    const sessionId = parseInt(normalized, 10);
    const byId = (workspace.members || []).find((member) => member.sessionId === sessionId);
    if (byId) return byId;
  }

  console.error(`member not found: ${token}`);
  process.exit(EXIT.NOT_FOUND);
}

export async function patchSessionMeta(port, sessionId, patch) {
  return await fetchPatch(port, `/api/sessions/${sessionId}/meta`, patch);
}

export function memberAddress(workspace, member) {
  return `${workspace.name}/${member.name}`;
}
// ───── Colon addresses and the top-level verbs (D2, expand phase) ─────
//
// One address grammar for the daily verbs:
//   ws:name    member "name" in workspace "ws" (workspace resolved by name,
//              — 이름이 전역 유일이라 그대로 주소다)
//   :name      member "name" in the current workspace ($TTYM_SESSION_ID)
//   #42        session 42 directly — the only address an unattached session
//              has, per ADR-0001
//
// These sit beside the old `workspace <verb> <ws> <member>` forms, which keep
// working untouched. Removal of the old grammar is a later, separate step.

/**
 * kitty --match 축소판: 'field:query'를 and로 조합해 멤버 집합을 고른다.
 *   필드  name role tag ws state id
 *   state idle | busy (에이전트 turn 진행 여부) | agent | shell
 * 숫자 필드(id)는 숫자로, 나머지는 부분 문자열로 비교한다.
 */
export async function resolveMatches(port, expr) {
  const clauses = expr.split(/\s+and\s+/).map((clause) => {
    const at = clause.indexOf(':');
    if (at === -1) {
      console.error(`not a matcher: ${clause} (expected field:query)`);
      process.exit(EXIT.USAGE);
    }
    return { field: clause.slice(0, at).trim(), query: clause.slice(at + 1).trim() };
  });
  const needsState = clauses.some((c) => c.field === 'state');

  const workspaces = await fetchJson(port, '/api/workspaces');
  const candidates = [];
  for (const ws of workspaces) {
    for (const member of ws.members ?? []) {
      candidates.push({
        sessionId: member.sessionId,
        name: member.name ?? '',
        role: member.role ?? '',
        tags: member.tags ?? [],
        ws: ws.name,
        label: `${ws.name}:${member.name}`,
      });
    }
  }
  if (needsState) {
    await Promise.all(candidates.map(async (c) => {
      try {
        const runtime = await fetchJson(port, `/api/sessions/${c.sessionId}/runtime`);
        c.agentKind = runtime.agent?.kind ?? null;
        c.active = runtime.agent?.active === true;
      } catch { c.agentKind = null; c.active = false; }
    }));
  }

  const matches = candidates.filter((c) => clauses.every(({ field, query }) => {
    switch (field) {
      case 'name': return c.name.includes(query);
      case 'role': return c.role.includes(query);
      case 'tag': return c.tags.some((t) => String(t).includes(query));
      case 'ws': return c.ws.includes(query);
      case 'id': return c.sessionId === Number(query);
      case 'state':
        if (query === 'busy') return c.active === true;
        if (query === 'idle') return c.agentKind !== null && !c.active;
        if (query === 'agent') return c.agentKind !== null;
        if (query === 'shell') return !c.agentKind;
        console.error(`unknown state: ${query} (busy|idle|agent|shell)`);
        process.exit(EXIT.USAGE);
      default:
        console.error(`unknown match field: ${field} (name|role|tag|ws|state|id)`);
        process.exit(EXIT.USAGE);
    }
  }));
  if (matches.length === 0) {
    console.error(`no members match: ${expr}`);
    process.exit(EXIT.NOT_FOUND);
  }
  return matches;
}

export async function resolveAddress(port, token) {
  if (!token) {
    console.error('address required: ws:name, :name, or #id');
    process.exit(EXIT.USAGE);
  }
  if (token.startsWith('#')) {
    const sessionId = parseInt(token.slice(1), 10);
    if (isNaN(sessionId)) {
      console.error(`not a session id: ${token}`);
      process.exit(EXIT.USAGE);
    }
    return { sessionId, label: `#${sessionId}`, workspace: null, member: null };
  }
  const colon = token.indexOf(':');
  if (colon === -1) {
    console.error(`not an address: ${token} (expected ws:name, :name, or #id)`);
    process.exit(EXIT.USAGE);
  }
  const wsToken = token.slice(0, colon);
  const memberToken = token.slice(colon + 1);
  const workspace = wsToken === ''
    ? await resolveCurrentWorkspace(port)
    : await resolveWorkspace(port, wsToken);
  const member = requireMember(workspace, memberToken);
  return {
    sessionId: member.sessionId,
    label: `${workspace.name}:${member.name}`,
    workspace,
    member,
  };
}

/** The workspace `ttym new` files sessions under when none is named. */
export async function ensureDefaultWorkspace(port) {
  const workspaces = await listWorkspaces(port);
  const existing = workspaces.find((ws) => ws.name === 'default');
  if (existing) return existing;
  return await fetchPost(port, '/api/workspaces', {
    id: randomUUID().slice(0, 8),
    name: 'default',
    layout: { type: 'pane', sessionId: 0 },
    members: [],
  });
}
