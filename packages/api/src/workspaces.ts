import { request, type BaseUrl } from './transport.js';
import { layoutFromSessionIds, type LayoutNode } from '@ttym/shared';
import type { SessionInfo, WorkspaceInfo, WorkspaceMapAnnotation, WorkspaceMemberInfo } from './types.js';

export function listWorkspaces(base: BaseUrl): Promise<WorkspaceInfo[]> {
  return request(base, '/api/workspaces');
}

export function getWorkspace(base: BaseUrl, id: string): Promise<WorkspaceInfo> {
  return request(base, `/api/workspaces/${encodeURIComponent(id)}`);
}

export function createWorkspace(
  base: BaseUrl,
  options: { name: string; id?: string; sessionIds?: number[]; layout?: LayoutNode; stream?: string },
): Promise<WorkspaceInfo> {
  const { name, sessionIds = [], layout, stream } = options;
  return request(base, '/api/workspaces', {
    method: 'POST',
    body: {
      id: options.id ?? crypto.randomUUID().slice(0, 8),
      name,
      // Only used when there is no prior tree to preserve.
      layout: layout ?? layoutFromSessionIds(sessionIds),
      ...(stream ? { map: { stream } } : {}),
    },
  });
}

// ───── Streams — the names workspaces are grouped under, and their order ─────

export function listStreams(base: BaseUrl): Promise<{ streams: string[] }> {
  return request(base, '/api/streams');
}

/** An empty stream; 409 when the name exists. */
export function addStream(base: BaseUrl, name: string): Promise<{ streams: string[] }> {
  return request(base, '/api/streams', { method: 'POST', body: { name } });
}

/** Whole order; 409 when the set differs from the server's. */
export function reorderStreams(base: BaseUrl, streams: string[]): Promise<{ streams: string[] }> {
  return request(base, '/api/streams/order', { method: 'PATCH', body: { streams } });
}

/** Rewrites every workspace in `from`; renaming onto an existing name merges. */
export function renameStream(base: BaseUrl, from: string, to: string): Promise<{ moved: number; merged: boolean; streams: string[] }> {
  return request(base, '/api/streams/rename', { method: 'POST', body: { from, to } });
}

/** Drops the name; its workspaces become unsorted, none are deleted. */
export function removeStream(base: BaseUrl, name: string): Promise<{ moved: number; streams: string[] }> {
  return request(base, '/api/streams/remove', { method: 'POST', body: { name } });
}

export function updateWorkspace(
  base: BaseUrl,
  id: string,
  patch: { name?: string; layout?: LayoutNode; members?: WorkspaceMemberInfo[]; preset?: 'even-h' | 'even-v' | 'main-v' | 'tiled' | 'auto'; map?: WorkspaceMapAnnotation | null },
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
