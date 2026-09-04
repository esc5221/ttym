/**
 * Is this selected text a file to open? Terminal output writes paths in a
 * dozen dresses — quoted, in parentheses, with `:12:5` from a compiler,
 * `#L12` from a browser, `a/` from git diff, a trailing comma from a list.
 * This strips the dress and resolves what is left against the pane's cwd.
 *
 * Deliberately narrow: a bare word is not a path, nor is anything with an
 * unquoted space. A false "open" button on every selection would teach the
 * user to ignore it.
 */

export interface PathCandidate {
  /** Absolute path or URL, ready for `open`. */
  target: string;
  line?: number;
  col?: number;
}

const MAX_LEN = 400;

export function parsePathCandidate(raw: string, cwd: string | undefined, home?: string): PathCandidate | null {
  if (!raw) return null;
  let text = raw.replace(/\r?\n/g, '').trim();
  if (!text || text.length > MAX_LEN) return null;

  // URL first — it has its own grammar and ':' means something else in it.
  const urlMatch = /^[<("'`[]*(https?:\/\/[^\s<>"'`)\]]+)/i.exec(text);
  if (urlMatch) {
    const url = urlMatch[1]!.replace(/[.,;:!?]+$/, '');
    try { return { target: new URL(url).toString() }; } catch { return null; }
  }

  // Wrappers: quotes, backticks, brackets. The closing ')' waits: it may belong to `a.ts(12,5)`.
  text = text.replace(/^[\s"'`<([{]+/, '').replace(/[\s"'`>\]}]+$/, '');
  // Trailing punctuation from prose: "see a.ts," / "in a.ts."
  text = text.replace(/[.,;!?]+$/, '');
  if (!text) return null;

  let line: number | undefined;
  let col: number | undefined;
  let m: RegExpExecArray | null;
  // a.ts(12,5) · a.ts(12) — before the lone ')' of "(a.ts)" is dropped
  if ((m = /^(.*?)\((\d+)(?:,(\d+))?\)$/.exec(text))) { text = m[1]!; line = Number(m[2]); if (m[3]) col = Number(m[3]); }
  text = text.replace(/\)+$/, '');
  // a.ts:12:5 · a.ts:12 · a.ts:12:5: (compiler trailing colon) · a.ts#L12 · a.ts#L12-L20
  if (line === undefined && (m = /^(.*?)(?::(\d+))(?::(\d+))?:?$/.exec(text)) && m[2] && !/^\d+$/.test(m[1]!)) {
    text = m[1]!; line = Number(m[2]); if (m[3]) col = Number(m[3]);
  } else if (line === undefined && (m = /^(.*?)#L(\d+)(?:-L?\d+)?$/.exec(text))) { text = m[1]!; line = Number(m[2]); }
  if (!text) return null;

  // Unquoted whitespace: not one path.
  if (/\s/.test(text)) return null;
  // git diff prefixes.
  text = text.replace(/^[ab]\//, '');

  let target: string;
  if (text.startsWith('/')) target = text;
  else if (text === '~' || text.startsWith('~/')) {
    if (!home) return null;
    target = home + text.slice(1);
  } else {
    // Relative: needs a cwd, and must look like a path rather than a word.
    const looksLikePath = text.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(text) || /^(?:Makefile|Dockerfile|README)$/i.test(text);
    if (!looksLikePath || !cwd) return null;
    target = join(cwd, text);
  }
  target = normalize(target);
  if (target === '/' || target === '') return null;
  const out: PathCandidate = { target };
  if (line !== undefined) out.line = line;
  if (col !== undefined) out.col = col;
  return out;
}

function join(base: string, rel: string): string {
  return base.replace(/\/+$/, '') + '/' + rel;
}

/** Collapse `.` and `..` segments; keep it absolute. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return '/' + out.join('/');
}
