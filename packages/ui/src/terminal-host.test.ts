import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 상태기 검증 — xterm/DOM은 전부 스텁이고, 관심사는 오직 스트림 전이다:
 *   idle → queued → attaching → attached ⇄ paused
 * 이 전이가 불리언 두 개였던 시절의 사고: ATTACH 실패 후 connected=true가
 * 남아 pane이 영구 빈 화면, 미부착 상태에서 PAUSE/RESUME이 와이어로 발사.
 */

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    writes: unknown[] = [];
    open() {}
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    parser = { registerOscHandler() { return { dispose() {} }; } };
    buffer = { active: { viewportY: 0 } };
    registerMarker() { return { line: 0, isDisposed: false, dispose() {} }; }
    scrollToLine() {}
    scrollToBottom() {}
    resized: Array<[number, number]> = [];
    resize(c: number, r: number) { this.resized.push([c, r]); }
    dispose() {}
    refresh() {}
    onBell() { return { dispose() {} }; }
    onData() { return { dispose() {} }; }
    onBinary() { return { dispose() {} }; }
    onResize() { return { dispose() {} }; }
    write(data: unknown, cb?: () => void) {
      this.writes.push(data);
      cb?.();
    }
  }
  return { Terminal };
});
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} dispose() {} } }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { findNext() { return true; } findPrevious() { return true; } clearDecorations() {} onDidChangeResults() { return { dispose() {} }; } dispose() {} } }));
// clipboard 애드온은 브라우저 전역(self)을 import 시점에 요구한다 — node 테스트에선 스텁.
vi.mock('@xterm/addon-web-fonts', () => ({ WebFontsAddon: class { dispose() {} } }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class { dispose() {} } }));
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: class { dispose() {} } }));

import { acquireHost, destroyAllHosts } from './terminal-host.js';
import type { TerminalMux } from '@ttym/vt';

interface FakeMux {
  attachCalls: number;
  attachResults: Array<'ok' | 'fail'>;
  attachOpts: Array<{ cols?: number; rows?: number }>;
  detached: number[];
  paused: number[];
  resumed: number[];
  forgotten: number[];
}

function fakeMux(): TerminalMux & FakeMux {
  const mux = {
    attachCalls: 0,
    attachResults: [] as Array<'ok' | 'fail'>,
    attachOpts: [] as Array<{ cols?: number; rows?: number }>,
    detached: [] as number[],
    paused: [] as number[],
    resumed: [] as number[],
    forgotten: [] as number[],
    attachSession(this: FakeMux, _id: number, _cbs: unknown, opts: { cols?: number; rows?: number }) {
      const result = this.attachResults[this.attachCalls] ?? 'ok';
      this.attachCalls += 1;
      this.attachOpts.push(opts);
      return result === 'ok'
        ? Promise.resolve({ id: 9, cols: 143, rows: 68 })
        : Promise.reject(new Error('attach timed out'));
    },
    detachSession(this: FakeMux, id: number) { this.detached.push(id); },
    pauseView(this: FakeMux, id: number) { this.paused.push(id); },
    resumeView(this: FakeMux, id: number) { this.resumed.push(id); },
    forgetSeq(this: FakeMux, id: number) { this.forgotten.push(id); },
    ack() {},
    send() {},
    resize() {},
    requestSnapshot() {},
  };
  return mux as unknown as TerminalMux & FakeMux;
}

function fakeElement(): HTMLElement {
  const el: Record<string, unknown> = {
    style: {},
    children: [],
    isConnected: false,
    parentElement: null,
    appendChild(child: Record<string, unknown>) { child.parentElement = el; },
    remove() {},
  };
  return el as unknown as HTMLElement;
}

/** 마이크로태스크(promise then 체인)를 몇 홉 비운다 — fake timer와 병행용. */
async function flushMicrotasks(hops = 6) {
  for (let i = 0; i < hops; i++) await Promise.resolve();
}

describe('TerminalHost stream state machine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('document', {
      createElement: () => fakeElement(),
      documentElement: {},
    });
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  });

  afterEach(() => {
    destroyAllHosts();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a failed attach retries with backoff and ends attached', async () => {
    const mux = fakeMux();
    mux.attachResults = ['fail', 'ok'];
    const host = acquireHost(mux, 9, { mode: 'readwrite', fontSize: 14, enableWebgl: false, localEcho: false });
    host.mount(fakeElement(), () => {});

    host.activate();
    await vi.advanceTimersByTimeAsync(50); // 스태거 큐 통과
    await flushMicrotasks();
    expect(mux.attachCalls).toBe(1); // 1차 실패

    await vi.advanceTimersByTimeAsync(600); // 백오프 500ms + 스태거
    await flushMicrotasks();
    expect(mux.attachCalls).toBe(2); // 재시도 성공

    // attached 증명: pause가 이제야 와이어에 나간다.
    host.pauseView();
    expect(mux.paused).toEqual([9]);
  });

  it('pause/resume before the stream is attached never reach the wire', async () => {
    const mux = fakeMux();
    const host = acquireHost(mux, 9, { mode: 'readwrite', fontSize: 14, enableWebgl: false, localEcho: false });
    host.mount(fakeElement(), () => {});

    host.activate(); // queued — 아직 ATTACH 전
    host.pauseView();
    host.resumeView();
    expect(mux.paused).toEqual([]);
    expect(mux.resumed).toEqual([]);

    await vi.advanceTimersByTimeAsync(50);
    await flushMicrotasks();
    host.pauseView();
    host.resumeView();
    expect(mux.paused).toEqual([9]);
    expect(mux.resumed).toEqual([9]);
  });

  it('disconnect while queued cancels the attach without a wire detach', async () => {
    const mux = fakeMux();
    const host = acquireHost(mux, 9, { mode: 'readwrite', fontSize: 14, enableWebgl: false, localEcho: false });
    host.mount(fakeElement(), () => {});

    host.activate();
    host.disconnect(); // 큐 대기 중 취소
    await vi.advanceTimersByTimeAsync(100);
    await flushMicrotasks();
    expect(mux.attachCalls).toBe(0); // ATTACH 자체가 발사되지 않는다
    expect(mux.detached).toEqual([]); // 서버에 붙은 적 없으니 DETACH도 없다

    // 그리고 이후의 activate는 멀쩡히 동작한다.
    host.activate();
    await vi.advanceTimersByTimeAsync(50);
    await flushMicrotasks();
    expect(mux.attachCalls).toBe(1);
  });

  it('follow geometry never announces or sends a size — and wears the server one', async () => {
    const mux = fakeMux();
    const host = acquireHost(mux, 9, { mode: 'readwrite', fontSize: 12, enableWebgl: false, localEcho: false, geometry: 'follow' });
    host.mount(fakeElement(), () => {});
    host.activate();
    await vi.advanceTimersByTimeAsync(50);
    await flushMicrotasks();
    // ① attach가 기하를 신고하지 않는다 — 신고하는 순간 서버 PTY가 줄어든다
    expect(mux.attachOpts[0].cols).toBeUndefined();
    expect(mux.attachOpts[0].rows).toBeUndefined();
    // ② 서버 기하(143x68)를 입는다
    const term = host.term as unknown as { resized: Array<[number, number]> };
    expect(term.resized).toContainEqual([143, 68]);
  });

  it('fit geometry (default) still announces its size at attach', async () => {
    const mux = fakeMux();
    const host = acquireHost(mux, 9, { mode: 'readwrite', fontSize: 14, enableWebgl: false, localEcho: false });
    host.mount(fakeElement(), () => {});
    host.activate();
    await vi.advanceTimersByTimeAsync(50);
    await flushMicrotasks();
    expect(mux.attachOpts[0].cols).toBe(80);
    expect(mux.attachOpts[0].rows).toBe(24);
  });

  it('exhausted retries still leave the host recoverable by a later activate', async () => {
    const mux = fakeMux();
    mux.attachResults = ['fail', 'fail', 'fail', 'fail'];
    const host = acquireHost(mux, 9, { mode: 'readwrite', fontSize: 14, enableWebgl: false, localEcho: false });
    host.mount(fakeElement(), () => {});

    host.activate();
    // 1차 + 백오프 재시도 3회(500/1000/2000ms) 전부 소진
    await vi.advanceTimersByTimeAsync(50);
    await flushMicrotasks();
    for (const ms of [600, 1200, 2400]) {
      await vi.advanceTimersByTimeAsync(ms);
      await flushMicrotasks();
    }
    expect(mux.attachCalls).toBe(4);

    // 예전 결함: connected=true 고착으로 영구 빈 pane. 지금은 idle이라
    // 다음 syncViewState(≈ activate)가 자연 회복시킨다.
    mux.attachResults.push('ok');
    host.activate();
    await vi.advanceTimersByTimeAsync(50);
    await flushMicrotasks();
    expect(mux.attachCalls).toBe(5);
    host.pauseView();
    expect(mux.paused).toEqual([9]);
  });
});
