export interface Chunk {
  seq: number;
  data: Buffer;
}

/**
 * seq 기반 고정 크기 ring buffer.
 * PTY output을 저장하고, 재접속 시 delta replay를 지원한다.
 */
export class OutputRing {
  // 앞쪽 폐기는 head 인덱스만 민다. Array.shift()는 큰 배열에서 O(n)이라
  // 작은 chunk가 수만 개 쌓인 세션에서 push마다 배열 전체를 옮겼다.
  private buf: Chunk[] = [];
  private head = 0;
  private used = 0;
  private _nextSeq: number;
  private _baseSeq: number;

  constructor(private readonly maxBytes: number = 128 * 1024, baseSeq = 1) {
    this._nextSeq = baseSeq;
    this._baseSeq = baseSeq;
  }

  get nextSeq() { return this._nextSeq; }
  get baseSeq() { return this._baseSeq; }
  get byteSize() { return this.used; }

  private get chunks(): Chunk[] {
    if (this.head > 0) { this.buf = this.buf.slice(this.head); this.head = 0; }
    return this.buf;
  }

  private dropOldest(): void {
    const old = this.buf[this.head]!;
    this.buf[this.head++] = undefined as unknown as Chunk;
    this.used -= old.data.length;
    this._baseSeq = old.seq + 1;
    if (this.head >= 1024 && this.head * 2 >= this.buf.length) {
      this.buf = this.buf.slice(this.head);
      this.head = 0;
    }
  }

  push(data: Buffer): number {
    const seq = this._nextSeq++;
    this.buf.push({ seq, data });
    this.used += data.length;

    // oldest 폐기 (메모리 상한 유지)
    while (this.used > this.maxBytes && this.head < this.buf.length) this.dropOldest();

    return seq;
  }

  /** seqExclusive 이후의 모든 chunk 반환 */
  since(seqExclusive: number): Chunk[] {
    return this.chunks.filter((c) => c.seq > seqExclusive);
  }

  /** 해당 seq 이하의 chunk를 안전하게 제거 (ACK 기반) */
  trimTo(ackSeq: number) {
    while (this.head < this.buf.length && this.buf[this.head]!.seq <= ackSeq) this.dropOldest();
  }

  /** [fromSeq, toSeqExclusive) 구간 바이트 — 명령 출력 절취용. truncated = 앞부분이 ring에서 밀려남. */
  slice(fromSeq: number, toSeqExclusive: number): { data: Buffer; truncated: boolean } {
    const parts: Buffer[] = [];
    for (const c of this.chunks) {
      if (c.seq >= fromSeq && c.seq < toSeqExclusive) parts.push(c.data);
    }
    return { data: Buffer.concat(parts), truncated: fromSeq < this._baseSeq };
  }

  /** fromSeq가 ring에 남아있는지 (delta replay 가능 여부) */
  canReplaySince(fromSeq: number): boolean {
    return fromSeq >= this._baseSeq - 1;
  }

  clear() {
    this.buf = [];
    this.head = 0;
    this.used = 0;
  }
}
