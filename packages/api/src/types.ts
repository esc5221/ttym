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

/** Placement on the work map — written by the summarizer, read by the map view
 *  and by the tab strip's stream menu. Absent means unsorted. */
export interface WorkspaceMapAnnotation {
  stream?: string;
  column?: number;
  order?: number;
  updatedAt?: number;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  layout: LayoutNode;
  members: WorkspaceMemberInfo[];
  map?: WorkspaceMapAnnotation;
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

/** Server-owned view of a session, assembled by GET /runtime. Read-only. */
export interface SessionRuntime {
  terminal: {
    cols: number;
    rows: number;
    lastSeq: number;
    appliedOffset: number;
    generation: string;
    recoveryGap: boolean;
  };
  process: {
    pid: number;
    state: 'running' | 'dead' | 'evicted';
    exitCode: number | null;
  };
  agent: {
    kind: 'claude-code' | 'codex' | null;
    externalSessionId: string | null;
    active: boolean;
    activeInteractionId: string | null;
  };
}

/** User-owned keys. Free-form; the server refuses its own keys here. */
export type SessionAnnotations = Record<string, unknown>;
