import { afterEach, describe, expect, it, vi } from 'vitest';
import { request, resolveBase, ApiError } from './transport';
import { createApi } from './index';

function stubFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  vi.stubGlobal('fetch', async (input: URL | string, init: RequestInit = {}) => {
    const url = input instanceof URL ? input : new URL(String(input));
    calls.push({ url, init });
    return handler(url, init);
  });
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('base url resolution', () => {
  it('accepts a string or a thunk', () => {
    expect(resolveBase('http://x:1')).toBe('http://x:1');
    expect(resolveBase(() => 'http://y:2')).toBe('http://y:2');
  });

  it('trims trailing slashes so paths do not double up', () => {
    expect(resolveBase('http://x:1///')).toBe('http://x:1');
  });

  it('resolves the thunk per call, not once at construction', async () => {
    let port = 1;
    const calls = stubFetch(() => json([]));
    const api = createApi(() => `http://127.0.0.1:${port}`);
    await api.sessions.list();
    port = 2;
    await api.sessions.list();
    expect(calls.map((c) => c.url.port)).toEqual(['1', '2']);
  });
});

describe('request', () => {
  it('sends JSON bodies with the right header', async () => {
    const calls = stubFetch(() => json({ ok: true }));
    await request('http://h', '/api/x', { method: 'POST', body: { a: 1 } });
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(calls[0].init.body).toBe('{"a":1}');
  });

  it('appends query parameters and drops undefined ones', async () => {
    const calls = stubFetch(() => json([]));
    await request('http://h', '/api/x', { query: { project: 'p', missing: undefined } });
    expect(calls[0].url.searchParams.get('project')).toBe('p');
    expect(calls[0].url.searchParams.has('missing')).toBe(false);
  });

  it('throws ApiError carrying the status and the server message', async () => {
    stubFetch(() => new Response('workspace not found', { status: 404 }));
    await expect(request('http://h', '/api/workspaces/nope')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
    });
    // The reason has to survive — both apps used to discard the body.
    await expect(request('http://h', '/api/workspaces/nope')).rejects.toThrow(/workspace not found/);
  });

  it('returns undefined for an empty body rather than failing to parse', async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    await expect(request('http://h', '/api/x', { method: 'DELETE' })).resolves.toBeUndefined();
  });
});

describe('endpoint shapes', () => {
  it('builds the paths the server exposes', async () => {
    const calls = stubFetch(() => json({}));
    const api = createApi('http://h');

    await api.sessions.screen(7);
    await api.sessions.send(7, 'hi');
    await api.workspaces.get('a b');
    await api.workspaces.removeMember('a b', 3);
    await api.workspaces.split('w', { targetSessionId: 1 });
    await api.interactions.submit(2, { prompt: 'q', timeoutMs: 5 });

    expect(calls.map((c) => `${c.init.method ?? 'GET'} ${c.url.pathname}`)).toEqual([
      'GET /api/sessions/7/screen',
      'POST /api/sessions/7/send',
      'GET /api/workspaces/a%20b',          // ids are encoded
      'DELETE /api/workspaces/a%20b/members/3',
      'POST /api/workspaces/w/split',
      'POST /api/sessions/2/interactions',
    ]);
  });

  it('builds a layout when a workspace is created from session ids', async () => {
    const calls = stubFetch(() => json({}));
    await createApi('http://h').workspaces.create({ name: 'w', sessionIds: [1, 2] });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.layout.type).toBe('split');
    expect(body.layout.children.map((c: any) => c.sessionId)).toEqual([1, 2]);
  });
});
