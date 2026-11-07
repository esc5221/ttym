/**
 * Keys for the web composer: which ones the text field keeps, and the bytes a terminal would send for
 * the rest, so the agent reads them exactly as it would from its own terminal.
 */

export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

const ESC = '\x1b';

const NAMED: Record<string, string> = {
  Enter: '\r', Tab: '\t', Escape: ESC, Backspace: '\x7f', Delete: `${ESC}[3~`,
  ArrowUp: `${ESC}[A`, ArrowDown: `${ESC}[B`, ArrowRight: `${ESC}[C`, ArrowLeft: `${ESC}[D`,
  Home: `${ESC}[H`, End: `${ESC}[F`, PageUp: `${ESC}[5~`, PageDown: `${ESC}[6~`,
  F1: `${ESC}OP`, F2: `${ESC}OQ`, F3: `${ESC}OR`, F4: `${ESC}OS`,
};

/** The letter or symbol a key stands for, ignoring what Option turned it into on a Mac (Option+P types π). */
function baseChar(e: KeyLike): string | null {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  const sym: Record<string, string> = { Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`', Space: ' ' };
  return sym[e.code] ?? (e.key.length === 1 ? e.key : null);
}

/** What an xterm-style terminal sends for this key, or null for keys it sends nothing for (Cmd chords, lone modifiers). */
export function keyToBytes(e: KeyLike): string | null {
  if (e.metaKey) return null;
  if (e.key === 'Tab' && e.shiftKey) return `${ESC}[Z`;
  const named = NAMED[e.key];
  if (named !== undefined) {
    if (e.key.startsWith('Arrow') && (e.shiftKey || e.altKey || e.ctrlKey)) {
      const mod = 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0);
      return `${ESC}[1;${mod}${named.slice(-1)}`;
    }
    return e.altKey ? ESC + named : named;
  }
  const ch = baseChar(e);
  if (ch === null) return null;
  if (e.ctrlKey) {
    let c: string | null = null;
    if (/^[a-z]$/.test(ch)) c = String.fromCharCode(ch.charCodeAt(0) - 96);
    else if (ch === ' ' || ch === '2' || ch === '@') c = '\x00';
    else if (ch === '[') c = ESC;
    else if (ch === '\\') c = '\x1c';
    else if (ch === ']') c = '\x1d';
    else if (ch === '-' || ch === '_' || ch === '/' || ch === '7') c = '\x1f';
    if (c === null) return null;
    return e.altKey ? ESC + c : c;
  }
  if (e.altKey) return ESC + (e.shiftKey ? ch.toUpperCase() : ch);
  return e.key.length === 1 ? e.key : null;
}

/**
 * Keys the text field handles itself: typing, moving and selecting, the browser's own edit chords
 * (Cmd on a Mac, Ctrl elsewhere), and the Emacs keys a Mac text field already knows.
 */
export function isTextEditingKey(e: KeyLike): boolean {
  if (e.metaKey) return true;
  // Shift+Enter is a new line in the field, as in the agent's prompt (Option+Enter is handled by the field itself).
  if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey) return true;
  if (!e.ctrlKey && !e.altKey) {
    if (e.key === 'Tab' || e.key === 'Escape' || e.key === 'Enter' || /^F\d+$/.test(e.key)) return false;
    return true; // characters, Backspace/Delete, arrows, Home/End, Shift+selection
  }
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  if (e.altKey && !e.ctrlKey && (e.key.startsWith('Arrow') || e.key === 'Backspace' || e.key === 'Delete')) return true;
  if (e.ctrlKey && !e.altKey && !e.shiftKey) {
    if (mac && /^[aebfnpdhk]$/.test(e.key)) return true; // Cocoa text bindings
    if (!mac && /^[acvxzy]$/.test(e.key)) return true;   // the platform's copy/paste/undo
    if (e.key.startsWith('Arrow') || e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Home' || e.key === 'End') return true;
  }
  return false;
}

export interface MenuToken {
  kind: 'command' | 'file';
  /** Index of the trigger character (/ or @) in the text. */
  start: number;
  /** What follows the trigger, up to the caret. */
  query: string;
}

/**
 * The completion being typed at the caret: a `/command` or an `@path`, at the start or after a space
 * (Claude Code completes a command mid-message too). A slash right after a letter is a path, not a command.
 */
export function menuToken(text: string, caret: number): MenuToken | null {
  const before = text.slice(0, caret);
  const cmd = /(^|\s)\/([^\s/]*)$/.exec(before);
  if (cmd) return { kind: 'command', start: before.length - cmd[2]!.length - 1, query: cmd[2]! };
  const m = /(^|\s)@([^\s@]*)$/.exec(before);
  if (m) return { kind: 'file', start: before.length - m[2]!.length - 1, query: m[2]! };
  return null;
}

/** Replace the token (trigger to caret, and the rest of its word) with `insert`. */
export function applyCompletion(text: string, token: MenuToken, insert: string): { text: string; caret: number } {
  const afterStart = token.start + 1 + token.query.length;
  const rest = text.slice(afterStart).replace(/^\S*/, '').replace(/^ /, '');
  const next = text.slice(0, token.start) + insert + rest;
  return { text: next, caret: token.start + insert.length };
}
