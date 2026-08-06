/**
 * One place that knows how to reach a ttym server.
 *
 * The desktop app talks to a loopback port it started itself; the web app talks
 * to whatever host served it. Both used to carry their own fetch calls and
 * their own idea of an error, so an endpoint change had to be made twice and a
 * failed request surfaced differently in each.
 */

/** Resolved lazily, so a caller whose port is not known yet can still build a client. */
export type BaseUrl = string | (() => string);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`${status} ${url}${body ? ` — ${body.slice(0, 200)}` : ''}`);
    this.name = 'ApiError';
  }
}

export function resolveBase(base: BaseUrl): string {
  const value = typeof base === 'function' ? base() : base;
  return value.replace(/\/+$/, '');
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
}

/**
 * Perform a request and return the parsed body.
 *
 * A non-2xx response throws ApiError carrying the status and whatever the
 * server said, rather than a bare `HTTP 500` — the reason is usually in the
 * body and both apps used to discard it.
 */
export async function request<T>(base: BaseUrl, path: string, options: RequestOptions = {}): Promise<T> {
  const url = new URL(resolveBase(base) + path);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const init: RequestInit = { method: options.method ?? 'GET', signal: options.signal };
  if (options.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(options.body);
  }

  const res = await fetch(url, init);
  if (!res.ok) {
    throw new ApiError(res.status, url.pathname, await res.text().catch(() => ''));
  }
  if (res.status === 204) return undefined as T;

  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}
