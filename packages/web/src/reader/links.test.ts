import { describe, expect, it } from 'vitest';
import { splitLinks } from './links.js';

const shape = (s: string, hosts?: Set<string>) => splitLinks(s, hosts).map((p) => (p.kind === 'text' ? p.text : `<${p.kind}:${p.text}>`));

describe('splitLinks', () => {
  it('leaves plain text as one part', () => {
    expect(splitLinks('nothing to link here')).toEqual([{ kind: 'text', text: 'nothing to link here' }]);
  });

  it('finds urls and drops the punctuation of the sentence', () => {
    expect(shape('see https://example.com/a?b=1, then (https://example.com/x). Done.')).toEqual([
      'see ', '<url:https://example.com/a?b=1>', ', then (', '<url:https://example.com/x>', '). Done.',
    ]);
  });

  it('keeps a bracket that belongs to the url', () => {
    expect(shape('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual(['<url:https://en.wikipedia.org/wiki/Foo_(bar)>']);
  });

  it('ends a url where Korean text starts', () => {
    expect(shape('https://example.com/a를 열어')).toEqual(['<url:https://example.com/a>', '를 열어']);
  });

  it('finds session references, and machine-qualified ones only for known machines', () => {
    expect(shape('pane %1297 과 box%78, mac%9', new Set(['box']))).toEqual([
      'pane ', '<session:%1297>', ' 과 ', '<session:box%78>', ', mac%9',
    ]);
  });

  it('carries the session id and machine', () => {
    const p = splitLinks('box%78', new Set(['box']))[0];
    expect(p).toMatchObject({ kind: 'session', sessionId: 78, host: 'box' });
  });

  it('does not read %id inside a url as a session', () => {
    expect(shape('https://example.com/a%12b and %12')).toEqual(['<url:https://example.com/a%12b>', ' and ', '<session:%12>']);
  });

  it('rejects a scheme with nothing after it', () => {
    expect(shape('http:// alone')).toEqual(['http:// alone']);
  });
});
