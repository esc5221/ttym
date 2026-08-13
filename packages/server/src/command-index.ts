/**
 * 세션의 명령 인덱스 — 쉘이 스트림에 심는 OSC 133/633 신호를 서버가 읽어
 * "무엇을 돌렸고, 언제, 성패는, 출력 구간은 어디인가"를 데이터로 만든다.
 *
 * 신호 문법 (FinalTerm/VS Code 표준):
 *   133;A    프롬프트 시작  — 열린 명령이 있는데 D를 못 받았으면 여기서 미완 마감
 *   133;B    명령 입력 시작
 *   133;C    명령 실행(출력 시작)
 *   133;D;n  명령 종료, n = exit code (없을 수 있음)
 *   633;E;s  명령 원문 (VS Code 이스케이프: \\ · \x3b(;) · \x0a(개행))
 *
 * 신호는 검증하지 않는다 — 쉘이 안 심으면 인덱스가 비어 있을 뿐이고,
 * 순서가 어긋나면 그 명령 하나가 불완전하게 남을 뿐이다. 시한부 원칙:
 * 출력 바이트의 수명은 ring이 정하고, 여기 메타는 CAP까지 남는다.
 */

export interface CommandRecord {
  /** 세션 내 1-기준 일련번호 */
  n: number;
  /** 633;E가 온 경우의 명령 원문, 아니면 null */
  cmdline: string | null;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  /** 출력 구간 [startSeq, endSeq) — ring seq 좌표 */
  startSeq: number;
  endSeq: number | null;
}

const CAP = 500;

/** 633;E 페이로드 디코드 — \\ 를 먼저 풀면 \x3b가 이중해석되므로 토큰 단위로 푼다. */
export function decode633E(payload: string): string {
  return payload.replace(/\\\\|\\x3b|\\x0a/g, (tok) =>
    tok === '\\\\' ? '\\' : tok === '\\x3b' ? ';' : '\n');
}

export class CommandIndex {
  private records: CommandRecord[] = [];
  private open: CommandRecord | null = null;
  private pendingCmdline: string | null = null;
  private counter = 0;

  /** @param seq 현재 ring 위치를 물어보는 콜백 — 신호 수신 시점의 스트림 좌표 */
  constructor(private readonly seq: () => number, private readonly now: () => number = Date.now) {}

  osc133(data: string): void {
    const kind = data[0];
    switch (kind) {
      case 'A': {
        // D 없이 프롬프트가 돌아왔다 — 미완으로 마감 (Ctrl-C, 쉘 교체 등)
        if (this.open) this.close(null);
        break;
      }
      case 'B':
        break;
      case 'C': {
        if (this.open) this.close(null);
        this.open = {
          n: ++this.counter,
          cmdline: this.pendingCmdline,
          exitCode: null,
          startedAt: this.now(),
          endedAt: null,
          startSeq: this.seq(),
          endSeq: null,
        };
        this.pendingCmdline = null;
        break;
      }
      case 'D': {
        const payload = data.length > 2 && data[1] === ';' ? data.slice(2) : null;
        const code = payload !== null && /^\d+$/.test(payload) ? parseInt(payload, 10) : null;
        this.close(code);
        break;
      }
    }
  }

  osc633(data: string): void {
    if (data[0] === 'E') {
      const payload = data.length > 2 && data[1] === ';' ? data.slice(2) : '';
      // E는 C보다 먼저 온다(preexec) — 다음 C가 집어간다
      this.pendingCmdline = decode633E(payload);
    }
  }

  private close(exitCode: number | null): void {
    if (!this.open) return;
    this.open.exitCode = exitCode;
    this.open.endedAt = this.now();
    this.open.endSeq = this.seq();
    this.records.push(this.open);
    this.open = null;
    if (this.records.length > CAP) this.records.splice(0, this.records.length - CAP);
  }

  /** 시간순(오래된 → 최신). 진행 중 명령은 endedAt=null로 맨 뒤에 포함. */
  list(limit = 50): CommandRecord[] {
    const all = this.open ? [...this.records, this.open] : this.records;
    return all.slice(-limit);
  }

  get total(): number {
    return this.counter;
  }
}
