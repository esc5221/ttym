import type { LayoutNode } from '@ttym/shared';

export interface SessionInfo {
  id: number;
  pid: number;
  cmd: string[];
  cols: number;
  rows: number;
  status: 'attached' | 'detached' | 'dead';
  viewerCount: number;
  lastSeq: number;
  createdAt: number;
  detachedAt: number | null;
}

export interface WorkspaceMemberInfo {
  sessionId: number;
  name: string;
  role?: string;
  tags?: string[];
  createdAt?: number;
  updatedAt?: number;
}

export interface WorkspaceInfo {
  id: string;
  project: string;
  name: string;
  layout: LayoutNode;
  members: WorkspaceMemberInfo[];
  createdAt: number;
  updatedAt: number;
}

/** Free-form per-session metadata. Agent integration writes the known keys. */
export interface SessionMeta {
  cwd?: string;
  claudeSessionId?: string | null;
  claudeLastSessionId?: string | null;
  claudeActive?: boolean | null;
  codexSessionId?: string | null;
  codexLastSessionId?: string | null;
  codexActive?: boolean | null;
  [key: string]: unknown;
}

export type InteractionStatus = 'pending' | 'completed' | 'timed_out' | 'failed';

export interface Interaction {
  id: string;
  sessionId: number;
  prompt: string;
  status: InteractionStatus;
  transcript: string | null;
  createdAt: number;
  completedAt: number | null;
}
