/**
 * HTTP client for a ttym server, shared by the web and desktop apps.
 *
 * The desktop app had these wrapped in its own module; the web app called
 * `fetch` inline in a dozen places. Changing an endpoint meant finding both.
 *
 * Every function takes the base URL first, so a caller that resolves it late
 * (a desktop app whose daemon port is not known at import time) can pass a
 * thunk. `createApi` binds it once if you would rather not repeat it.
 */
export * from './types.js';
export { ApiError, request, resolveBase, type BaseUrl, type RequestOptions } from './transport.js';
export * from './sessions.js';
export * from './workspaces.js';
export * from './interactions.js';
export * from './config.js';

import type { BaseUrl } from './transport.js';
import * as sessions from './sessions.js';
import * as workspaces from './workspaces.js';
import * as interactions from './interactions.js';

/** Bind a base URL once and call without repeating it. */
export function createApi(base: BaseUrl) {
  return {
    sessions: {
      list: () => sessions.listSessions(base),
      create: (o?: Parameters<typeof sessions.createSession>[1]) => sessions.createSession(base, o),
      destroy: (id: number) => sessions.destroySession(base, id),
      screen: (id: number) => sessions.getSessionScreen(base, id),
      meta: (id: number) => sessions.getSessionMeta(base, id),
      patchMeta: (id: number, patch: Parameters<typeof sessions.patchSessionMeta>[2]) =>
        sessions.patchSessionMeta(base, id, patch),
      send: (id: number, data: string) => sessions.sendToSession(base, id, data),
      runtime: (id: number) => sessions.getSessionRuntime(base, id),
      agentStates: () => sessions.getAgentStates(base),
      annotations: (id: number) => sessions.getSessionAnnotations(base, id),
      patchAnnotations: (id: number, patch: Parameters<typeof sessions.patchSessionAnnotations>[2]) =>
        sessions.patchSessionAnnotations(base, id, patch),
      resize: (id: number, cols: number, rows: number) => sessions.resizeSession(base, id, cols, rows),
    },
    workspaces: {
      list: () => workspaces.listWorkspaces(base),
      get: (id: string) => workspaces.getWorkspace(base, id),
      create: (o: Parameters<typeof workspaces.createWorkspace>[1]) => workspaces.createWorkspace(base, o),
      update: (id: string, patch: Parameters<typeof workspaces.updateWorkspace>[2]) =>
        workspaces.updateWorkspace(base, id, patch),
      remove: (id: string) => workspaces.deleteWorkspace(base, id),
      addMember: (id: string, m: Parameters<typeof workspaces.addWorkspaceMember>[2]) =>
        workspaces.addWorkspaceMember(base, id, m),
      removeMember: (id: string, sessionId: number) => workspaces.removeWorkspaceMember(base, id, sessionId),
      split: (id: string, o?: Parameters<typeof workspaces.splitWorkspace>[2]) =>
        workspaces.splitWorkspace(base, id, o),
    },
    interactions: {
      submit: (sessionId: number, o: Parameters<typeof interactions.submitInteraction>[2]) =>
        interactions.submitInteraction(base, sessionId, o),
      resume: (sessionId: number, id: string, waitMs?: number) =>
        interactions.resumeInteraction(base, sessionId, id, waitMs),
    },
  };
}

export type TtymApi = ReturnType<typeof createApi>;
