import { useCallback, useState } from 'react';
import type { ViewItem, ViewerState } from '@ttym/api';
import { ViewerTabs, viewerBtnStyle } from './ViewerTabs.js';
import { FrameView } from './renderers/FrameView.js';
import { MarkdownView } from './renderers/MarkdownView.js';
import { TableView } from './renderers/TableView.js';
import { JsonView } from './renderers/JsonView.js';
import { CodeView } from './renderers/CodeView.js';
import { ImageView } from './renderers/ImageView.js';
import { DirView } from './renderers/DirView.js';
import { viewSrc } from './content.js';
import './viewer.css';

/**
 * One session's viewer: its tabs and the active tab's content. The same
 * component draws the pane-mode strip and the full-mode overlay; only the
 * chrome around it differs.
 *
 * Only the active tab is mounted. Ten tabs of three.js in one pane would
 * otherwise all be running.
 */
export function ViewerPanel({ sid, state, activeId, onSelect, onClose, onCloseAll, onOpen, onFull, onPane, mode, chrome = 'tabs', reloadKey = 0, jump }: {
  sid: number;
  state: ViewerState;
  activeId: string | null;
  onSelect: (vid: string) => void;
  onClose: (vid: string) => void;
  onCloseAll: () => void;
  /** Open more targets in this session — a directory listing does this on click. */
  onOpen: (targets: string[]) => void;
  onFull?: (vid: string) => void;
  onPane?: () => void;
  mode: 'pane' | 'full';
  /** 'none': the host draws the tabs (the pane header does), this is body only. */
  chrome?: 'tabs' | 'none';
  /** Bumped by the host to remount the active view. */
  reloadKey?: number;
  /** Land on this line when the active tab is the one it names (from `a.ts:12` selections). */
  jump?: { vid: string; line: number; col?: number; nonce: number };
}) {
  const items = state.items;
  const item = items.find((i) => i.id === activeId) ?? items[items.length - 1] ?? null;
  // Remounting the active view is the reload — the key carries the rev.
  const [reloadNonce, setReloadNonce] = useState(0);
  const reload = useCallback(() => setReloadNonce((n) => n + 1), []);

  const trailing = (
    <>
      {mode === 'pane' && onFull && item ? <button style={viewerBtnStyle} onClick={() => onFull(item.id)} title="fill the workspace · ⌘.">full</button> : null}
      {mode === 'full' && onPane ? <button style={viewerBtnStyle} onClick={onPane} title="back to the pane · ⌘.">pane</button> : null}
      <button style={viewerBtnStyle} onClick={reload} title="reload">⟳</button>
      {item ? <a style={viewerBtnStyle} href={viewSrc(item)} target="_blank" rel="noreferrer" title="open in a browser tab">↗</a> : null}
      <button style={viewerBtnStyle} onClick={onCloseAll} title="close all tabs">×</button>
    </>
  );

  return (
    <div className="viewer-panel" data-viewer-sid={sid}>
      {chrome === 'tabs' ? <ViewerTabs items={items} activeId={item?.id ?? null} onSelect={onSelect} onClose={onClose} trailing={trailing} /> : null}
      <div className="viewer-body">
        {item ? <ViewBody key={`${item.id}:${item.rev}:${reloadNonce}:${reloadKey}`} item={item} onOpen={onOpen} jump={jump && jump.vid === item.id ? jump : undefined} /> : null}
      </div>
    </div>
  );
}

function ViewBody({ item, onOpen, jump }: { item: ViewItem; onOpen: (targets: string[]) => void; jump?: { line: number; col?: number; nonce: number } }) {
  switch (item.renderer) {
    case 'frame': return <FrameView item={item} />;
    case 'markdown': return <MarkdownView item={item} />;
    case 'table': return <TableView item={item} />;
    case 'json': return <JsonView item={item} />;
    case 'code': return <CodeView item={item} jump={jump} />;
    case 'image': return <ImageView item={item} />;
    case 'dir': return <DirView item={item} onOpen={onOpen} />;
  }
}
