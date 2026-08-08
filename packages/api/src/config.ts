import { request, type BaseUrl } from './transport.js';

export type ConfigValues = Record<string, string>;

export function getConfig(base: BaseUrl): Promise<{ values: ConfigValues }> {
  return request(base, '/api/config');
}

/** null deletes a key. Returns the merged values. */
export function patchConfig(base: BaseUrl, patch: Record<string, string | null>): Promise<{ values: ConfigValues }> {
  return request(base, '/api/config', { method: 'PATCH', body: patch });
}
