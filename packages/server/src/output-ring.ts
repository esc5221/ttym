export interface Chunk {
  seq: number;
  data: Buffer;
}

/**
 * seq 기반 고정 크기 ring buffer.
 * PTY output을 저장하고, 재접속 시 delta replay를 지원한다.
 */
export class OutputRing {
  private chunks: Chunk[] = [];
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

  push(data: Buffer): number {
    const seq = this._nextSeq++;
    this.chunks.push({ seq, data });
    this.used += data.length;

    // oldest 폐기 (메모리 상한 유지)
    while (this.used > this.maxBytes && this.chunks.length > 0) {
      const old = this.chunks.shift()!;
      this.used -= old.data.length;
      this._baseSeq = old.seq + 1;
    }

    return seq;
  }

  /** seqExclusive 이후의 모든 chunk 반환 */
  since(seqExclusive: number): Chunk[] {
    return this.chunks.filter((c) => c.seq > seqExclusive);
  }

  /** 해당 seq 이하의 chunk를 안전하게 제거 (ACK 기반) */
  trimTo(ackSeq: number) {
    while (this.chunks.length > 0 && this.chunks[0].seq <= ackSeq) {
      const old = this.chunks.shift()!;
      this.used -= old.data.length;
      this._baseSeq = old.seq + 1;
    }
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
    this.chunks = [];
    this.used = 0;
  }
}
