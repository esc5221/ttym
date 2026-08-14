import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * CLI 계약 스위트.
 *
 * council의 정의 그대로 — "building block의 실질은 안정된 CLI 계약"이고,
 * 그 계약이란: 비대화형으로 세션을 만들고·열거하고·읽고·입력하고·resize하고·
 * 끝낼 수 있을 것, 스크립트가 exit code로 분기할 수 있을 것, 주소의 의미가
 * 안정적일 것, attach가 끊겨도 holder가 살 것, 버전이 어긋나면 명시적으로
 * 거부할 것. 이 파일의 조항 번호가 곧 그 목록이다.
 *
 * Exit code 계약: 0 성공 · 1 일반 실패 · 2 usage · 3 대상 해석 실패 ·
 * 4 서버 연결 불가 · 5 API 버전 불일치.
 */
const ROOT = resolve(__dirname, '../../..');
const CLI = join(ROOT, 'dist/ttym');
const PORT = 17500 + (process.pid % 90);
const DEAD_PORT = 17690 + (process.pid % 90) + 100; // 아무도 안 듣는 포트

const built = existsSync(CLI);
const suite = built ? describe : describe.skip;

let home = '';

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('node', [CLI, ...args], {
    env: { ...process.env, TTYM_HOME: home, PORT: String(PORT), ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), stdout: r.stdout ?? '' };
}

const api = (path: string) =>
  fetch(`http://127.0.0.1:${PORT}${path}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);

async function until(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('timed out');
}

suite('CLI 계약', () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'ttym-contract-'));
    const r = run(['start']);
    if (r.code !== 0) throw new Error(`start failed: ${r.out}`);
    await until(async () => (await api('/api/sessions')) !== null);
  }, 30_000);

  afterAll(() => {
    try { run(['stop']); } catch {}
    try { execFileSync('pkill', ['-f', home], { stdio: 'ignore' }); } catch {}
    rmSync(home, { recursive: true, force: true });
  });

  // ── §1 연결과 버전 ─────────────────────────────────────────────

  it('§1 서버가 없으면 4로 죽는다 — 스택트레이스가 아니라', () => {
    const r = run(['screen', '#1'], { PORT: String(DEAD_PORT) });
    expect(r.code).toBe(4);
    expect(r.out).toContain('cannot reach');
    expect(r.out).not.toContain('at TCPConnectWrap'); // 생 스택트레이스 금지
  });

  it('§1 status의 "안 떠있음"도 분기 가능한 답(4)이다', () => {
    const r = run(['status'], { PORT: String(DEAD_PORT), TTYM_HOME: mkdtempSync(join(tmpdir(), 'ttym-nohome-')) });
    expect(r.code).toBe(4);
  });

  it('§1 API 버전이 다른 서버는 5로 거부한다', async () => {
    // fake 서버는 별도 프로세스로 — spawnSync가 vitest의 이벤트 루프를
    // 막는 동안 같은 프로세스의 서버는 accept를 못 해 자기 데드락이 된다.
    const fakePort = 17400 + (process.pid % 90);
    const fake = spawn('node', ['-e', `
      require('http').createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({apiVersion:999}))})
        .listen(${fakePort},'127.0.0.1',()=>console.log('up'));
    `], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise<void>((r) => fake.stdout!.once('data', () => r()));
    try {
      const r = run(['screen', '#1'], { PORT: String(fakePort) });
      expect(r.code).toBe(5);
      expect(r.out).toContain('api v999');
    } finally {
      fake.kill();
    }
  });

  // ── §2 usage와 사라진 문법 ─────────────────────────────────────

  it('§2 모르는 명령은 2, 빈 호출의 help는 0', () => {
    expect(run(['nonsense']).code).toBe(2);
    expect(run([]).code).toBe(0);
  });

  it('§2 인자가 모자라면 2 + usage 한 줄', () => {
    const r = run(['screen']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('usage:');
  });

  it('§2 사어들은 usage로 떨어진다 — terminate·workspace send 부활 금지', () => {
    expect(run(['workspace', 'terminate', 'x', 'y']).code).toBe(2);
    expect(run(['workspace', 'send', 'x', 'y', '--', 'z']).code).toBe(2);
  });

  // ── §3 주소의 의미 ────────────────────────────────────────────

  let wsId = '';
  let memberSid = 0;

  it('§3 준비: workspace + 멤버 (--cmd 뒤의 --port가 명령을 오염시키지 않는다)', async () => {
    const ws = JSON.parse(run(['workspace', 'create', 'suite', '--json']).stdout);
    wsId = ws.id;
    // C2 회귀의 핵심: --port가 --cmd 뒤에 와도 전역 플래그로 선추출된다.
    // 예전엔 /bin/zsh가 `--port N`을 제 인자로 받고 즉사했다.
    const r = run(['workspace', 'add', wsId, '--name', 'echoer', '--cmd', '/bin/sh', '--port', String(PORT)]);
    expect(r.code).toBe(0);
    const info = JSON.parse(run(['workspace', 'info', wsId, '--json']).stdout);
    const w = info.workspace ?? info;
    memberSid = w.members.find((m: { name: string }) => m.name === 'echoer').sessionId;
    expect(memberSid).toBeGreaterThan(0);
  });

  it('§3 세 주소형이 같은 세션에 닿는다: ws:name · #id · :name', async () => {
    // ws:name으로 입력
    expect(run(['send', 'suite:echoer', '--', 'echo ADDR-A\n']).code).toBe(0);
    await until(() => run(['screen', `#${memberSid}`]).out.includes('ADDR-A'));
    // #id로 읽기 (위에서 검증됨) · :name은 세션 안 컨텍스트로 해석
    const r = run(['screen', ':echoer'], { TTYM_SESSION_ID: String(memberSid) });
    expect(r.code).toBe(0);
    expect(r.out).toContain('ADDR-A');
  });

  it('§3 없는 대상은 3', () => {
    expect(run(['screen', 'suite:nobody']).code).toBe(3);
    expect(run(['screen', 'no-such-ws:x']).code).toBe(3);
  });

  // ── §4 비대화형 lifecycle ─────────────────────────────────────

  it('§4 resize가 세션의 실제 기하를 바꾼다', async () => {
    expect(run(['resize', `#${memberSid}`, '132', '43']).code).toBe(0);
    const rt = await api(`/api/sessions/${memberSid}/runtime`) as { terminal: { cols: number; rows: number } };
    expect(rt.terminal.cols).toBe(132);
    expect(rt.terminal.rows).toBe(43);
  });

  it('§4 kill은 세션을 명부에서 지운다', async () => {
    const tmp = JSON.parse(run(['new', 'doomed', '--json']).stdout);
    const sid = tmp.sessionId ?? tmp.session?.id ?? tmp.id;
    expect(run(['kill', `#${sid}`]).code).toBe(0);
    await until(async () => {
      const list = await api('/api/sessions') as Array<{ id: number }>;
      return !list.some((s) => s.id === sid);
    });
  });

  // ── §5 detach 생존 계약 ───────────────────────────────────────

  it('§5 workspace detach는 멤버십만 지우고 세션은 살려둔다', async () => {
    const r = run(['workspace', 'add', wsId, '--name', 'survivor', '--cmd', '/bin/sh']);
    expect(r.code).toBe(0);
    const info = JSON.parse(run(['workspace', 'info', wsId, '--json']).stdout);
    const w = info.workspace ?? info;
    const sid = w.members.find((m: { name: string }) => m.name === 'survivor').sessionId;
    expect(run(['workspace', 'detach', wsId, 'survivor']).code).toBe(0);
    const list = await api('/api/sessions') as Array<{ id: number }>;
    expect(list.some((s) => s.id === sid)).toBe(true);
    run(['kill', `#${sid}`]);
  });

  // ── §6 --json 형태 계약 ───────────────────────────────────────

  it('§6 await --json의 키는 고정이다 (추출 품질 필드 포함)', () => {
    const r = run(['await', 'suite:echoer', '--json', '--timeout', '1500', '--', 'noop']);
    expect(r.stdout, `stdout이 비었다 — 전체 출력: ${r.out}`).not.toBe('');
    const j = JSON.parse(r.stdout);
    for (const key of ['target', 'interaction', 'completed', 'output']) {
      expect(j, `missing ${key}`).toHaveProperty(key);
    }
    for (const key of ['id', 'status', 'transcriptSource', 'integrity']) {
      expect(j.interaction, `missing interaction.${key}`).toHaveProperty(key);
    }
  });

  it('§6 전역 --json은 위치를 가리지 않는다', () => {
    const a = run(['--json', 'workspace', 'info', wsId]);
    const b = run(['workspace', 'info', wsId, '--json']);
    expect(a.code).toBe(0);
    expect(JSON.parse(a.stdout).workspace?.id ?? JSON.parse(a.stdout).id)
      .toBe(JSON.parse(b.stdout).workspace?.id ?? JSON.parse(b.stdout).id);
  });
});
