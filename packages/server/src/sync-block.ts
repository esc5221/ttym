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
  | 'dcs'
  | 'dcsEsc'
  | 'apc'
  | 'apcEsc'
  | 'pm'
  | 'pmEsc'
  | 'sos'
  | 'sosEsc';

const ESC = 0x1b;
const BEL = 0x07;
const MAX_SYNC_BUFFER_BYTES = 512 * 1024;

function isCsiFinal(byte: number): boolean {
  return byte >= 0x40 && byte <= 0x7e;
}

function isStringTerminator(byte: number): boolean {
  return byte === BEL;
}

export class SyncBlockFilter {
  private state: ParseState = 'ground';
  private controlBytes: number[] = [];
  private visibleBytes: number[] = [];
  private syncTextBytes: number[] = [];
  private visibleChunks: Buffer[] = [];
  private syncChunks: Buffer[] = [];
  private syncBytes = 0;
  private _syncOpen = false;
  private _syncObserved = false;

  get syncOpen(): boolean { return this._syncOpen; }
  get syncObserved(): boolean { return this._syncObserved; }

  reset(): void {
    this.state = 'ground';
    this.controlBytes = [];
    this.visibleBytes = [];
    this.syncTextBytes = [];
    this.visibleChunks = [];
    this.syncChunks = [];
    this.syncBytes = 0;
    this._syncOpen = false;
    this._syncObserved = false;
  }

  abortOpenBlock(): Buffer | null {
    if (this.syncTextBytes.length > 0) {
      const chunk = Buffer.from(this.syncTextBytes);
      this.syncChunks.push(chunk);
      this.syncBytes += chunk.length;
      this.syncTextBytes = [];
    }
    if (!this._syncOpen || this.syncBytes === 0) {
      this._syncOpen = false;
      this.syncChunks = [];
      this.syncBytes = 0;
      return null;
    }
    const chunk = Buffer.concat(this.syncChunks, this.syncBytes);
    this._syncOpen = false;
    this.syncChunks = [];
    this.syncBytes = 0;
    return chunk;
  }

  process(data: Buffer): SyncFilterResult {
    this.visibleChunks = [];
    let syncStarted = false;
    let syncEnded = false;
    let overflowed = false;

    const flushBufferedText = (target: 'visible' | 'sync') => {
      if (target === 'visible') {
        if (this.visibleBytes.length === 0) return;
        this.visibleChunks.push(Buffer.from(this.visibleBytes));
        this.visibleBytes = [];
        return;
      }
      if (this.syncTextBytes.length === 0) return;
      const chunk = Buffer.from(this.syncTextBytes);
      this.syncChunks.push(chunk);
      this.syncBytes += chunk.length;
      this.syncTextBytes = [];
    };

    const pushVisibleByte = (byte: number) => {
      if (this._syncOpen) {
        this.syncTextBytes.push(byte);
        return;
      }
      this.visibleBytes.push(byte);
    };

    const pushControl = (bytes: number[]) => {
      if (bytes.length === 0) return;
      if (this._syncOpen) flushBufferedText('sync');
      else flushBufferedText('visible');
      const chunk = Buffer.from(bytes);
      if (this._syncOpen) {
        this.syncChunks.push(chunk);
        this.syncBytes += chunk.length;
      } else {
        this.visibleChunks.push(chunk);
      }
    };

    const flushControlAsVisible = () => {
      if (this.controlBytes.length === 0) return;
      pushControl(this.controlBytes);
      this.controlBytes = [];
    };

    const finishSequence = (preserve: boolean, action?: 'start' | 'end') => {
      if (preserve) flushControlAsVisible();
      else this.controlBytes = [];

      if (action === 'start') {
        syncStarted = true;
        this._syncObserved = true;
        this._syncOpen = true;
      }
      if (action === 'end') {
        syncEnded = true;
        this._syncObserved = true;
        this._syncOpen = false;
      }
      this.state = 'ground';
    };

    for (const byte of data) {
      switch (this.state) {
        case 'ground':
          if (byte === ESC) {
            this.controlBytes = [byte];
            this.state = 'esc';
          } else {
            pushVisibleByte(byte);
          }
          break;

        case 'esc':
          this.controlBytes.push(byte);
          if (byte === 0x5b) {
            this.state = 'csi';
          } else if (byte === 0x5d) {
            this.state = 'osc';
          } else if (byte === 0x50) {
            this.state = 'dcs';
          } else if (byte === 0x5f) {
            this.state = 'apc';
          } else if (byte === 0x5e) {
            this.state = 'pm';
          } else if (byte === 0x58) {
            this.state = 'sos';
          } else {
            finishSequence(true);
          }
          break;

        case 'csi': {
          this.controlBytes.push(byte);
          if (!isCsiFinal(byte)) break;
          const seq = Buffer.from(this.controlBytes).toString('binary');
          const action =
            seq === '\x1b[?2026h' ? 'start' :
            seq === '\x1b[?2026l' ? 'end' :
            undefined;
          finishSequence(!action, action);
          break;
        }

        case 'osc':
          this.controlBytes.push(byte);
          if (isStringTerminator(byte)) {
            finishSequence(true);
          } else if (byte === ESC) {
            this.state = 'oscEsc';
          }
          break;
        case 'oscEsc':
          this.controlBytes.push(byte);
          finishSequence(true);
          break;

        case 'dcs':
          this.controlBytes.push(byte);
          if (byte === ESC) this.state = 'dcsEsc';
          break;
        case 'dcsEsc':
          this.controlBytes.push(byte);
          if (byte === 0x5c) finishSequence(true);
          else this.state = 'dcs';
          break;

        case 'apc':
          this.controlBytes.push(byte);
          if (byte === ESC) this.state = 'apcEsc';
          break;
        case 'apcEsc':
          this.controlBytes.push(byte);
          if (byte === 0x5c) finishSequence(true);
          else this.state = 'apc';
          break;

        case 'pm':
          this.controlBytes.push(byte);
          if (byte === ESC) this.state = 'pmEsc';
          break;
        case 'pmEsc':
          this.controlBytes.push(byte);
          if (byte === 0x5c) finishSequence(true);
          else this.state = 'pm';
          break;

        case 'sos':
          this.controlBytes.push(byte);
          if (byte === ESC) this.state = 'sosEsc';
          break;
        case 'sosEsc':
          this.controlBytes.push(byte);
          if (byte === 0x5c) finishSequence(true);
          else this.state = 'sos';
          break;
      }

      if (this._syncOpen && this.syncBytes > MAX_SYNC_BUFFER_BYTES) {
        flushBufferedText('sync');
        const raw = this.abortOpenBlock();
        if (raw && raw.length > 0) {
          this.visibleChunks.push(raw);
        }
        overflowed = true;
      }
    }

    flushBufferedText('visible');
    flushBufferedText('sync');
    const emitted: Buffer[] = [...this.visibleChunks];
    let coalescedBytes = 0;
    if (syncEnded) {
      if (this.syncBytes > 0) {
        const chunk = Buffer.concat(this.syncChunks, this.syncBytes);
        emitted.push(chunk);
        coalescedBytes = chunk.length;
      }
      this.syncChunks = [];
      this.syncBytes = 0;
    }

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
