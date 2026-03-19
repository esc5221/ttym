import type { SessionInfo } from '@ttym/client';
import {
  layoutToSessionIds,
  sessionIdsToLayout,
  type LayoutNode,
} from '../../../shared/src/workspace-domain';

export interface WorkspaceInfo {
  id: string;
  project: string;
  name: string;
  layout: LayoutNode;
  members: WorkspaceMemberInfo[];
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceMemberInfo {
  sessionId: number;
  name: string;
  role?: string;
  tags?: string[];
}

export interface SessionMeta {
  claudeSessionId?: string | null;
  claudeLastSessionId?: string | null;
  claudeActive?: boolean | null;
  codexSessionId?: string | null;
  codexLastSessionId?: string | null;
  codexActive?: boolean | null;
  [key: string]: unknown;
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function listSessions(port: number): Promise<SessionInfo[]> {
  return asJson(await fetch(`http://127.0.0.1:${port}/api/sessions`));
}

export async function listWorkspaces(port: number, project?: string): Promise<WorkspaceInfo[]> {
  const url = new URL(`http://127.0.0.1:${port}/api/workspaces`);
  if (project) url.searchParams.set('project', project);
  return asJson(await fetch(url));
}

export async function getSessionScreen(port: number, sessionId: number): Promise<string> {
  const data = await asJson<{ screen: string }>(await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/screen`));
  return data.screen;
}

export async function getSessionMeta(port: number, sessionId: number): Promise<SessionMeta> {
  return asJson(await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/meta`));
}

export { layoutToSessionIds, sessionIdsToLayout };

export async function createWorkspace(port: number, name: string, sessionIds: number[] = []): Promise<WorkspaceInfo> {
  const body = {
    id: crypto.randomUUID().slice(0, 8),
    project: 'default',
    name,
    layout: sessionIdsToLayout(sessionIds),
  };

  return asJson(await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

export async function updateWorkspace(
  port: number,
  id: string,
  patch: { name?: string; layout?: LayoutNode; members?: WorkspaceMemberInfo[] },
): Promise<WorkspaceInfo> {
  return asJson(await fetch(`http://127.0.0.1:${port}/api/workspaces/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }));
}

export async function deleteWorkspace(port: number, id: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/api/workspaces/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function splitWorkspace(
  port: number,
  id: string,
  options: {
    targetSessionId?: number;
    cwd?: string;
    cols?: number;
    rows?: number;
    name?: string;
    role?: string;
    cmd?: string[];
  } = {},
): Promise<{ workspace: WorkspaceInfo; session: SessionInfo }> {
  return asJson(await fetch(`http://127.0.0.1:${port}/api/workspaces/${encodeURIComponent(id)}/split`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  }));
}

export function firstSessionId(node: LayoutNode): number | null {
  if (node.type === 'pane') {
    return node.sessionId > 0 ? node.sessionId : null;
  }
  for (const child of node.children) {
    const id = firstSessionId(child);
    if (id !== null) return id;
  }
  return null;
}
