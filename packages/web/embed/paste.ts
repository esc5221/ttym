// What sdk.js handle.paste() may put on a terminal's input line.

export const PASTE_MAX_BYTES = 4096;
// C0 except tab and newline, DEL, and C1. ESC is the one that matters: without it
// the text cannot close a bracketed paste early (ESC[201~) or send key sequences.
const FORBIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

/** `bracketed`: the program asked for bracketed paste, so a newline will not submit. */
export function checkPaste(raw: unknown, bracketed: boolean): { text: string } | { error: string } {
  if (typeof raw !== 'string' || raw.length === 0) return { error: 'text must be a non-empty string' };
  const text = raw.replace(/\r\n?/g, '\n');
  if (new TextEncoder().encode(text).length > PASTE_MAX_BYTES) return { error: `text over ${PASTE_MAX_BYTES} bytes` };
  if (FORBIDDEN.test(text)) return { error: 'control characters are not allowed' };
  // Unbracketed, a newline is Enter — it would run whatever came before it.
  if (text.includes('\n') && !bracketed) return { error: 'multi-line text needs a program with bracketed paste' };
  return { text };
}
