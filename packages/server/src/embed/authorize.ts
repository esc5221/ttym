/**
 * What a grant connection (/embed/v1/ws) may send and receive. One function
 * for each direction; anything not named here is refused (ADR-0002 D4).
 *
 * Adding a CMD means adding a row here, or grant connections never see it —
 * authorize.test.ts fails on a CMD with no row.
 */
import { CMD, capsOn, grantWorkspaces, type EmbedAccess, type EmbedCap } from '@ttym/protocol';

/** Where a session is right now. Membership is read per frame: a closed tab stops being reachable at the next one. */
export type WorkspaceOf = (sid: number) => string | undefined;

/** Inbound rule per command: the capability it needs on the frame's session, or a fixed answer. */
export const INBOUND: Record<number, EmbedCap | 'always' | 'never'> = {
  [CMD.HELLO]: 'always',
  // The answer is filtered (filterList); asking is harmless.
  [CMD.LIST]: 'always',
  [CMD.ATTACH]: 'terminal.read',
  [CMD.DETACH]: 'terminal.read',
  [CMD.SNAPSHOT]: 'terminal.read',
  [CMD.ACK]: 'terminal.read',
  [CMD.PAUSE_VIEW]: 'terminal.read',
  [CMD.RESUME_VIEW]: 'terminal.read',
  [CMD.DATA]: 'terminal.write',
  [CMD.RESIZE]: 'terminal.write',
  // Tabs are made and closed over HTTP, with the consumer's registered command.
  [CMD.CREATE]: 'never',
  [CMD.DESTROY]: 'never',
  // Process stop/continue — no embed use, and it freezes the shell for every viewer.
  [CMD.PAUSE]: 'never',
  [CMD.RESUME]: 'never',
  // Server → client only.
  [CMD.WORKSPACE]: 'never',
  [CMD.AGENT]: 'never',
  [CMD.CONFIG]: 'never',
  [CMD.VIEW]: 'never',
};

export function authorizeInbound(access: readonly EmbedAccess[], cmd: number, sid: number, workspaceOf: WorkspaceOf): boolean {
  const rule = INBOUND[cmd];
  if (rule === undefined || rule === 'never') return false;
  if (rule === 'always') return true;
  return capsOn(access, sid, workspaceOf(sid)).has(rule);
}

export function canWrite(access: readonly EmbedAccess[], sid: number, workspaceOf: WorkspaceOf): boolean {
  return capsOn(access, sid, workspaceOf(sid)).has('terminal.write');
}

export function filterList<T extends { id: number }>(access: readonly EmbedAccess[], sessions: T[], workspaceOf: WorkspaceOf): T[] {
  return sessions.filter((s) => capsOn(access, s.id, workspaceOf(s.id)).has('terminal.read'));
}

/**
 * Outbound pushes. Returns the event to send (possibly narrowed), or null.
 *
 *   WORKSPACE  only the granted workspaces' own changes; tab order and streams name others
 *   AGENT      not yet — needs its own capability (ADR open question)
 *   VIEW       never: it carries /view/<cap> tokens and absolute paths, and /view/ needs no login
 *   CONFIG     never: the owner's settings
 */
export function filterOutbound(access: readonly EmbedAccess[], cmd: number, event: unknown): unknown | null {
  if (cmd !== CMD.WORKSPACE) return null;
  const e = event as { generation?: number; workspace?: { id: string }; deletedId?: string };
  const mine = grantWorkspaces(access);
  if (e.workspace && mine.has(e.workspace.id)) return { generation: e.generation, workspace: e.workspace };
  if (e.deletedId && mine.has(e.deletedId)) return { generation: e.generation, deletedId: e.deletedId };
  return null;
}

/** Session ids a connection is attached to that its grant no longer reaches — detach them. */
export function outOfScope(access: readonly EmbedAccess[], attached: Iterable<number>, workspaceOf: WorkspaceOf): number[] {
  const out: number[] = [];
  for (const sid of attached) if (!capsOn(access, sid, workspaceOf(sid)).has('terminal.read')) out.push(sid);
  return out;
}
