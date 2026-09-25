const encoder = new TextEncoder();

const MAX_PENDING_BYTES = 1024;
const COOLDOWN_MS = 2000;

/**
 * 예측을 켤지 말지는 사용자가 아니라 왕복 시간이 정한다.
 *
 * 로컬 LAN 실측이 왕복 1ms다. 거기서 예측이 앞당기는 시간은 사람이 못 느끼는데,
 * 대신 화면이 어긋날 위험만 진다 — 실제로 "안녕하세요"를 치면 한 글자가 반복되는
 * 증상이 났다. 반대로 폰에서 터널을 거치면 250ms라 예측이 확실히 값을 한다.
 *
 * 임계값은 mosh(src/frontend/terminaloverlay.h)가 20년간 쓴 값을 그대로 가져왔다.
 * 20ms 이하면 끄고 30ms 넘으면 켠다. 사이 구간에서 직전 상태를 유지하는 것이
 * 핵심이다 — 하나의 값으로 자르면 경계에서 켜짐과 꺼짐이 번갈아 일어난다.
 */
const SRTT_TRIGGER_LOW = 20;
const SRTT_TRIGGER_HIGH = 30;
/** SRTT 평활 계수. mosh 와 같은 1/8. */
const SRTT_ALPHA = 1 / 8;
/** 이 시간 넘게 확인이 없으면 표본으로 치지 않는다 — 사용자가 잠깐 쉰 것일 수 있다. */
const SAMPLE_MAX_MS = 3000;

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function commonPrefixLength(a: Uint8Array, b: Uint8Array): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) index += 1;
  return index;
}

function hasRiskyControlSequence(data: Uint8Array): boolean {
  const text = new TextDecoder().decode(data);
  return (
    text.includes('\x1b[?1049h') ||
    text.includes('\x1b[?1049l') ||
    text.includes('\x1b[?47h') ||
    text.includes('\x1b[?47l') ||
    text.includes('\x1b[?1047h') ||
    text.includes('\x1b[?1047l') ||
    text.includes('\x1b[?2004h') ||
    text.includes('\x1b[?2004l')
  );
}

/** i 에서 SGR(ESC [ 숫자;… m)이 시작하면 그 끝 인덱스, 아니면 i. */
function sgrEndAt(data: Uint8Array, i: number): number {
  if (data[i] !== 0x1b || data[i + 1] !== 0x5b) return i;
  let k = i + 2;
  while (k < data.length && ((data[k]! >= 0x30 && data[k]! <= 0x39) || data[k] === 0x3b)) k += 1;
  return data[k] === 0x6d ? k + 1 : i;
}

function isSimplePrintableInput(data: string): boolean {
  if (!data || data.length > 4) return false;
  for (const char of data) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * classic   처음부터 있던 방식. 서버 출력의 앞부분이 친 바이트와 그대로 같아야 확인된다.
 * tolerant  같은 방식에 셸이 실제로 돌려주는 모양 몇 가지를 더 받아준다 (reconcileTolerant).
 *
 * 기본은 classic 이다. tolerant 는 설정에서 골라 써 보고, 아니다 싶으면 classic 으로
 * 되돌리면 그대로 예전 동작이다 — classic 경로는 tolerant 를 위해 한 줄도 바꾸지 않았다.
 */
export type LocalEchoMode = 'classic' | 'tolerant';

export interface LocalEchoControllerOptions {
  writeOptimistic: (text: string) => void;
  /** cells: 지울 칸 수. classic 은 늘 1, tolerant 는 폭 2칸 글자(한글·이모지)에 2. */
  writeOptimisticBackspace: (cells?: number) => void;
  requestSnapshot: () => void;
  now?: () => number;
  mode?: LocalEchoMode;
  /** tolerant: 커서 앞의 현재 줄 — 비밀번호 프롬프트면 예측하지 않는다. */
  lineBeforeCursor?: () => string;
}

/** 에코가 꺼진 입력(비밀번호)을 부르는 프롬프트. 줄 끝에서만 본다. */
const SECRET_PROMPT = /(pass(word|phrase)|passcode|\bpin\b|비밀번호|암호)[^\n]{0,24}[:：?]\s*$/i;
/** tolerant 에서 확정된 글자를 이만큼만 기억한다 — "k칸 뒤로 가서 다시 쓰기"의 k는 작다. */
const CONFIRMED_TAIL = 64;

/** 폭 2칸 글자 — 한글·CJK·전각·이모지. 예측 백스페이스가 몇 칸을 지울지 정할 때만 쓴다. */
function isWide(cp: number): boolean {
  return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd);
}

export class LocalEchoController {
  private enabled = false;
  private pending: Array<{ bytes: Uint8Array; text: string }> = [];
  private cooldownUntil = 0;
  private mismatchCount = 0;
  /** 평활 왕복 시간(ms). 표본이 없으면 null — 그때는 예측하지 않는다. */
  private srtt: number | null = null;
  /** 히스테리시스 상태. 임계 사이 구간에서 이 값을 유지한다. */
  private predicting = false;
  /** 가장 오래된 미확인 입력의 전송 시각. 왕복은 여기서 잰다. */
  private oldestSentAt: number | null = null;
  private mode: LocalEchoMode;
  /** tolerant: 이 줄에서 서버가 확인해 준 최근 바이트. 셸이 뒤로 가서 다시 쓰는 것을 알아보는 데 쓴다. */
  private confirmed: number[] = [];
  private readonly lineBeforeCursor?: () => string;
  private readonly writeOptimistic: (text: string) => void;
  private readonly writeOptimisticBackspace: (cells?: number) => void;
  private readonly requestSnapshot: () => void;
  private readonly now: () => number;

  constructor(options: LocalEchoControllerOptions) {
    this.writeOptimistic = options.writeOptimistic;
    this.writeOptimisticBackspace = options.writeOptimisticBackspace;
    this.requestSnapshot = options.requestSnapshot;
    this.now = options.now ?? (() => Date.now());
    this.mode = options.mode ?? 'classic';
    this.lineBeforeCursor = options.lineBeforeCursor;
  }

  setMode(mode: LocalEchoMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.reset();
  }

  getMode(): LocalEchoMode {
    return this.mode;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.reset();
  }

  getPendingByteLength(): number {
    return this.pending.reduce((sum, chunk) => sum + chunk.bytes.length, 0);
  }

  getMismatchCount(): number {
    return this.mismatchCount;
  }

  handleLocalInput(data: string): boolean {
    if (!this.enabled) return false;
    if (this.now() < this.cooldownUntil) return false;

    if (data === '\u007f') {
      return this.mode === 'tolerant' ? this.handleBackspaceTolerant() : this.handleBackspace();
    }

    if (!isSimplePrintableInput(data)) return false;

    const bytes = encoder.encode(data);
    if (bytes.length === 0) return false;
    if (this.getPendingByteLength() + bytes.length > MAX_PENDING_BYTES) return false;

    // 예측하지 않기로 한 구간이어도 왕복 측정은 계속한다 — 그래야 링크가
    // 느려졌을 때 다시 켤 수 있다. pending 에 넣지 않고 시각만 기록한다.
    if (this.oldestSentAt === null) this.oldestSentAt = this.now();
    if (!this.shouldPredict()) return false;
    if (this.mode === 'tolerant' && this.pending.length === 0 && this.atSecretPrompt()) return false;

    this.pending.push({ bytes, text: data });
    this.writeOptimistic(data);
    return true;
  }

  /**
   * 지금 예측해도 되는가. 표본이 쌓이기 전에는 하지 않는다 — 링크가 느린지
   * 빠른지 모르는 채로 거는 쪽이 위험하다.
   */
  private shouldPredict(): boolean {
    return this.srtt !== null && this.predicting;
  }

  /** 화면에 반영된 시점에 왕복 한 표본을 접는다. */
  private observeRoundTrip(): void {
    const sentAt = this.oldestSentAt;
    this.oldestSentAt = null;
    if (sentAt === null) return;
    const sample = this.now() - sentAt;
    if (sample < 0 || sample > SAMPLE_MAX_MS) return;
    this.srtt = this.srtt === null ? sample : this.srtt + SRTT_ALPHA * (sample - this.srtt);
    // 켤지 끌지는 여기서 정한다. 입력 시점에 판정하면 응답만 오가는 동안
    // 상태가 굳어, 링크가 느려졌는데도 예측이 안 켜진다.
    if (this.srtt > SRTT_TRIGGER_HIGH) this.predicting = true;
    else if (this.srtt <= SRTT_TRIGGER_LOW) this.predicting = false;
    // 두 임계 사이는 직전 판단을 유지한다 (히스테리시스)
  }

  /** 진단용 — 지금 재고 있는 왕복과 예측 여부. */
  getStats(): { srtt: number | null; predicting: boolean } {
    return { srtt: this.srtt, predicting: this.predicting };
  }

  handleBinaryInput(): void {
    this.disableTemporarily();
  }

  handleSnapshot(): void {
    this.reset();
  }

  reconcileServerData(data: Uint8Array): Uint8Array {
    // 서버가 무언가 보내온 순간이 곧 왕복 한 바퀴다. 예측을 걸었든 안 걸었든
    // 표본은 접는다 — 예측을 끈 구간에서도 링크 상태는 계속 알아야 한다.
    if (this.enabled && data.length > 0) this.observeRoundTrip();
    if (this.mode === 'tolerant') return this.reconcileTolerant(data);
    if (!this.enabled || this.pending.length === 0) return data;

    const pending = concatBytes(this.pending.map((chunk) => chunk.bytes));
    const matched = commonPrefixLength(data, pending);

    if (matched === 0) {
      this.mismatchCount += 1;
      this.disableTemporarily();
      this.requestSnapshot();
      return new Uint8Array(0);
    }

    this.consumePending(matched);
    const remainder = data.subarray(matched);
    if (remainder.length > 0 && hasRiskyControlSequence(remainder)) {
      this.reset();
    }
    return remainder;
  }

  /**
   * tolerant 의 대조. classic 과 같은 일을 하되, 셸이 실제로 돌려주는 모양 셋을 받아준다.
   * (dev PTY 녹화에서 본 것들이다 — local-echo.replay.test.ts 의 fixture)
   *
   *   색상 코드     zsh 강조는 글자 앞에 SGR 을 붙인다: "\x1b[39mh". 커서를 안 움직이므로
   *                그대로 흘려보내고 그 뒤 글자로 대조한다.
   *   뒤로 가서 다시  zsh 는 둘째 글자를 "\bec" 로 돌려준다 — 한 칸 뒤로 가서 이미 있는 e를
   *                다시 쓰고 c. 확정된 글자를 그대로 다시 쓰는 것이라 화면이 안 바뀐다. 건너뛴다.
   *   예측을 앞질러  확인 안 된 예측이 남아 있는데 서버가 다른 것을 그리기 시작하면, 그 나머지는
   *                서버가 모르는 칸만큼 앞선 커서 위에 쓰이게 된다. 쓰지 않고 스냅샷으로 넘긴다.
   *                classic 은 이때 그대로 써서 줄이 깨졌다("echenv | grep…").
   */
  private reconcileTolerant(data: Uint8Array): Uint8Array {
    if (!this.enabled) return data;
    if (this.pending.length === 0) {
      this.trackConfirmed(data);
      return data;
    }
    const pending = concatBytes(this.pending.map((chunk) => chunk.bytes));
    const passthrough: number[] = [];
    let i = 0;
    let j = 0;
    while (i < data.length) {
      const sgrEnd = sgrEndAt(data, i);
      if (sgrEnd > i) {
        for (let k = i; k < sgrEnd; k++) passthrough.push(data[k]!);
        i = sgrEnd;
        continue;
      }
      if (j < pending.length && data[i] === pending[j]) {
        this.pushConfirmed(data[i]!);
        i += 1;
        j += 1;
        continue;
      }
      const redraw = this.redrawLengthAt(data, i);
      if (redraw > 0) {
        i += redraw;
        continue;
      }
      break;
    }

    if (i === 0) {
      this.mismatchCount += 1;
      this.disableTemporarily();
      this.requestSnapshot();
      return new Uint8Array(0);
    }

    this.consumePending(j);
    const rest = data.subarray(i);
    if (rest.length === 0) return Uint8Array.from(passthrough);
    if (this.pending.length > 0) {
      this.mismatchCount += 1;
      this.disableTemporarily();
      this.requestSnapshot();
      return Uint8Array.from(passthrough);
    }
    // 예측을 다 따라잡았다 — 여기서부터는 서버와 커서가 같은 칸이다.
    this.trackConfirmed(rest);
    if (hasRiskyControlSequence(rest)) this.reset();
    const out = new Uint8Array(passthrough.length + rest.length);
    out.set(passthrough, 0);
    out.set(rest, passthrough.length);
    return out;
  }

  /** i 에서 BS k개 + 방금 확정된 k바이트(ASCII)가 오면 그 길이. 아니면 0. */
  private redrawLengthAt(data: Uint8Array, i: number): number {
    let k = 0;
    while (data[i + k] === 0x08) k += 1;
    if (k === 0 || k > this.confirmed.length) return 0;
    const tail = this.confirmed.slice(-k);
    for (let n = 0; n < k; n++) {
      const b = data[i + k + n];
      if (b === undefined || b !== tail[n] || tail[n]! >= 0x80) return 0;
    }
    return 2 * k;
  }

  private pushConfirmed(byte: number): void {
    this.confirmed.push(byte);
    if (this.confirmed.length > CONFIRMED_TAIL) this.confirmed.shift();
  }

  /** 예측 없이 흘러간 출력: 인쇄 가능한 것이면 확정 글자로 쌓고, 그 밖이면 줄이 바뀐 것으로 본다. */
  private trackConfirmed(data: Uint8Array): void {
    for (let i = 0; i < data.length;) {
      const sgrEnd = sgrEndAt(data, i);
      if (sgrEnd > i) { i = sgrEnd; continue; }
      const byte = data[i]!;
      if (byte >= 0x20 && byte !== 0x7f) this.pushConfirmed(byte);
      else { this.confirmed = []; return; }
      i += 1;
    }
  }

  private atSecretPrompt(): boolean {
    try { return SECRET_PROMPT.test(this.lineBeforeCursor?.() ?? ''); } catch { return false; }
  }

  /** tolerant 의 백스페이스 — 코드포인트 단위로 자르고, 폭 2칸 글자는 두 칸을 지운다. */
  private handleBackspaceTolerant(): boolean {
    if (this.pending.length === 0) return false;
    const tail = this.pending[this.pending.length - 1]!;
    const chars = Array.from(tail.text);
    const last = chars.pop()!;
    if (chars.length === 0) this.pending.pop();
    else {
      const nextText = chars.join('');
      this.pending[this.pending.length - 1] = { text: nextText, bytes: encoder.encode(nextText) };
    }
    this.writeOptimisticBackspace(isWide(last.codePointAt(0) ?? 0) ? 2 : 1);
    return true;
  }

  private consumePending(byteLength: number): void {
    let remaining = byteLength;
    while (remaining > 0 && this.pending.length > 0) {
      const head = this.pending[0]!;
      if (remaining >= head.bytes.length) {
        remaining -= head.bytes.length;
        this.pending.shift();
        continue;
      }
      this.pending[0] = {
        bytes: head.bytes.subarray(remaining),
        text: new TextDecoder().decode(head.bytes.subarray(remaining)),
      };
      remaining = 0;
    }
  }

  private handleBackspace(): boolean {
    if (this.pending.length === 0) return false;
    const tail = this.pending[this.pending.length - 1]!;
    if (tail.text.length <= 1) {
      this.pending.pop();
    } else {
      const nextText = tail.text.slice(0, -1);
      this.pending[this.pending.length - 1] = {
        text: nextText,
        bytes: encoder.encode(nextText),
      };
    }
    this.writeOptimisticBackspace();
    return true;
  }

  private disableTemporarily(): void {
    this.reset();
    // tolerant 도 2초다. 2×RTT 만큼만 쉬게 해 봤더니 E2E(250ms)에서 zsh-rc 깨진 화면이
    // 75→273ms, claude 스냅샷이 1→4회로 늘었다 — 복구 직후 다시 어긋나기를 반복한다.
    this.cooldownUntil = this.now() + COOLDOWN_MS;
  }

  private reset(): void {
    this.pending = [];
    this.oldestSentAt = null;
    this.confirmed = [];
    // srtt 와 predicting 은 남긴다. 링크의 성질이지 이번 입력의 상태가 아니다.
  }
}
