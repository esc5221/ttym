/**
 * Desktop-side adapter over @ttym/api.
 *
 * The shared client takes a base URL; this app thinks in terms of the loopback
 * port its daemon is listening on. Translating that is all this file does now —
 * the requests themselves live in the package, shared with the web app.
 */
import * as api from '@ttym/api';
import { layoutToSessionIds, layoutFromSessionIds, type LayoutNode } from '@ttym/shared';

export type {
  SessionInfo, SessionMeta, WorkspaceInfo, WorkspaceMemberInfo, Interaction,
} from '@ttym/api';
export { ApiError } from '@ttym/api';

const base = (port: number) => `http://127.0.0.1:${port}`;

export const listSessions = (port: number) => api.listSessions(base(port));
export const listWorkspaces = (port: number, project?: string) => api.listWorkspaces(base(port), project);
export const getSessionScreen = (port: number, sessionId: number) => api.getSessionScreen(base(port), sessionId);
export const getSessionMeta = (port: number, sessionId: number) => api.getSessionMeta(base(port), sessionId);

export const createWorkspace = (port: number, name: string, sessionIds: number[] = []) =>
  api.createWorkspace(base(port), { name, sessionIds });

export const updateWorkspace = (
  port: number,
  id: string,
  patch: { name?: string; layout?: LayoutNode; members?: api.WorkspaceMemberInfo[] },
) => api.updateWorkspace(base(port), id, patch);

export const deleteWorkspace = (port: number, id: string) => api.deleteWorkspace(base(port), id);

export const splitWorkspace = (
  port: number,
  id: string,
  options: Parameters<typeof api.splitWorkspace>[2] = {},
) => api.splitWorkspace(base(port), id, options);

// Re-exported for callers that build layouts locally.
export { layoutToSessionIds };
export const sessionIdsToLayout = layoutFromSessionIds;

/** Leftmost real pane in a layout, or null when it holds only the placeholder. */
export function firstSessionId(node: LayoutNode): number | null {
  if (node.type === 'pane') return node.sessionId > 0 ? node.sessionId : null;
  for (const child of node.children) {
    const id = firstSessionId(child);
    if (id !== null) return id;
  }
  return null;
}
