import { useScrollMemory } from '../useScrollMemory.js';
import { useEffect, useMemo, useState } from 'react';
import type { ViewItem } from '@ttym/api';
import { completeLines, fetchText, humanSize, parseDelimited, viewSrc } from '../content.js';

const MAX_ROWS = 5000;

interface Loaded { headers: string[]; rows: string[][]; total: number; partial: boolean; count: number }

/**
 * CSV, TSV and JSONL as a sortable, searchable grid. Reads the first 2 MB
 * and says so when that is not the whole file; a row count is only claimed
 * when it is.
 */
export function TableView({ item }: { item: ViewItem }) {
  const scrollRef = useScrollMemory(item.cap ?? item.id);
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ col: number; asc: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchText(viewSrc(item)).then((res) => {
      if (cancelled) return;
      const ext = item.name.toLowerCase().split('.').pop() ?? '';
      const lines = completeLines(res.text, res.partial);
      if (ext === 'jsonl' || ext === 'ndjson') {
        const objects: Record<string, unknown>[] = [];
        const keys: string[] = [];
        const seen = new Set<string>();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const o = JSON.parse(line);
            if (o && typeof o === 'object' && !Array.isArray(o)) {
              objects.push(o);
              for (const k of Object.keys(o)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
            }
          } catch { /* a bad line is skipped, not fatal */ }
          if (objects.length >= MAX_ROWS) break;
        }
        const rows = objects.map((o) => keys.map((k) => { const v = o[k]; return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); }));
        setData({ headers: keys, rows, total: res.total, partial: res.partial, count: objects.length });
      } else {
        const parsed = parseDelimited(lines.join('\n'), ext === 'tsv' ? '\t' : ',');
        const headers = parsed[0] ?? [];
        setData({ headers, rows: parsed.slice(1, 1 + MAX_ROWS), total: res.total, partial: res.partial, count: parsed.length - 1 });
      }
    }).catch((e) => { if (!cancelled) setError(String(e.message ?? e)); });
    return () => { cancelled = true; };
  }, [item.cap, item.rev]);

  const visible = useMemo(() => {
    if (!data) return [];
    let rows = data.rows.map((cells, i) => ({ i, cells }));
    if (query) {
      const q = query.toLowerCase();
      rows = rows.filter((r) => r.cells.some((c) => c.toLowerCase().includes(q)));
    }
    if (sort) {
      const { col, asc } = sort;
      rows = rows.slice().sort((a, b) => {
        const av = a.cells[col] ?? '';
        const bv = b.cells[col] ?? '';
        const an = parseFloat(av);
        const bn = parseFloat(bv);
        const cmp = !Number.isNaN(an) && !Number.isNaN(bn) ? an - bn : av.localeCompare(bv);
        return asc ? cmp : -cmp;
      });
    }
    return rows;
  }, [data, query, sort]);

  if (error) return <div className="viewer-empty viewer-error">{error}</div>;
  if (!data) return <div className="viewer-empty">loading…</div>;
  if (data.headers.length === 0) return <div className="viewer-empty">empty file</div>;

  const note = data.partial
    ? `preview — first ${data.rows.length.toLocaleString()} rows of ${humanSize(data.total)}`
    : data.count > MAX_ROWS
      ? `first ${MAX_ROWS.toLocaleString()} of ${data.count.toLocaleString()} rows`
      : `${data.count.toLocaleString()} rows · ${humanSize(data.total)}`;

  return (
    <div className="viewer-scroll" ref={scrollRef}>
      <div className="viewer-note">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="filter" />
        <span>{query ? `${visible.length} / ${data.rows.length}` : note}</span>
      </div>
      <table className="viewer-table">
        <thead>
          <tr>
            <th className="rn">#</th>
            {data.headers.map((h, col) => (
              <th key={col} onClick={() => setSort((s) => (s && s.col === col ? { col, asc: !s.asc } : { col, asc: true }))}>
                {h}<span className="arrow">{sort?.col === col ? (sort.asc ? '▲' : '▼') : '▽'}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((r, n) => (
            <tr key={r.i}>
              <td className="rn">{n + 1}</td>
              {data.headers.map((_, col) => <td key={col} title={r.cells[col]}>{r.cells[col] ?? ''}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
