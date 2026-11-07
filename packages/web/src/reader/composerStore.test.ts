import { beforeEach, describe, expect, it } from 'vitest';

const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  (globalThis as { sessionStorage?: unknown }).sessionStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
  };
});

describe('composerStore', () => {
  it("keeps a pane's draft across the field being unmounted, and in sessionStorage for a reload", async () => {
    const { composerState, updateComposer } = await import('./composerStore.js');
    updateComposer(41, () => ({ draft: 'written during the turn' }));
    // The field goes away and comes back: what it reads is still there.
    expect(composerState(41).draft).toBe('written during the turn');
    expect(mem.get('ttym-composer-draft-41')).toBe('written during the turn');
    updateComposer(41, () => ({ draft: null }));
    expect(mem.has('ttym-composer-draft-41')).toBe(false);
  });

  it('keeps drafts of different panes apart', async () => {
    const { composerState, updateComposer } = await import('./composerStore.js');
    updateComposer(1, () => ({ draft: 'one' }));
    updateComposer(2, () => ({ draft: 'two' }));
    expect([composerState(1).draft, composerState(2).draft]).toEqual(['one', 'two']);
  });
});
