import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { EXIT, HOME_DIR, getPort, fetchJson, fetchPatch, ensureCompatibleServer, stripAnsi, hasFlag, readOption, printOutput } from './common.js';

/**
 * ttym map refresh — 작업 지도의 AI 요약기.
 *
 * 서버가 조립한 /api/map에서 낡은(stale) 세션만 추려 화면 꼬리를 읽고,
 * claude -p 한 번의 배치 호출로 세션 요약 + workspace 배치(stream/column)를
 * 받아 서버에 되민다. 요약은 meta.mapSummary(user-owned 절반)에, 배치는
 * workspace.map에 실린다. seq가 안 움직인 세션은 재요약하지 않는다 — 비용 0.
 */

const STATUSES = new Set(['wait', 'run', 'done', 'warn']);
const SCREEN_LINES = 38;
const SCREEN_CHARS = 2600;
const CLAUDE_TIMEOUT_MS = 180_000;

interface MapSession {
  id: number;
  cmd: string[];
  createdAt: number;
  lastSeq: number;
  agentKind: string | null;
  agentActive: boolean;
  summary: Record<string, unknown> | null;
  stale: boolean;
}

interface MapWorkspace {
  id: string;
  name: string;
  members: Array<{ sessionId: number; name: string }>;
  map?: { stream?: string; column?: number; order?: number };
}

export async function cmdMap() {
  const sub = process.argv[3];
  if (sub !== 'refresh') {
    console.error('usage: ttym map refresh [--model M] [--base-url URL] [--api-key K] [--note TEXT] [--force] [--dry-run] [--json]');
    process.exit(EXIT.USAGE);
  }
  const args = process.argv.slice(4);
  const force = hasFlag('--force');
  const port = getPort();
  await ensureCompatibleServer(port);

  // 모델 백엔드 규칙은 하나: base-url이 있으면 OpenAI 호환 HTTP, 없으면 claude CLI.
  // 해석 순서는 플래그 > ~/.ttym/config(map-*) > 기본값. 키는 config에 넣지 않는다
  // — config는 GET /api/config로 모든 클라이언트에 서빙되는 파일이다.
  const config = ((await fetchJson(port, '/api/config').catch(() => null)) as { values?: Record<string, string> } | null)?.values ?? {};
  const baseUrl = (readOption(args, '--base-url') || config['map-base-url'] || '').replace(/\/$/, '');
  const model = readOption(args, '--model') || config['map-model'] || (baseUrl ? '' : 'haiku');
  if (baseUrl && !model) {
    console.error('map: map-base-url이 설정됐는데 map-model이 없다 — config에 map-model을 추가해라');
    process.exit(EXIT.USAGE);
  }

  const map = await fetchJson(port, '/api/map') as { workspaces: MapWorkspace[]; sessions: MapSession[] };
  const stale = map.sessions.filter((s) => force || s.stale);
  const unplaced = map.workspaces.filter((w) => !w.map?.stream);
  if (stale.length === 0 && unplaced.length === 0) {
    if (hasFlag('--json')) return printOutput({ refreshed: 0, fresh: map.sessions.length }, true);
    console.log(`map: ${map.sessions.length}개 세션 요약 전부 신선 — 할 일 없음`);
    return;
  }

  const screens = new Map<number, string>();
  for (const s of stale) {
    const r = await fetchJson(port, `/api/sessions/${s.id}/screen`).catch(() => null);
    const plain = stripAnsi(String(r?.screen ?? ''))
      .split('\n').map((l: string) => l.replace(/\s+$/, '')).filter((l: string) => l.trim())
      .slice(-SCREEN_LINES).join('\n');
    screens.set(s.id, plain.slice(-SCREEN_CHARS));
  }

  // 지시문의 단일 원천은 서버(GET /api/map/prompt) — 기본값이든 사용자
  // 편집본이든 저쪽이 유효본을 안다. 데이터 블록만 여기서 조립한다.
  const { prompt: instructions } = await fetchJson(port, '/api/map/prompt') as { prompt: string };
  const note = readOption(args, '--note') || '';
  const prompt = buildPrompt(instructions, note, map, stale, screens);
  if (hasFlag('--dry-run')) { console.log(prompt); return; }

  const raw = baseUrl ? await runOpenAi(prompt, model, baseUrl) : await runClaude(prompt, model);
  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== 'object') {
    console.error('map: 모델 출력에서 JSON을 못 찾았다 —');
    console.error(raw.slice(0, 400));
    process.exit(EXIT.FAIL);
  }

  let sessionsApplied = 0;
  const sessionOut = (parsed as Record<string, unknown>).sessions;
  if (sessionOut && typeof sessionOut === 'object') {
    for (const [idStr, value] of Object.entries(sessionOut as Record<string, unknown>)) {
      const id = parseInt(idStr, 10);
      const row = map.sessions.find((s) => s.id === id);
      if (!row || !value || typeof value !== 'object') continue;
      const v = value as Record<string, unknown>;
      const summary = {
        title: typeof v.title === 'string' ? v.title.slice(0, 40) : '',
        note: typeof v.note === 'string' ? v.note.slice(0, 120) : '',
        status: typeof v.status === 'string' && STATUSES.has(v.status) ? v.status : null,
        statusNote: typeof v.statusNote === 'string' ? v.statusNote.slice(0, 30) : '',
        // 화면은 GET /api/map 이후에 읽었으니 요약은 최소 lastSeq까지를 봤다.
        atSeq: row.lastSeq,
        updatedAt: Date.now(),
      };
      await fetchPatch(port, `/api/sessions/${id}/annotations`, { mapSummary: summary });
      sessionsApplied++;
    }
  }

  // 모델이 응답에서 뺀 stale 세션은 신선 처리하되 내용은 지키지 않는다 —
  // 기존 요약이 있으면 그대로 두고 atSeq만 올린다(모델이 한 판을 통째로
  // 빼먹어도 멀쩡한 요약이 빈 것으로 덮이지 않는다). 없던 세션만 빈 요약.
  const answered = new Set(Object.keys((sessionOut as Record<string, unknown>) ?? {}).map((k) => parseInt(k, 10)));
  for (const row of stale) {
    if (answered.has(row.id)) continue;
    const prev = (row.summary ?? {}) as Record<string, unknown>;
    await fetchPatch(port, `/api/sessions/${row.id}/annotations`, {
      mapSummary: {
        title: typeof prev.title === 'string' ? prev.title : '',
        note: typeof prev.note === 'string' ? prev.note : '',
        status: typeof prev.status === 'string' ? prev.status : null,
        statusNote: typeof prev.statusNote === 'string' ? prev.statusNote : '',
        atSeq: row.lastSeq,
        updatedAt: Date.now(),
      },
    });
  }

  let workspacesApplied = 0;
  const wsOut = (parsed as Record<string, unknown>).workspaces;
  if (wsOut && typeof wsOut === 'object') {
    for (const [wsId, value] of Object.entries(wsOut as Record<string, unknown>)) {
      if (!map.workspaces.some((w) => w.id === wsId)) continue;
      if (!value || typeof value !== 'object') continue;
      const v = value as Record<string, unknown>;
      const column = typeof v.column === 'number' && v.column >= 1 && v.column <= 3 ? Math.floor(v.column) : 1;
      await fetchPatch(port, `/api/workspaces/${wsId}`, {
        map: {
          stream: typeof v.stream === 'string' ? v.stream.slice(0, 30) : '미분류',
          column,
          order: typeof v.order === 'number' ? Math.floor(v.order) : 0,
        },
      });
      workspacesApplied++;
    }
  }

  const backend = baseUrl ? `${model} @ ${new URL(baseUrl).host}` : `${model} @ claude`;
  if (hasFlag('--json')) return printOutput({ refreshed: sessionsApplied, workspaces: workspacesApplied, staleWere: stale.length, model, baseUrl: baseUrl || null }, true);
  console.log(`map: 세션 ${sessionsApplied}/${stale.length} 요약, workspace ${workspacesApplied} 배치 (${backend})`);
}

function buildPrompt(instructions: string, note: string, map: { workspaces: MapWorkspace[]; sessions: MapSession[] }, stale: MapSession[], screens: Map<number, string>): string {
  const membership = new Map<number, { ws: MapWorkspace; name: string }>();
  for (const w of map.workspaces) {
    for (const m of w.members) membership.set(m.sessionId, { ws: w, name: m.name });
  }
  const lines: string[] = [instructions, ''];
  if (note.trim()) {
    // 일회성 지시는 지시문 바로 뒤 — 저장되지 않고 이번 호출에만 산다.
    lines.push('=== 사용자 일회성 지시 (이번 정리에만 최우선 적용) ===', note.trim(), '');
  }
  lines.push('=== workspace 목록 ===');
  for (const w of map.workspaces) {
    const cur = w.map?.stream ? ` [기존 배치: stream="${w.map.stream}" column=${w.map.column} order=${w.map.order}]` : '';
    const members = w.members.map((m) => `${m.name}(#${m.sessionId})`).join(', ');
    lines.push(`- ${w.id}: "${w.name}" 멤버: ${members}${cur}`);
  }
  lines.push('');
  lines.push('=== 요약 대상 세션 (이 세션들만 sessions에 넣어라) ===');
  for (const s of stale) {
    const mem = membership.get(s.id);
    const where = mem ? `workspace "${mem.ws.name}"의 멤버 "${mem.name}"` : 'workspace 미소속';
    const prev = s.summary && typeof s.summary.title === 'string' && s.summary.title ? ` 이전 title: "${s.summary.title}"` : '';
    lines.push('');
    lines.push(`── 세션 #${s.id} · ${where} · 에이전트: ${s.agentKind ?? 'shell'} · cmd: ${s.cmd.slice(0, 3).join(' ')}${prev}`);
    lines.push(screens.get(s.id) || '(화면 비어 있음)');
  }
  lines.push('');
  lines.push('=== 참고: 요약 대상이 아닌 세션의 현재 title (stream 묶음 판단용) ===');
  for (const s of map.sessions) {
    if (stale.includes(s)) continue;
    const t = s.summary && typeof s.summary.title === 'string' ? s.summary.title : '';
    if (t) lines.push(`- #${s.id}: ${t}`);
  }
  return lines.join('\n');
}

/** 키는 서빙되는 config가 아니라 권한 제한 파일 또는 env에서만:
 *  --api-key > $TTYM_HOME/map-api-key(0600 권장) > OPENAI_API_KEY */
function resolveApiKey(): string {
  const flag = readOption(process.argv.slice(4), '--api-key');
  if (flag) return flag;
  try {
    const raw = readFileSync(resolve(HOME_DIR, 'map-api-key'), 'utf8').trim();
    if (raw) return raw;
  } catch {}
  return process.env.OPENAI_API_KEY || '';
}

async function runOpenAi(prompt: string, model: string, baseUrl: string): Promise<string> {
  const key = resolveApiKey();
  if (!key) {
    console.error(`map: API 키가 없다 — ${resolve(HOME_DIR, 'map-api-key')} 파일(권장, chmod 600) 또는 OPENAI_API_KEY`);
    process.exit(EXIT.USAGE);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);
  try {
    // 리즈닝 모델(deepseek 등)은 사고에 예산을 먼저 태운다 — 실측에서 8k 토큰을
    // 전부 사고로 쓰고 content가 빈 채 length로 죽었다. 그래서 기본으로 사고를
    // 끄고(thinking disabled), 그 필드를 모르는 엄격한 서버가 400을 주면 한 번
    // 빼고 재시도한다. 요약엔 사고가 필요 없다.
    const call = async (withKnob: boolean) => fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, messages: [{ role: 'user', content: prompt }], max_tokens: 8192,
        ...(withKnob ? { thinking: { type: 'disabled' } } : {}),
      }),
      signal: controller.signal,
    });
    let res = await call(true);
    if (res.status === 400) res = await call(false);
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content ?? '';
    if (!content.trim()) throw new Error('빈 응답 — 모델이 content 없이 종료 (사고가 예산을 소진?)');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

function runClaude(prompt: string, model: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    // 자식 세션 마커·부모 식별이 새면 transcript-off 경고와 정체 오염이 생긴다 —
    // 서버의 buildSessionEnv와 같은 이유로 CLAUDE* 를 지우고 스폰한다.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith('CLAUDE')) env[k] = v;
    }
    // --no-session-persistence: 10분마다 도는 요약이 ~/.claude/projects에
    // 세션 jsonl(~27KB/회)을 쌓지 않게 — 실측으로 확인한 유일한 차단 수단
    // (CLAUDE_CODE_CHILD_SESSION 마커는 못 막는다). cwd 고정은 이중 안전벨트.
    const child = spawn('claude', ['-p', '--model', model, '--no-session-persistence'], { env, cwd: HOME_DIR, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); rejectPromise(new Error('claude -p timed out')); }, CLAUDE_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); rejectPromise(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(out);
      else rejectPromise(new Error(`claude -p exit ${code}: ${err.slice(0, 300)}`));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** 모델이 펜스나 서두를 붙여도 첫 { 부터 균형 잡힌 JSON을 건진다. */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}
