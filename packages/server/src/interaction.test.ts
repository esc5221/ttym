import { describe, expect, it } from 'vitest';
import { InteractionStore } from './interaction.js';
import type { Session, TerminalMarker } from './session.js';

/** A Session stand-in: markCursor/transcriptSince are all the store touches. */
function fakeSession(id: number, transcript: string | null = 'output') {
  let disposed = false;
  const marker: TerminalMarker = {
    get line() { return disposed ? -1 : 4; },
    dispose() { disposed = true; },
  };
  return {
    id,
    markCursor: () => marker,
    transcriptSince: () => transcript,
    get markerDisposed() { return disposed; },
  } as unknown as Session & { markerDisposed: boolean };
}

describe('InteractionStore', () => {
  it('fills the transcript when the agent reports Stop', async () => {
    const store = new InteractionStore();
    const session = fakeSession(1, 'the answer');

    const started = store.start(session, 'a question');
    expect(started.status).toBe('pending');
    expect(started.transcript).toBeNull();

    const finished = await store.finish(session);
    expect(finished?.status).toBe('completed');
    expect(finished?.transcript).toBe('the answer');
    expect(store.get(started.id)?.transcript).toBe('the answer');
  });

  it('releases the waiter as soon as the interaction settles', async () => {
    const store = new InteractionStore();
    const session = fakeSession(2, 'done');
    const started = store.start(session, 'q');

    const waiting = store.wait(started.id, 5_000);
    setTimeout(() => store.finish(session), 20);

    const result = await waiting;
    expect(result?.status).toBe('completed');
    expect(result?.transcript).toBe('done');
  });

  it('leaves the interaction pending on timeout so it can be resumed', async () => {
    const store = new InteractionStore();
    const session = fakeSession(3);
    const started = store.start(session, 'q');

    const result = await store.wait(started.id, 30);
    expect(result?.status).toBe('pending');

    // The agent answers later; the same id still resolves.
    store.finish(session);
    expect(store.get(started.id)?.status).toBe('completed');
  });

  it('settles as failed when the agent reports StopFailure', async () => {
    const store = new InteractionStore();
    const session = fakeSession(4);
    const started = store.start(session, 'q');

    const waiting = store.wait(started.id, 5_000);
    store.finish(session, 'failed');

    const result = await waiting;
    expect(result?.status).toBe('failed');
    expect(store.pending(4)).toBeNull();
  });

  it('fails the previous interaction when a second prompt arrives', () => {
    const store = new InteractionStore();
    const session = fakeSession(5);

    const first = store.start(session, 'first');
    const second = store.start(session, 'second');

    expect(store.get(first.id)?.status).toBe('failed');
    expect(store.get(second.id)?.status).toBe('pending');
    expect(store.pending(5)?.id).toBe(second.id);
  });

  it('carries a null transcript when the marked rows scrolled away', async () => {
    const store = new InteractionStore();
    const session = fakeSession(6, null);

    const started = store.start(session, 'q');
    const finished = await store.finish(session);

    expect(finished?.status).toBe('completed');
    expect(finished?.transcript).toBeNull();
    expect(started.id).toBe(finished?.id);
  });

  it('abandons the in-flight interaction when the session dies', () => {
    const store = new InteractionStore();
    const session = fakeSession(7);
    const started = store.start(session, 'q');

    store.abandonSession(7);

    expect(store.get(started.id)?.status).toBe('failed');
    expect(store.pending(7)).toBeNull();
  });

  it('prunes settled records but keeps pending ones', () => {
    const store = new InteractionStore();
    const settled = store.start(fakeSession(8), 'q');
    store.finish(fakeSession(8));
    const pending = store.start(fakeSession(9), 'q');

    expect(store.prune(-1)).toBe(1);
    expect(store.get(settled.id)).toBeNull();
    expect(store.get(pending.id)?.status).toBe('pending');
  });
});
