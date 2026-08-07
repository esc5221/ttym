/**
 * What the terminal core asks of its shell — a one-way message, fired and
 * forgotten. Handling is OPTIONAL: a shell implements the actions its
 * platform supports and ignores the rest (the ghostty apprt rule). What a
 * shell must do is not expressed here; that is enforced by the types of the
 * APIs it has to call.
 */
export type TtymAction =
  | { kind: 'bell'; sessionId: number }
  | { kind: 'session-exit'; sessionId: number };

export type ActionHandler = (action: TtymAction) => void;
