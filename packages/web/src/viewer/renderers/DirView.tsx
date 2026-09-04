import { useScrollMemory } from '../useScrollMemory.js';
import { useEffect, useState } from 'react';
import type { ViewItem } from '@ttym/api';
import { humanSize, viewUrl } from '../content.js';

interface Listing { path: string; entries: Array<{ n: string; d: boolean; s: number; m: number }>; truncated: boolean }

/**
 * A directory tab. Browsing stays inside the tab's tree; clicking a file
 * opens it as a tab of its own through the server — the same path every
 * open takes, with the same scope rules, so a file reached from here is no
 * different from one named on the command line.
 */
export function DirView({ item, onOpen }: { item: ViewItem; onOpen: (targets: string[]) => void }) {
  const scrollRef = useScrollMemory(item.cap ?? item.id);
  const [path, setPath] = useState('');
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setListing(null);
    fetch(viewUrl(item, path) + (path ? '/' : '')).then(async (res) => {
      if (!res.ok) throw new Error(res.status === 403 ? 'denied' : `HTTP ${res.status}`);
      const type = res.headers.get('content-type') ?? '';
      if (!type.includes('application/json')) throw new Error('this folder is a site — open it as a tab');
      return res.json() as Promise<Listing>;
    }).then((data) => { if (!cancelled) setListing(data); })
      .catch((e) => { if (!cancelled) setError(String(e.message ?? e)); });
    return () => { cancelled = true; };
  }, [item.cap, item.rev, path]);

  const crumbs = path.split('/').filter(Boolean);
  const go = (depth: number) => setPath(crumbs.slice(0, depth).join('/'));

  if (error) return <div className="viewer-empty viewer-error">{error}</div>;
  return (
    <div className="viewer-scroll viewer-dir" ref={scrollRef}>
      <div className="viewer-dir-crumb">
        <a onClick={() => go(0)}>{item.name}</a>
        {crumbs.map((c, i) => <span key={i}> / <a onClick={() => go(i + 1)}>{c}</a></span>)}
        {listing?.truncated ? <span> · showing the first {listing.entries.length} entries</span> : null}
      </div>
      {!listing ? <div className="viewer-empty">loading…</div> : listing.entries.length === 0 ? <div className="viewer-empty">empty</div> : (
        <table>
          <tbody>
            {listing.entries.map((e) => {
              const rel = path ? `${path}/${e.n}` : e.n;
              return (
                <tr key={e.n}>
                  <td
                    className={`name${e.d ? ' dir' : ''}`}
                    onClick={() => (e.d ? setPath(rel) : onOpen([`${item.target}/${rel}`]))}
                    title={e.d ? 'browse' : 'open as a tab'}
                  >{e.d ? '▸ ' : ''}{e.n}</td>
                  <td className="size">{e.d ? '' : humanSize(e.s)}</td>
                  <td className="date">{formatDate(e.m)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function formatDate(sec: number): string {
  const d = new Date(sec * 1000);
  const z = (x: number) => (x < 10 ? '0' : '') + x;
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
}
