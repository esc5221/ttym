import { describe, expect, it } from 'vitest';
import { qualify, qualifyHints, shq, splitRemote } from './hosts.js';

const hosts = { box: { ssh: 'box' }, pro: { ssh: 'pro' } };

describe('splitRemote', () => {
  it('leaves a command for this machine alone', () => {
    expect(splitRemote(['screen', '%78'], hosts)).toBeNull();
    expect(splitRemote(['screen', 'ws:term-1'], hosts)).toBeNull();
  });

  it('turns host%id and host/ws:name into the address on that machine', () => {
    expect(splitRemote(['screen', 'box%78', '--json'], hosts)).toEqual({ host: 'box', args: ['screen', '%78', '--json'] });
    expect(splitRemote(['await', 'box/api:term-78', '--', 'hi'], hosts)).toEqual({ host: 'box', args: ['await', 'api:term-78', '--', 'hi'] });
  });

  it('runs a whole command elsewhere with --host', () => {
    expect(splitRemote(['--host', 'box', 'workspace', 'info'], hosts)).toEqual({ host: 'box', args: ['workspace', 'info'] });
  });

  it('does not touch the text being sent', () => {
    expect(splitRemote(['send', '%5', '--', 'look at box%78'], hosts)).toBeNull();
    expect(splitRemote(['send', 'box%5', '--', 'look at pro%78'], hosts)).toEqual({ host: 'box', args: ['send', '%5', '--', 'look at pro%78'] });
  });

  it('refuses two machines in one command, and names it unknown', () => {
    expect(splitRemote(['send', 'box%1', 'pro%2'], hosts)).toHaveProperty('error');
    expect(splitRemote(['--host', 'nas', 'status'], hosts)).toHaveProperty('error');
  });

  it('ignores a prefix that is not a configured host', () => {
    expect(splitRemote(['screen', 'nas%3'], hosts)).toBeNull();
  });
});

describe('qualify', () => {
  it('names the machine on session ids in the output', () => {
    expect(qualify('api:term-78  %78  [detached]', 'box')).toBe('api:term-78  box%78  [detached]');
    expect(qualify('{"target":"%78"}', 'box')).toBe('{"target":"box%78"}');
  });

  it('leaves url encoding, percentages and already named ids', () => {
    expect(qualify('a%20b 100% box%78', 'box')).toBe('a%20b 100% box%78');
  });
});

describe('qualifyHints', () => {
  it('points follow-up commands at the machine that holds the request', () => {
    expect(qualifyHints('keep waiting: ttym await --id int_abc', 'box')).toBe('keep waiting: ttym --host box await --id int_abc');
    expect(qualifyHints('   more: ttym turn int_abc   (--full …)', 'box')).toBe('   more: ttym --host box turn int_abc   (--full …)');
  });
});

describe('shq', () => {
  it('quotes for a remote shell', () => {
    expect(shq("it's")).toBe(`'it'\\''s'`);
  });
});
