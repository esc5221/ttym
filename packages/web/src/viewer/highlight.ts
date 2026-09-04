/**
 * Syntax colour for the code renderer and markdown's fenced blocks.
 *
 * highlight.js core plus one grammar at a time, each loaded the first time
 * a file of that kind is opened. Nothing ships in the main bundle; a pane
 * that only ever opens .md pays for the markdown grammar and nothing else.
 *
 * The file's name decides the grammar (extension, then well-known names
 * like Makefile). Unknown → plain text, no guessing: auto-detection on a
 * 10k-line log is slow and usually wrong.
 */

type Loader = () => Promise<{ default: import('highlight.js').LanguageFn }>;

const LOADERS: Record<string, Loader> = {
  bash: () => import('highlight.js/lib/languages/bash'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  css: () => import('highlight.js/lib/languages/css'),
  dart: () => import('highlight.js/lib/languages/dart'),
  diff: () => import('highlight.js/lib/languages/diff'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  elixir: () => import('highlight.js/lib/languages/elixir'),
  erlang: () => import('highlight.js/lib/languages/erlang'),
  go: () => import('highlight.js/lib/languages/go'),
  graphql: () => import('highlight.js/lib/languages/graphql'),
  haskell: () => import('highlight.js/lib/languages/haskell'),
  ini: () => import('highlight.js/lib/languages/ini'),
  java: () => import('highlight.js/lib/languages/java'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  json: () => import('highlight.js/lib/languages/json'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  latex: () => import('highlight.js/lib/languages/latex'),
  less: () => import('highlight.js/lib/languages/less'),
  lua: () => import('highlight.js/lib/languages/lua'),
  makefile: () => import('highlight.js/lib/languages/makefile'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  nginx: () => import('highlight.js/lib/languages/nginx'),
  objectivec: () => import('highlight.js/lib/languages/objectivec'),
  ocaml: () => import('highlight.js/lib/languages/ocaml'),
  perl: () => import('highlight.js/lib/languages/perl'),
  php: () => import('highlight.js/lib/languages/php'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  protobuf: () => import('highlight.js/lib/languages/protobuf'),
  python: () => import('highlight.js/lib/languages/python'),
  r: () => import('highlight.js/lib/languages/r'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  rust: () => import('highlight.js/lib/languages/rust'),
  scala: () => import('highlight.js/lib/languages/scala'),
  scss: () => import('highlight.js/lib/languages/scss'),
  sql: () => import('highlight.js/lib/languages/sql'),
  swift: () => import('highlight.js/lib/languages/swift'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  vim: () => import('highlight.js/lib/languages/vim'),
  xml: () => import('highlight.js/lib/languages/xml'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
};

const BY_EXT: Record<string, string> = {
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', ksh: 'bash',
  c: 'c', h: 'c',
  cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', ino: 'cpp',
  cs: 'csharp',
  css: 'css', scss: 'scss', less: 'less',
  dart: 'dart',
  diff: 'diff', patch: 'diff',
  ex: 'elixir', exs: 'elixir', erl: 'erlang',
  go: 'go', graphql: 'graphql', gql: 'graphql',
  hs: 'haskell',
  ini: 'ini', cfg: 'ini', conf: 'ini', toml: 'ini', properties: 'ini', env: 'bash', gitconfig: 'ini',
  java: 'java',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  json: 'json', jsonc: 'json', json5: 'json', jsonl: 'json', ndjson: 'json',
  kt: 'kotlin', kts: 'kotlin',
  tex: 'latex', lua: 'lua',
  md: 'markdown', markdown: 'markdown',
  m: 'objectivec', mm: 'objectivec', ml: 'ocaml', mli: 'ocaml',
  pl: 'perl', pm: 'perl', php: 'php', ps1: 'powershell', proto: 'protobuf',
  py: 'python', pyi: 'python', r: 'r', rb: 'ruby', rs: 'rust', scala: 'scala', sbt: 'scala',
  sql: 'sql', swift: 'swift', vim: 'vim',
  xml: 'xml', html: 'xml', htm: 'xml', svg: 'xml', xsl: 'xml', plist: 'xml', vue: 'xml', svelte: 'xml',
  yaml: 'yaml', yml: 'yaml',
  cmake: 'makefile', mk: 'makefile',
};

const BY_NAME: Record<string, string> = {
  makefile: 'makefile', gnumakefile: 'makefile', dockerfile: 'dockerfile', containerfile: 'dockerfile',
  'cmakelists.txt': 'makefile', '.bashrc': 'bash', '.zshrc': 'bash', '.bash_profile': 'bash', '.zprofile': 'bash',
  '.gitignore': 'bash', '.env': 'bash', 'nginx.conf': 'nginx', '.vimrc': 'vim', 'caddyfile': 'nginx',
};

/** highlight.js grammar id for a file name, or null for plain text. Markdown fences pass their info string. */
export function languageFor(fileName: string): string | null {
  const name = fileName.toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name]!;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  return BY_EXT[ext] ?? null;
}

/** A fence's language tag (```ts, ```python, ```sh) → grammar id. Accepts extensions and grammar names. */
export function languageForTag(tag: string): string | null {
  const t = tag.trim().toLowerCase();
  if (!t) return null;
  if (LOADERS[t]) return t;
  const alias: Record<string, string> = { shell: 'bash', console: 'bash', zsh: 'bash', 'c++': 'cpp', 'objective-c': 'objectivec', jsonc: 'json', yml: 'yaml', html: 'xml', py: 'python', rb: 'ruby', rs: 'rust', js: 'javascript', ts: 'typescript', tsx: 'typescript', jsx: 'javascript', kt: 'kotlin', hs: 'haskell', toml: 'ini', dockerfile: 'dockerfile', docker: 'dockerfile', make: 'makefile', text: 'plaintext', txt: 'plaintext', plain: 'plaintext' };
  return alias[t] ?? BY_EXT[t] ?? null;
}

type Hljs = typeof import('highlight.js/lib/core').default;
let corePromise: Promise<Hljs> | null = null;
const loaded = new Set<string>();

async function core(): Promise<Hljs> {
  if (!corePromise) corePromise = import('highlight.js/lib/core').then((m) => m.default);
  return corePromise;
}

async function ensure(lang: string): Promise<Hljs | null> {
  const hljs = await core();
  if (loaded.has(lang)) return hljs;
  const load = LOADERS[lang];
  if (!load) return null;
  try {
    const grammar = await load();
    hljs.registerLanguage(lang, grammar.default);
    loaded.add(lang);
    return hljs;
  } catch { return null; }
}

/** Escaped, coloured HTML for `code`, or null when there is no grammar (caller falls back to plain text). */
export async function highlightHtml(code: string, lang: string | null): Promise<string | null> {
  if (!lang || lang === 'plaintext') return null;
  const hljs = await ensure(lang);
  if (!hljs) return null;
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch { return null; }
}

/**
 * Highlighted HTML split into one string per line, with spans that cross a
 * newline (a block comment, a template string) closed and reopened so each
 * line is well-formed on its own — line numbers need one element per line.
 */
export function splitHighlightedLines(html: string): string[] {
  const out: string[] = [];
  const open: string[] = [];
  const tag = /<span class="([^"]*)">|<\/span>/g;
  for (const raw of html.split('\n')) {
    let line = open.map((cls) => `<span class="${cls}">`).join('') + raw;
    // Track the stack across this line.
    let m: RegExpExecArray | null;
    tag.lastIndex = 0;
    while ((m = tag.exec(raw)) !== null) {
      if (m[1] !== undefined) open.push(m[1]);
      else open.pop();
    }
    line += '</span>'.repeat(open.length);
    out.push(line);
  }
  return out;
}
