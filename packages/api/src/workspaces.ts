import { request, type BaseUrl } from './transport.js';
import { layoutFromSessionIds, type LayoutNode } from '@ttym/shared';
import type { SessionInfo, WorkspaceInfo, WorkspaceMemberInfo } from './types.js';

export function listWorkspaces(base: BaseUrl, project?: string): Promise<WorkspaceInfo[]> {
  return request(base, '/api/workspaces', { query: { project } });
}

export function getWorkspace(base: BaseUrl, id: string): Promise<WorkspaceInfo> {
  return request(base, `/api/workspaces/${encodeURIComponent(id)}`);
}

export function createWorkspace(
  base: BaseUrl,
  options: { name: string; project?: string; id?: string; sessionIds?: number[]; layout?: LayoutNode },
): Promise<WorkspaceInfo> {
  const { name, project = 'default', sessionIds = [], layout } = options;
  return request(base, '/api/workspaces', {
    method: 'POST',
    body: {
      id: options.id ?? crypto.randomUUID().slice(0, 8),
      project,
      name,
      // Only used when there is no prior tree to preserve.
      layout: layout ?? layoutFromSessionIds(sessionIds),
    },
  });
}

export function updateWorkspace(
  base: BaseUrl,
  id: string,
  patch: { name?: string; project?: string; layout?: LayoutNode; members?: WorkspaceMemberInfo[]; preset?: 'even-h' | 'even-v' | 'main-v' | 'tiled' | 'auto' },
): Promise<WorkspaceInfo> {
  return request(base, `/api/workspaces/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
}

export function deleteWorkspace(base: BaseUrl, id: string): Promise<void> {
  return request(base, `/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function addWorkspaceMember(
  base: BaseUrl,
  id: string,
  member: { sessionId: number; name?: string; role?: string; tags?: string[] },
): Promise<WorkspaceInfo> {
  return request(base, `/api/workspaces/${encodeURIComponent(id)}/members`, { method: 'POST', body: member });
}

export function removeWorkspaceMember(base: BaseUrl, id: string, sessionId: number): Promise<void> {
  return request(base, `/api/workspaces/${encodeURIComponent(id)}/members/${sessionId}`, { method: 'DELETE' });
}

/** Create a session and place it beside `targetSessionId` in one request. */
export function splitWorkspace(
  base: BaseUrl,
  id: string,
  options: {
    targetSessionId?: number;
    cwd?: string;
    cols?: number;
    rows?: number;
    name?: string;
    role?: string;
    cmd?: string[];
    tags?: string[];
    direction?: 'right' | 'left' | 'down' | 'up';
  } = {},
): Promise<{ workspace: WorkspaceInfo; session: SessionInfo }> {
  return request(base, `/api/workspaces/${encodeURIComponent(id)}/split`, { method: 'POST', body: options });
}
