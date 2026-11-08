import { describe, expect, it } from 'vitest';
import { MemoryPressure, cgroupPressurePath, levelFromDarwin, levelFromPsi, throttleEvery, type PressureLevel } from './pressure.js';

describe('memory pressure', () => {
  it('reads the macOS sysctl level', () => {
    expect(levelFromDarwin('1\n')).toBe('normal');
    expect(levelFromDarwin('2')).toBe('warn');
    expect(levelFromDarwin('4')).toBe('critical');
    expect(levelFromDarwin('')).toBeNull();
  });

  it('reads Linux PSI some avg10', () => {
    const psi = (n: number) => `some avg10=${n} avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`;
    expect(levelFromPsi(psi(0.5))).toBe('normal');
    expect(levelFromPsi(psi(12.3))).toBe('warn');
    expect(levelFromPsi(psi(55))).toBe('critical');
    expect(levelFromPsi('garbage')).toBeNull();
  });

  it('announces only changes, and keeps the last level when a read fails', async () => {
    const seq: Array<PressureLevel | null> = ['normal', 'warn', null, 'warn', 'critical', 'normal'];
    const p = new MemoryPressure(async () => seq.shift() ?? null);
    const seen: string[] = [];
    p.onChange((l, prev) => seen.push(`${prev}>${l}`));
    for (let i = 0; i < 6; i++) await p.poll();
    expect(seen).toEqual(['normal>warn', 'warn>critical', 'critical>normal']);
    expect(p.level).toBe('normal');
  });

  it('finds its own cgroup v2 pressure file', () => {
    expect(cgroupPressurePath('0::/user.slice/user-1001.slice/user@1001.service/ttymbench.slice/ttymbench-server.service\n'))
      .toBe('/sys/fs/cgroup/user.slice/user-1001.slice/user@1001.service/ttymbench.slice/ttymbench-server.service/memory.pressure');
    expect(cgroupPressurePath('0::/\n')).toBe('/sys/fs/cgroup/memory.pressure');
    expect(cgroupPressurePath('12:memory:/foo\n')).toBeNull(); // cgroup v1
  });

  it('slows periodic work under pressure', () => {
    expect(throttleEvery('normal')).toBe(1);
    expect(throttleEvery('warn')).toBe(2);
    expect(throttleEvery('critical')).toBe(10);
  });
});
