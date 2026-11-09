/**
 * 시스템 메모리 압박 감지. 압박 중에는 서버가 급하지 않은 주기 작업을 줄인다.
 *
 * 왜: 메모리가 바닥나면 macOS는 최근에 안 만진 페이지부터 압축·swap으로 내보낸다. 세션 수백 개의 상태를 든
 * 서버 힙은 대부분 한동안 안 만지는 데이터라 먼저 밀려나고, 그 뒤 주기 작업이 그 페이지를 건드릴 때마다
 * 폴트가 나서 이벤트 루프 하나가 통째로 멈춘다(2026-11-08 macpro: API 20초 무응답, LAG 최대 18초, CPU 1~5%).
 * 압박 중에 덜 만지면 덜 멈춘다.
 *
 * 레벨:
 *   macOS  sysctl kern.memorystatus_vm_pressure_level — 1 normal, 2 warn, 4 critical (root 불필요)
 *   Linux  /proc/pressure/memory 의 some avg10 — 10% 이상 warn, 40% 이상 critical
 *   그 외  항상 normal
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export type PressureLevel = 'normal' | 'warn' | 'critical';

export const PRESSURE_POLL_MS = 5_000;

export function levelFromDarwin(raw: string): PressureLevel | null {
  const n = parseInt(raw.trim(), 10);
  if (n === 1) return 'normal';
  if (n === 2) return 'warn';
  if (n === 4) return 'critical';
  return null;
}

export function levelFromPsi(raw: string): PressureLevel | null {
  const m = /^some\s.*?avg10=([\d.]+)/m.exec(raw);
  if (!m) return null;
  const avg10 = parseFloat(m[1]!);
  if (avg10 >= 40) return 'critical';
  if (avg10 >= 10) return 'warn';
  return 'normal';
}

export type PressureReader = () => Promise<PressureLevel | null>;

/** cgroup v2: /proc/self/cgroup의 `0::<path>` → /sys/fs/cgroup<path>/memory.pressure (없으면 null) */
export function cgroupPressurePath(procSelfCgroup: string, root = '/sys/fs/cgroup'): string | null {
  const m = /^0::(\/.*)$/m.exec(procSelfCgroup);
  if (!m) return null;
  return `${root}${m[1] === '/' ? '' : m[1]}/memory.pressure`;
}

let ownPath: string | null | undefined;
async function ownCgroupPressurePath(): Promise<string | null> {
  if (ownPath !== undefined) return ownPath;
  try {
    const p = cgroupPressurePath(await readFile('/proc/self/cgroup', 'utf8'));
    ownPath = p && (await readFile(p, 'utf8').then(() => true, () => false)) ? p : null;
  } catch { ownPath = null; }
  return ownPath;
}

export function defaultPressureReader(platform = process.platform): PressureReader {
  if (platform === 'darwin') {
    return () => new Promise((resolve) => {
      execFile('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeout: 2_000 }, (err, out) => {
        resolve(err ? null : levelFromDarwin(String(out)));
      });
    });
  }
  if (platform === 'linux') {
    // 자기 cgroup의 memory.pressure를 먼저 — 공용 머신에서 다른 사용자 때문에 생긴 압박에 반응하지 않고,
    // 컨테이너·systemd 유닛 안에서는 상한에 닿은 것을 본다. 못 읽으면 시스템 전체(/proc/pressure/memory).
    return async () => {
      const own = await ownCgroupPressurePath();
      if (own) {
        const lvl = await readFile(own, 'utf8').then(levelFromPsi, () => null);
        if (lvl) return lvl;
      }
      return readFile('/proc/pressure/memory', 'utf8').then(levelFromPsi, () => null);
    };
  }
  return async () => null;
}

export class MemoryPressure {
  private _level: PressureLevel = 'normal';
  private timer: ReturnType<typeof setInterval> | null = null;
  private reading = false;
  private listeners: Array<(level: PressureLevel, prev: PressureLevel) => void> = [];

  constructor(private readonly read: PressureReader = defaultPressureReader()) {}

  get level(): PressureLevel { return this._level; }
  /** warn 이상 */
  get high(): boolean { return this._level !== 'normal'; }

  onChange(fn: (level: PressureLevel, prev: PressureLevel) => void): void { this.listeners.push(fn); }

  async poll(): Promise<PressureLevel> {
    if (this.reading) return this._level;
    this.reading = true;
    try {
      const next = await this.read();
      if (next && next !== this._level) {
        const prev = this._level;
        this._level = next;
        for (const fn of this.listeners) { try { fn(next, prev); } catch {} }
      }
    } finally {
      this.reading = false;
    }
    return this._level;
  }

  start(intervalMs = PRESSURE_POLL_MS): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => { void this.poll(); }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * 압박 중에 주기 작업을 몇 번에 한 번만 돌릴지. warn은 2번에 1번, critical은 10번에 1번.
 * 3초 sweep이면 warn에서 6초, critical에서 30초 간격이 된다. 그만큼 허락 창(waiting)·끊긴 턴 표시가 늦다.
 * warn을 약하게 둔 이유: findAgentProcess 색인을 고친 뒤 sweep 한 번은 약 0.3ms + ps 한 번이고, 이 맥은
 * 평소에도 warn에 자주 들어간다(2026-11-08 02:20, 02:33).
 */
export function throttleEvery(level: PressureLevel): number {
  return level === 'critical' ? 10 : level === 'warn' ? 2 : 1;
}
