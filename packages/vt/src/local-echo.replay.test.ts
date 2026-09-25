import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { LocalEchoController, type LocalEchoMode } from './local-echo.js';

/**
 * 녹화한 실제 PTY 바이트로 로컬 에코를 재생한다.
 *
 * fixture 는 scripts/e2e-local-echo.mjs --record 가 만든다 — 격리 서버에서 zsh·bash·claude 에
 * 폰처럼 친 입력과, 그때 서버가 실제로 돌려준 바이트(서버 쪽 시각). 서버 출력은 클라이언트의
 * 예측과 무관하므로, 시각만 밀어 다시 흘려도 같은 상황이 재현된다:
 *   입력이 서버에 닿은 시각 t → 사용자가 친 시각 t - L/2
 *   서버가 보낸 시각 t      → 화면에 닿는 시각 t + L/2
 *
 * 두 터미널을 나란히 둔다. truth 는 서버 출력만, pred 는 예측 + 대조를 거친 출력.
 * 확인하는 것:
 *   final     다 끝난 뒤 두 화면이 같은가 (스냅샷 복구 포함)
 *   drift     입력 줄이 "서버 화면 + 아직 확인 안 된 예측"과 다른 순간의 수
 *   exposed   비밀번호: 친 글자가 화면에 보인 순간의 수
 */

interface Fixture { scenario: string; latency: number; cols?: number; rows?: number; initial?: string; inputs: Array<{ t: number; b: number[] }>; frames: Array<{ t: number; b: number[] }> }

const DIR = join(__dirname, '__fixtures__', 'local-echo');
const fixtures: Fixture[] = readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')));
const SECRET = 'hunter2secret';

function write(term: Terminal, data: string | Uint8Array): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

function cursorLine(term: Terminal): string {
  const b = term.buffer.active;
  return b.getLine(b.viewportY + b.cursorY)?.translateToString(true) ?? '';
}

function screen(term: Terminal): string {
  const b = term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < term.rows; i++) out.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '');
  return out.join('\n').replace(/\s+$/, '');
}

export async function replay(fx: Fixture, mode: LocalEchoMode) {
  const L = fx.latency;
  const size = { cols: fx.cols ?? 44, rows: fx.rows ?? 40, allowProposedApi: true };
  const truth = new Terminal(size);
  const pred = new Terminal(size);
  const serial = new SerializeAddon();
  truth.loadAddon(serial);

  let now = 0;
  const due: number[] = [];
  const echo = new LocalEchoController({
    mode,
    writeOptimistic: (s) => { void write(pred, s); },
    writeOptimisticBackspace: (cells = 1) => { void write(pred, '\b'.repeat(cells) + ' '.repeat(cells) + '\b'.repeat(cells)); },
    requestSnapshot: () => { due.push(now + L); },
    lineBeforeCursor: () => { const b = pred.buffer.active; return b.getLine(b.viewportY + b.cursorY)?.translateToString(false, 0, b.cursorX) ?? ''; },
    now: () => now,
  });
  echo.setEnabled(true);
  // 느린 링크를 겪은 상태로 시작한다 — 녹화도 워밍업 뒤에 시작했다.
  (echo as unknown as { srtt: number; predicting: boolean }).srtt = L;
  (echo as unknown as { srtt: number; predicting: boolean }).predicting = true;

  // 녹화를 시작할 때의 화면(프롬프트 등)에서 출발한다 — 비밀번호 프롬프트 판정이 이 줄을 본다.
  if (fx.initial) { await write(truth, fx.initial); await write(pred, fx.initial); }
  const initialText = screen(truth);

  const dec = new TextDecoder();
  // 시각은 양수로 민다. 첫 키가 t - L/2 < 0 이 되면 컨트롤러가 쿨다운(now < 0)으로 오판한다.
  const T0 = 10_000;
  type Ev = { t: number; kind: 'in'; s: string } | { t: number; kind: 'out'; b: Uint8Array };
  const events: Ev[] = [
    ...fx.inputs.map((x) => ({ t: T0 + x.t - L / 2, kind: 'in' as const, s: dec.decode(new Uint8Array(x.b)) })),
    ...fx.frames.map((x) => ({ t: T0 + x.t + L / 2, kind: 'out' as const, b: new Uint8Array(x.b) })),
  ].sort((a, b) => a.t - b.t);

  let predicted = 0, drift = 0, exposed = 0;
  const applySnapshots = async () => {
    while (due.length && due[0]! <= now) {
      due.shift();
      await write(pred, '\x1bc' + serial.serialize());
      echo.handleSnapshot();
    }
  };
  for (const ev of events) {
    now = ev.t;
    await applySnapshots();
    if (ev.kind === 'in') {
      // DEL 과 인쇄 가능한 입력만 예측 대상이다 — 나머지는 서버로만 간다.
      if (echo.handleLocalInput(ev.s)) predicted++;
    } else {
      await write(truth, ev.b);
      await write(pred, echo.reconcileServerData(ev.b));
    }
    await write(pred, '');
    // 지금 화면에 있어야 할 것: 서버가 그린 줄의 커서 앞 + 아직 확인 안 된 예측
    const pending = (echo as unknown as { pending: Array<{ text: string }> }).pending.map((p) => p.text).join('');
    const tb = truth.buffer.active;
    // 커서는 칸 단위다 — 문자열을 글자 수로 자르면 한글·이모지(2칸)에서 어긋난다.
    const want = (tb.getLine(tb.viewportY + tb.cursorY)?.translateToString(false, 0, tb.cursorX) ?? '') + pending;
    if (due.length === 0 && !cursorLine(pred).startsWith(want.replace(/\s+$/, ''))) drift++;
    if (fx.scenario === 'password' && hasRun(screen(pred), SECRET, 3, initialText)) exposed++;
  }
  now = Number.MAX_SAFE_INTEGER;
  await applySnapshots();
  return { predicted, mismatches: echo.getMismatchCount(), drift, exposed, final: screen(pred) === screen(truth) };
}

/** 비밀번호 조각(n자)이 보이는가 — 처음 화면에 이미 있던 조각(명령 "read -s" 등)은 뺀다. */
function hasRun(s: string, secret: string, n: number, baseline: string): boolean {
  for (let i = 0; i + n <= secret.length; i++) {
    const run = secret.slice(i, i + n);
    if (s.includes(run) && !baseline.includes(run)) return true;
  }
  return false;
}

describe('local echo replay (recorded PTY bytes)', () => {
  it('has fixtures', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fx of fixtures) {
    it(`${fx.scenario}: tolerant ends on the server's screen, drifts no more and predicts no less than classic`, async () => {
      const classic = await replay(fx, 'classic');
      const tolerant = await replay(fx, 'tolerant');
      console.log(`${fx.scenario.padEnd(13)} classic ${JSON.stringify(classic)}\n${''.padEnd(13)} tolerant ${JSON.stringify(tolerant)}`);
      expect(tolerant.final).toBe(true);
      expect(tolerant.drift).toBeLessThanOrEqual(classic.drift);
      expect(tolerant.exposed).toBe(0);
      // 비밀번호에서는 일부러 예측을 멈춘다 — 그 밖에서는 classic 보다 덜 예측하지 않는다.
      if (fx.scenario !== 'password') expect(tolerant.predicted).toBeGreaterThanOrEqual(classic.predicted);
    });
  }
});
