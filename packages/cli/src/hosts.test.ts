import { describe, expect, it } from 'vitest';
import { qualify, qualifyHints, shq, splitRemote } from './hosts.js';

const hosts = { mini: { ssh: 'mini' }, pro: { ssh: 'pro' } };

describe('splitRemote', () => {
  it('leaves a command for this machine alone', () => {
    expect(splitRemote(['screen', '%78'], hosts)).toBeNull();
    expect(splitRemote(['screen', 'ws:term-1'], hosts)).toBeNull();
  });

  it('turns host%id and host/ws:name into the address on that machine', () => {
    expect(splitRemote(['screen', 'mini%78', '--json'], hosts)).toEqual({ host: 'mini', args: ['screen', '%78', '--json'] });
    expect(splitRemote(['await', 'mini/video:term-78', '--', 'hi'], hosts)).toEqual({ host: 'mini', args: ['await', 'video:term-78', '--', 'hi'] });
  });

  it('runs a whole command elsewhere with --host', () => {
    expect(splitRemote(['--host', 'mini', 'workspace', 'info'], hosts)).toEqual({ host: 'mini', args: ['workspace', 'info'] });
  });

  it('does not touch the text being sent', () => {
    expect(splitRemote(['send', '%5', '--', 'look at mini%78'], hosts)).toBeNull();
    expect(splitRemote(['send', 'mini%5', '--', 'look at pro%78'], hosts)).toEqual({ host: 'mini', args: ['send', '%5', '--', 'look at pro%78'] });
  });

  it('refuses two machines in one command, and names it unknown', () => {
    expect(splitRemote(['send', 'mini%1', 'pro%2'], hosts)).toHaveProperty('error');
    expect(splitRemote(['--host', 'nas', 'status'], hosts)).toHaveProperty('error');
  });

  it('ignores a prefix that is not a configured host', () => {
    expect(splitRemote(['screen', 'nas%3'], hosts)).toBeNull();
  });
});

describe('qualify', () => {
  it('names the machine on session ids in the output', () => {
    expect(qualify('video2audio:term-78  %78  [detached]', 'mini')).toBe('video2audio:term-78  mini%78  [detached]');
    expect(qualify('{"target":"%78"}', 'mini')).toBe('{"target":"mini%78"}');
  });

  it('leaves url encoding, percentages and already named ids', () => {
    expect(qualify('a%20b 100% mini%78', 'mini')).toBe('a%20b 100% mini%78');
  });
});

describe('qualifyHints', () => {
  it('points follow-up commands at the machine that holds the request', () => {
    expect(qualifyHints('keep waiting: ttym await --id int_abc', 'mini')).toBe('keep waiting: ttym --host mini await --id int_abc');
    expect(qualifyHints('   more: ttym turn int_abc   (--full …)', 'mini')).toBe('   more: ttym --host mini turn int_abc   (--full …)');
  });
});

describe('shq', () => {
  it('quotes for a remote shell', () => {
    expect(shq("it's")).toBe(`'it'\\''s'`);
  });
});
