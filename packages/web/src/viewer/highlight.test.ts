import { describe, expect, it } from 'vitest';
import { highlightHtml, languageFor, languageForTag, splitHighlightedLines } from './highlight.js';

describe('grammar choice', () => {
  it('maps extensions and well-known names, and nothing else', () => {
    expect(languageFor('a.ts')).toBe('typescript');
    expect(languageFor('x.tsx')).toBe('typescript');
    expect(languageFor('main.rs')).toBe('rust');
    expect(languageFor('Makefile')).toBe('makefile');
    expect(languageFor('Dockerfile')).toBe('dockerfile');
    expect(languageFor('.zshrc')).toBe('bash');
    expect(languageFor('notes.txt')).toBeNull();
    expect(languageFor('README')).toBeNull();
  });
  it('reads a fence tag as a grammar name or an extension', () => {
    expect(languageForTag('sh')).toBe('bash');
    expect(languageForTag('python')).toBe('python');
    expect(languageForTag('py')).toBe('python');
    expect(languageForTag('c++')).toBe('cpp');
    expect(languageForTag('')).toBeNull();
    expect(languageForTag('mermaid')).toBeNull();
  });
});

describe('highlighting', () => {
  it('colours bash and splits multi-line spans per line', async () => {
    const html = await highlightHtml('echo hi\n# a comment\n# spanning', 'bash');
    expect(html).not.toBeNull();
    expect(html).toContain('hljs-');
    const lines = splitHighlightedLines(html!);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const opens = (line.match(/<span/g) ?? []).length;
      const closes = (line.match(/<\/span>/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });
  it('a block comment across lines is closed on each line and reopened on the next', () => {
    const lines = splitHighlightedLines('<span class="hljs-comment">/* a\nb */</span> x');
    expect(lines[0]).toBe('<span class="hljs-comment">/* a</span>');
    expect(lines[1]).toBe('<span class="hljs-comment">b */</span> x');
  });
  it('unknown grammar → null, caller renders plain text', async () => {
    expect(await highlightHtml('x', null)).toBeNull();
    expect(await highlightHtml('x', 'nope')).toBeNull();
  });
});
