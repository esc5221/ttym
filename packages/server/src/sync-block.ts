export interface SyncFilterResult {
  emitted: Buffer[];
  syncStarted: boolean;
  syncEnded: boolean;
  syncOpen: boolean;
  syncObserved: boolean;
  coalescedBytes: number;
  overflowed: boolean;
}

type ParseState =
  | 'ground'
  | 'esc'
  | 'csi'
  | 'osc'
  | 'oscEsc'
  | 'str'      // DCS · APC · PM · SOS — ESC \ 로 끝난다
  | 'strEsc';

const ESC = 0x1b;
const BEL = 0x07;
const MAX_SYNC_BUFFER_BYTES = 512 * 1024;
/** CSI는 동기 출력 마커인지 보려고 모아 둔다. 이보다 길면 마커가 아니다 — 그대로 흘려보낸다. */
const MAX_CSI_BYTES = 64;
const START = Buffer.from('\x1b[?2026h', 'binary');
const END = Buffer.from('\x1b[?2026l', 'binary');

/**
 * 동기 출력(DEC 2026) 마커를 떼고, 블록 안의 바이트는 블록이 닫힐 때 한 조각으로 내보낸다.
 * 나머지 바이트는 순서대로 그대로 통과한다.
 *
 * 2026-11-06에 다시 썼다. 이전 구현은
 *  - 바이트마다 JS 배열에 push 했고(28ms/MB),
 *  - 같은 입력의 "블록 뒤" 바이트를 블록보다 먼저 내보냈고(PRE+블록+POST → PRE POST 블록),
 *  - 끝나지 않는 OSC·DCS를 통째로 모아 상한 없이 키웠다(1MiB → 배열 104만 칸).
 * 마커를 찾는 데 필요한 것은 CSI뿐이라, 문자열 시퀀스는 모으지 않고 흘려보낸다.
 * 출력은 호출마다 한 개의 전용 Buffer(allocUnsafeSlow)다 — 8KB 공용 풀을 붙잡지 않게.
 */
export class SyncBlockFilter {
  private state: ParseState = 'ground';
  /** 마커 판정을 위해 잡아 둔 ESC… 바이트 (ESC 하나 또는 짧은 CSI) */
  private pending: number[] = [];
  /** CSI가 MAX_CSI_BYTES를 넘어 판정을 포기하고 흘려보내는 중 */
  private csiPassthrough = false;
  private syncChunks: Buffer[] = [];
  private syncBytes = 0;
  private _syncOpen = false;
  private _syncObserved = false;

  get syncOpen(): boolean { return this._syncOpen; }
  get syncObserved(): boolean { return this._syncObserved; }

  reset(): void {
    this.state = 'ground';
    this.pending = [];
    this.csiPassthrough = false;
    this.syncChunks = [];
    this.syncBytes = 0;
    this._syncOpen = false;
    this._syncObserved = false;
  }

  abortOpenBlock(): Buffer | null {
    const held = this.syncBytes;
    const chunks = this.syncChunks;
    this.syncChunks = [];
    this.syncBytes = 0;
    const wasOpen = this._syncOpen;
    this._syncOpen = false;
    if (!wasOpen || held === 0) return null;
    return concatSlow(chunks, held);
  }

  process(data: Buffer): SyncFilterResult {
    const out: Buffer[] = [];
    let outBytes = 0;
    let syncStarted = false;
    let syncEnded = false;
    let overflowed = false;
    let coalescedBytes = 0;

    // 내보낼 바이트는 지금 열린 블록이 있으면 블록에, 없으면 out에 순서대로 쌓는다.
    const put = (buf: Buffer) => {
      if (buf.length === 0) return;
      if (this._syncOpen) {
        this.syncChunks.push(Buffer.from(buf)); // data는 큰 수신 버퍼의 일부일 수 있다 — 복사해 둔다
        this.syncBytes += buf.length;
        if (this.syncBytes > MAX_SYNC_BUFFER_BYTES) {
          const raw = this.abortOpenBlock();
          if (raw) { out.push(raw); outBytes += raw.length; }
          overflowed = true;
        }
      } else {
        out.push(buf);
        outBytes += buf.length;
      }
    };
    const flushPending = () => {
      if (this.pending.length === 0) return;
      put(Buffer.from(this.pending));
      this.pending = [];
    };

    let seg = 0; // 아직 내보내지 않은 통과 구간의 시작
    const cut = (end: number) => { if (end > seg) put(data.subarray(seg, end)); };

    for (let i = 0; i < data.length; i++) {
      const byte = data[i]!;
      switch (this.state) {
        case 'ground':
          if (byte === ESC) {
            cut(i);
            this.pending = [byte];
            this.state = 'esc';
            seg = i + 1;
          }
          break;

        case 'esc':
          if (byte === 0x5b) { // CSI — 마커 후보. 계속 모은다
            this.pending.push(byte);
            this.state = 'csi';
            this.csiPassthrough = false;
            seg = i + 1;
            break;
          }
          // 마커가 아니다: 잡아 둔 ESC와 이 바이트부터는 통과
          flushPending();
          seg = i;
          if (byte === 0x5d) this.state = 'osc';
          else if (byte === 0x50 || byte === 0x5f || byte === 0x5e || byte === 0x58) this.state = 'str';
          else { this.state = 'ground'; }
          break;

        case 'csi': {
          const final = byte >= 0x40 && byte <= 0x7e;
          if (this.csiPassthrough) {
            if (final) this.state = 'ground';
            break;
          }
          this.pending.push(byte);
          seg = i + 1;
          if (final) {
            const seq = Buffer.from(this.pending);
            this.pending = [];
            this.state = 'ground';
            if (seq.equals(START)) {
              syncStarted = true;
              this._syncObserved = true;
              this._syncOpen = true;
            } else if (seq.equals(END)) {
              syncEnded = true;
              this._syncObserved = true;
              if (this._syncOpen) {
                this._syncOpen = false;
                if (this.syncBytes > 0) {
                  const block = concatSlow(this.syncChunks, this.syncBytes);
                  coalescedBytes += block.length;
                  out.push(block);
                  outBytes += block.length;
                }
                this.syncChunks = [];
                this.syncBytes = 0;
              }
            } else {
              put(seq);
            }
          } else if (this.pending.length > MAX_CSI_BYTES) {
            flushPending();
            this.csiPassthrough = true;
          }
          break;
        }

        case 'osc':
          if (byte === BEL) this.state = 'ground';
          else if (byte === ESC) this.state = 'oscEsc';
          break;
        case 'oscEsc':
          // 이전 구현과 같다: OSC 안의 ESC 다음 바이트가 시퀀스를 끝낸다(ST가 아니어도).
          this.state = 'ground';
          break;

        case 'str':
          if (byte === ESC) this.state = 'strEsc';
          break;
        case 'strEsc':
          this.state = byte === 0x5c ? 'ground' : 'str';
          break;
      }
    }
    // 남은 통과 구간을 내보낸다. 마커 후보(pending)를 모으는 중이면 seg가 이미 끝에 있어 아무것도 안 나간다 —
    // pending은 다음 호출로 넘어간다.
    cut(data.length);

    const emitted = out.length === 0 ? [] : [concatSlow(out, outBytes)];
    return {
      emitted,
      syncStarted,
      syncEnded,
      syncOpen: this._syncOpen,
      syncObserved: this._syncObserved,
      coalescedBytes,
      overflowed,
    };
  }
}

/** 공용 풀(8KB slab)을 쓰지 않는 연결. 작은 조각이 오래 남아도 slab 전체를 붙잡지 않는다. */
function concatSlow(list: Buffer[], total: number): Buffer {
  const outBuf = Buffer.allocUnsafeSlow(total);
  let at = 0;
  for (const b of list) { b.copy(outBuf, at); at += b.length; }
  return outBuf;
}
