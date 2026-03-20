const encoder = new TextEncoder();

const MAX_PENDING_BYTES = 1024;
const COOLDOWN_MS = 2000;

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

    this.pending.push({ bytes, text: data });
    this.writeOptimistic(data);
    return true;
  }

  handleBinaryInput(): void {
    this.disableTemporarily();
  }

  handleSnapshot(): void {
    this.reset();
  }

  reconcileServerData(data: Uint8Array): Uint8Array {
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
  }
}
