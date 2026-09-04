import type { ViewItem } from '@ttym/api';
import { API_BASE } from '../app-shared.js';

/** Everything a renderer needs to fetch: where the tab's bytes live. */

export function viewBase(item: ViewItem): string {
  return `${API_BASE}/view/${item.cap}/`;
}

/** URL of the tab's own document (file tabs), or the tab's root (dir tabs). */
export function viewSrc(item: ViewItem): string {
  if (item.kind === 'url') return item.target;
  if (item.kind === 'dir') return viewBase(item);
  return viewBase(item) + encodeURIComponent(item.name);
}

/** Relative path under a tab's root → fetchable URL. */
export function viewUrl(item: ViewItem, rel: string): string {
  return viewBase(item) + rel.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

export const TEXT_MAX_BYTES = 2 * 1024 * 1024;

export interface TextFetch { text: string; total: number; partial: boolean }

/**
 * The first `maxBytes` of a file as text. Beyond that the renderer shows a
 * preview and says so — a 50 MB log must not be parsed into a React tree.
 */
export async function fetchText(url: string, maxBytes = TEXT_MAX_BYTES): Promise<TextFetch> {
  const res = await fetch(url, { headers: { Range: `bytes=0-${maxBytes - 1}` } });
  if (res.status !== 200 && res.status !== 206) throw new Error(`HTTP ${res.status}`);
  const range = res.headers.get('Content-Range');
  const total = range ? parseInt(range.split('/')[1] ?? '0', 10) : parseInt(res.headers.get('Content-Length') ?? '0', 10);
  const buf = await res.arrayBuffer();
  const partial = res.status === 206 && buf.byteLength < total;
  return { text: new TextDecoder('utf-8').decode(buf), total, partial };
}

export function humanSize(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return i === 0 ? `${v} B` : `${v.toFixed(1)} ${units[i]}`;
}

/** RFC-4180-ish: quoted fields, doubled quotes, embedded newlines. */
export function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      row.push(field); rows.push(row); row = []; field = '';
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else field += c;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/** Split text into lines, dropping a trailing partial line when the fetch was cut. */
export function completeLines(text: string, partial: boolean): string[] {
  const lines = text.split('\n');
  if (partial) lines.pop();
  else if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}
