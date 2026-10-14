import { describe, expect, it } from 'vitest';
import { colorFor, faviconSvg, initialOf, parseAccent, pickState, summarizeAgents, tabTitle } from './favicon.js';

describe('tabTitle', () => {
  it('puts one plain symbol first, then the name', () => {
    expect(tabTitle({ base: 'readertest', state: 'idle' })).toBe('readertest');
    expect(tabTitle({ base: 'readertest', state: 'run' })).toBe('◐ readertest');
    expect(tabTitle({ base: 'readertest', state: 'done' })).toBe('✓ readertest');
  });
  it('says how many wait, and that the connection is lost', () => {
    expect(tabTitle({ base: 'mini', state: 'wait', count: 2 })).toBe('! mini · 2 대기');
    expect(tabTitle({ base: 'mini', state: 'offline' })).toBe('⚠ mini · 연결 끊김');
  });
  it('is "ttym" with no place, and names the instance last', () => {
    expect(tabTitle({ state: 'idle' })).toBe('ttym');
    expect(tabTitle({ base: 'build', state: 'done', instance: 'mini' })).toBe('✓ build · mini');
  });
});

describe('faviconSvg', () => {
  it('draws one digit and two digits differently, capped at 99', () => {
    const one = faviconSvg({ state: 'wait', count: 3 });
    const two = faviconSvg({ state: 'wait', count: 12 });
    expect(one).not.toBe(two);
    expect(faviconSvg({ state: 'wait', count: 250 })).toBe(faviconSvg({ state: 'wait', count: 99 }));
  });
  it('takes the instance colour for the block', () => {
    expect(faviconSvg({ state: 'idle', accent: '#5aa9f2' })).toContain('#5aa9f2');
  });
  it('differs per state', () => {
    const states = (['idle', 'run', 'done', 'wait', 'offline'] as const).map((state) => faviconSvg({ state, count: 1 }));
    expect(new Set(states).size).toBe(5);
  });
});

describe('parseAccent', () => {
  it('accepts a hex colour with or without #, else the brand colour', () => {
    expect(parseAccent('#5AA9F2')).toBe('#5aa9f2');
    expect(parseAccent('6fcf97')).toBe('#6fcf97');
    expect(parseAccent('blue')).toBe('#f29c5c');
    expect(parseAccent(undefined)).toBe('#f29c5c');
  });
});

describe('summarizeAgents and pickState', () => {
  it('counts waiting panes across workspaces; a waiting pane is not also running', () => {
    const s = summarizeAgents({
      1: { kind: 'claude-code', active: true, waiting: 'permission' },
      2: { kind: 'codex', active: true },
      3: { kind: null, active: true },
      4: { kind: 'claude-code', active: false, waiting: 'x' },
    });
    expect(s).toEqual({ waiting: 2, running: true });
  });
  it('ignores a sleeping agent for running', () => {
    expect(summarizeAgents({ 1: { kind: 'claude-code', active: true, sleep: { state: 'sleeping' } } }).running).toBe(false);
  });
  it('ranks offline, waiting, done, running, idle', () => {
    const base = { connected: true, waiting: 0, doneUnseen: false, running: false };
    expect(pickState({ ...base, connected: false, waiting: 1 })).toBe('offline');
    expect(pickState({ ...base, waiting: 1, doneUnseen: true, running: true })).toBe('wait');
    expect(pickState({ ...base, doneUnseen: true, running: true })).toBe('done');
    expect(pickState({ ...base, running: true })).toBe('run');
    expect(pickState(base)).toBe('idle');
  });
});

describe('workspace identity', () => {
  it('keeps a workspace colour for its id and takes the first Latin letter as initial', () => {
    expect(colorFor('6bb120ba')).toBe(colorFor('6bb120ba'));
    expect(initialOf('ttym-dev')).toBe('T');
    expect(initialOf('한글 api')).toBe('A');
    expect(initialOf('한글방')).toBe('');
  });
  it('differs per workspace and carries a dot for waiting elsewhere', () => {
    const a = faviconSvg({ state: 'idle', identity: { key: 'a1', name: 'api' } });
    expect(a).not.toBe(faviconSvg({ state: 'idle', identity: { key: 'b2', name: 'web' } }));
    expect(faviconSvg({ state: 'idle', identity: { key: 'a1', name: 'api' }, elsewhere: true })).not.toBe(a);
  });
  it('counts only the scoped sessions', () => {
    const s = { 1: { kind: 'claude', active: false, waiting: 'x' }, 2: { kind: 'claude', active: true } };
    expect(summarizeAgents(s, new Set([2]))).toEqual({ waiting: 0, running: true });
    expect(summarizeAgents(s)).toEqual({ waiting: 1, running: true });
  });
});
