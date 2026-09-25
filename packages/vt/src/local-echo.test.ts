import { describe, expect, it, vi } from 'vitest';
import { LocalEchoController } from './local-echo.js';

/**
 * 예측은 왕복이 느릴 때만 켜진다. 아래 테스트들은 대부분 "예측이 켜진 상태"의
 * 동작을 검증하므로, 먼저 느린 링크를 한 번 겪게 해서 SRTT 를 올려둔다.
 * (실링크에서 이 역할은 사용자의 첫 몇 타가 한다)
 */
function warmSlowLink(controller: LocalEchoController, clock: { t: number }): void {
  controller.handleLocalInput('x');   // 표본만 남기고 예측은 아직 안 한다
  clock.t += 200;                     // 200ms 왕복 — 폰에서 실측한 값대로
  controller.reconcileServerData(new TextEncoder().encode('x'));
}

describe('LocalEchoController', () => {
  it('optimistically writes simple printable input and strips echoed bytes from server output', () => {
    const writeOptimistic = vi.fn();
    const writeOptimisticBackspace = vi.fn();
    const requestSnapshot = vi.fn();
    const clock = { t: 0 };
    const controller = new LocalEchoController({
      writeOptimistic, writeOptimisticBackspace, requestSnapshot, now: () => clock.t,
    });

    controller.setEnabled(true);
    warmSlowLink(controller, clock);

    expect(controller.handleLocalInput('a')).toBe(true);
    expect(writeOptimistic).toHaveBeenCalledWith('a');

    const reconciled = controller.reconcileServerData(new TextEncoder().encode('abc'));
    expect(new TextDecoder().decode(reconciled)).toBe('bc');
    expect(requestSnapshot).not.toHaveBeenCalled();
  });

  it('requests a snapshot and enters cooldown on mismatch', () => {
    const writeOptimistic = vi.fn();
    const writeOptimisticBackspace = vi.fn();
    const requestSnapshot = vi.fn();
    let now = 0;
    const controller = new LocalEchoController({
      writeOptimistic,
      writeOptimisticBackspace,
      requestSnapshot,
      now: () => now,
    });

    controller.setEnabled(true);
    warmSlowLink(controller, { get t() { return now; }, set t(v) { now = v; } });
    expect(controller.handleLocalInput('a')).toBe(true);

    const reconciled = controller.reconcileServerData(new TextEncoder().encode('zsh'));
    expect(reconciled).toHaveLength(0);
    expect(requestSnapshot).toHaveBeenCalledTimes(1);
    expect(controller.getMismatchCount()).toBe(1);

    now = 500;
    expect(controller.handleLocalInput('b')).toBe(false);

    now = 2500;
    expect(controller.handleLocalInput('b')).toBe(true);
  });

  it('does not optimistic-echo control keys or likely paste bursts', () => {
    const controller = new LocalEchoController({
      writeOptimistic: vi.fn(),
      writeOptimisticBackspace: vi.fn(),
      requestSnapshot: vi.fn(),
    });

    controller.setEnabled(true);

    expect(controller.handleLocalInput('\r')).toBe(false);
    expect(controller.handleLocalInput('\t')).toBe(false);
    expect(controller.handleLocalInput('hello')).toBe(false);
  });

  it('optimistically backspaces only pending optimistic text', () => {
    const writeOptimistic = vi.fn();
    const writeOptimisticBackspace = vi.fn();
    const clock = { t: 0 };
    const controller = new LocalEchoController({
      writeOptimistic,
      writeOptimisticBackspace,
      requestSnapshot: vi.fn(),
      now: () => clock.t,
    });

    controller.setEnabled(true);
    warmSlowLink(controller, clock);
    expect(controller.handleLocalInput('a')).toBe(true);
    expect(controller.handleLocalInput('b')).toBe(true);
    expect(controller.handleLocalInput('\u007f')).toBe(true);
    expect(writeOptimisticBackspace).toHaveBeenCalledTimes(1);

    const reconciled = controller.reconcileServerData(new TextEncoder().encode('aZ'));
    expect(new TextDecoder().decode(reconciled)).toBe('Z');
  });

  it('로컬처럼 빠른 링크에서는 예측하지 않는다', () => {
    const writeOptimistic = vi.fn();
    const clock = { t: 0 };
    const controller = new LocalEchoController({
      writeOptimistic,
      writeOptimisticBackspace: vi.fn(),
      requestSnapshot: vi.fn(),
      now: () => clock.t,
    });
    controller.setEnabled(true);

    // LAN 실측이 왕복 1ms다. 그런 응답을 몇 번 겪게 한다.
    for (let i = 0; i < 5; i++) {
      controller.handleLocalInput('a');
      clock.t += 1;
      controller.reconcileServerData(new TextEncoder().encode('a'));
    }

    const stats = controller.getStats();
    expect(stats.srtt).toBeLessThanOrEqual(20);
    expect(stats.predicting).toBe(false);
    // 예측을 안 하므로 화면에 미리 쓰지 않는다 — 어긋날 여지가 없다
    expect(controller.handleLocalInput('b')).toBe(false);
    expect(writeOptimistic).not.toHaveBeenCalled();
  });

  it('폰처럼 느린 링크에서는 예측한다', () => {
    const writeOptimistic = vi.fn();
    const clock = { t: 0 };
    const controller = new LocalEchoController({
      writeOptimistic,
      writeOptimisticBackspace: vi.fn(),
      requestSnapshot: vi.fn(),
      now: () => clock.t,
    });
    controller.setEnabled(true);

    controller.handleLocalInput('a');
    clock.t += 250;                       // 터널 경유 실측값
    controller.reconcileServerData(new TextEncoder().encode('a'));

    expect(controller.getStats().srtt).toBeGreaterThan(30);
    expect(controller.handleLocalInput('b')).toBe(true);
    expect(writeOptimistic).toHaveBeenCalledWith('b');
  });

  it('두 임계 사이에서는 직전 판단을 유지한다', () => {
    const clock = { t: 0 };
    const controller = new LocalEchoController({
      writeOptimistic: vi.fn(),
      writeOptimisticBackspace: vi.fn(),
      requestSnapshot: vi.fn(),
      now: () => clock.t,
    });
    controller.setEnabled(true);

    // 느린 링크로 시작해 예측을 켠다
    controller.handleLocalInput('a');
    clock.t += 200;
    controller.reconcileServerData(new TextEncoder().encode('a'));
    expect(controller.getStats().predicting).toBe(true);

    // 25ms 응답이 이어지면 SRTT 가 서서히 내려온다. 평활 계수가 1/8 이라
    // 200ms 에서 출발해 30회쯤 지나야 28ms 근처에 닿는다 (계산으로 확인).
    // 그 구간(20 초과 30 이하)에서도 켠 상태를 유지해야 한다 — 하나의 값으로
    // 잘랐다면 여기서 켜짐과 꺼짐이 번갈아 일어난다.
    for (let i = 0; i < 30; i++) {
      controller.handleLocalInput('a');
      clock.t += 25;
      controller.reconcileServerData(new TextEncoder().encode('a'));
    }
    const s = controller.getStats();
    expect(s.srtt).toBeGreaterThan(20);
    expect(s.srtt).toBeLessThanOrEqual(30);
    expect(s.predicting).toBe(true);
  });
});

describe('LocalEchoController tolerant', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const dec = (b: Uint8Array) => new TextDecoder().decode(b);
  function setup(line = '$ ') {
    const clock = { t: 0 };
    const writes: string[] = [];
    const backspaces: number[] = [];
    const requestSnapshot = vi.fn();
    const c = new LocalEchoController({
      mode: 'tolerant',
      writeOptimistic: (s) => writes.push(s),
      writeOptimisticBackspace: (cells = 1) => backspaces.push(cells),
      requestSnapshot,
      lineBeforeCursor: () => line,
      now: () => clock.t,
    });
    c.setEnabled(true);
    warmSlowLink(c, clock);
    return { c, clock, writes, backspaces, requestSnapshot };
  }

  it('lets a colour code through and matches the character after it (zsh highlighting)', () => {
    const { c, requestSnapshot } = setup();
    c.handleLocalInput('h');
    expect(dec(c.reconcileServerData(enc('\x1b[39mh')))).toBe('\x1b[39m');
    expect(requestSnapshot).not.toHaveBeenCalled();
    expect(c.getPendingByteLength()).toBe(0);
  });

  it('skips a step back that rewrites the confirmed character (zsh "\\bec")', () => {
    const { c, requestSnapshot } = setup();
    c.handleLocalInput('e');
    c.handleLocalInput('c');
    expect(dec(c.reconcileServerData(enc('e')))).toBe('');
    expect(dec(c.reconcileServerData(enc('\bec')))).toBe('');
    expect(requestSnapshot).not.toHaveBeenCalled();
    expect(c.getPendingByteLength()).toBe(0);
  });

  it('asks for a snapshot instead of drawing past predictions it has not caught up with', () => {
    const { c, requestSnapshot } = setup();
    c.handleLocalInput('a');
    c.handleLocalInput('b');
    // a 는 맞았는데 서버가 b 대신 다른 것을 그린다 — 그대로 쓰면 커서가 한 칸 앞선 채 적용된다
    // 이미 지나간 색상 코드만 흘려보낸다(커서가 안 움직인다). 나머지는 스냅샷이 그린다.
    expect(dec(c.reconcileServerData(enc('a\x1b[90msuggestion')))).toBe('\x1b[90m');
    expect(requestSnapshot).toHaveBeenCalledTimes(1);
  });

  it('writes what follows once every prediction is confirmed', () => {
    const { c, requestSnapshot } = setup();
    c.handleLocalInput('a');
    expect(dec(c.reconcileServerData(enc('a\x1b[90mbc\x1b[39m\x1b[2D')))).toBe('\x1b[90mbc\x1b[39m\x1b[2D');
    expect(requestSnapshot).not.toHaveBeenCalled();
  });

  it('does not predict at a password prompt', () => {
    const { c, writes } = setup('Password: ');
    expect(c.handleLocalInput('s')).toBe(false);
    expect(writes).toEqual([]);
  });

  it('erases two cells for a wide character and cuts by code point', () => {
    const { c, backspaces } = setup();
    c.handleLocalInput('안');
    c.handleLocalInput('🙂');
    expect(c.handleLocalInput('\u007f')).toBe(true);
    expect(c.handleLocalInput('\u007f')).toBe(true);
    expect(backspaces).toEqual([2, 2]);
    expect(c.getPendingByteLength()).toBe(0);
  });

  it('classic is untouched: the same colour-coded echo is still a mismatch there', () => {
    const clock = { t: 0 };
    const requestSnapshot = vi.fn();
    const c = new LocalEchoController({ writeOptimistic: () => {}, writeOptimisticBackspace: () => {}, requestSnapshot, now: () => clock.t });
    c.setEnabled(true);
    warmSlowLink(c, clock);
    c.handleLocalInput('h');
    expect(c.reconcileServerData(enc('\x1b[39mh')).length).toBe(0);
    expect(requestSnapshot).toHaveBeenCalledTimes(1);
  });
});
