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

function isSimplePrintableInput(data: string): boolean {
  if (!data || data.length > 4) return false;
  for (const char of data) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

export interface LocalEchoControllerOptions {
  writeOptimistic: (text: string) => void;
  writeOptimisticBackspace: () => void;
  requestSnapshot: () => void;
  now?: () => number;
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
  private readonly writeOptimistic: (text: string) => void;
  private readonly writeOptimisticBackspace: () => void;
  private readonly requestSnapshot: () => void;
  private readonly now: () => number;

  constructor(options: LocalEchoControllerOptions) {
    this.writeOptimistic = options.writeOptimistic;
    this.writeOptimisticBackspace = options.writeOptimisticBackspace;
    this.requestSnapshot = options.requestSnapshot;
    this.now = options.now ?? (() => Date.now());
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
      return this.handleBackspace();
    }

    if (!isSimplePrintableInput(data)) return false;

    const bytes = encoder.encode(data);
    if (bytes.length === 0) return false;
    if (this.getPendingByteLength() + bytes.length > MAX_PENDING_BYTES) return false;

    // 예측하지 않기로 한 구간이어도 왕복 측정은 계속한다 — 그래야 링크가
    // 느려졌을 때 다시 켤 수 있다. pending 에 넣지 않고 시각만 기록한다.
    if (this.oldestSentAt === null) this.oldestSentAt = this.now();
    if (!this.shouldPredict()) return false;

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
    this.cooldownUntil = this.now() + COOLDOWN_MS;
  }

  private reset(): void {
    this.pending = [];
    this.oldestSentAt = null;
    // srtt 와 predicting 은 남긴다. 링크의 성질이지 이번 입력의 상태가 아니다.
  }
}
