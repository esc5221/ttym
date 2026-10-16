import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getHost } from '@ttym/ui';
import type { ReaderPatch } from '@ttym/api';
import '../viewer/viewer.css';
import './reader.css';
import { cachedMarkdown, renderMarkdown } from './markdown.js';
import { currentTheme, hydrateMermaid } from './mermaid.js';
import { attachSummaries, formatDuration, groupRuns, pendingMessages, turnStartedAt, type Block, type ReaderState } from './model.js';
import { Linkified, refLinkHandlers } from './ref-links.js';
import { StyledDock } from './StyledDock.js';
import type { DockLayout } from './useDockLayout.js';

/** How the input area at the bottom is drawn: the terminal's own rows, or a styled copy of them. */
export type DockMode = 'native' | 'styled';

/**
 * The conversation, laid over the top of the real terminal.
 *
 * It only draws what `ReaderState` holds. Everything below the page (the prompt
 * and the permission dialog) is the terminal itself showing through, so typing
 * and answering a prompt need nothing from this file.
 */
export function ReaderView({ sid, state, error, working, layout, dockMode, columnMax, flow = false, onLoadEarlier, loadingEarlier = false, fontSize, topInset, paneProps }: {
  sid: number;
  state: ReaderState;
  error: string | null;
  /** The agent is mid-turn (from its own hooks), which the transcript alone can't say. */
  working: boolean;
  layout: DockLayout | null;
  dockMode: DockMode;
  /** Widest the reading column may be, in px; a pane can be far wider than a line is comfortable to read. */
  columnMax?: number;
  /** With the styled dock: draw it as the last thing on the page, scrolling with the conversation, instead of pinned to the bottom. */
  flow?: boolean;
  /** Fetch the page of history above what is shown (see `state.earlier`). */
  onLoadEarlier?: () => void;
  loadingEarlier?: boolean;
  /** The terminal's font size in px; the page's text scales with it. */
  fontSize?: number;
  /** Space to keep clear above the first line (px), for something floating over the top of the page. */
  topInset?: number;
  /** What the pane does with the pointer apart from reading (dropped files, selecting a path); the page carries it so it works over the text too. */
  paneProps?: React.HTMLAttributes<HTMLDivElement>;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [behind, setBehind] = useState(false);

  // Loading history puts blocks above the ones being read; the scroll position is carried over so the same line stays put.
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const requestEarlier = () => {
    const el = scroller.current;
    if (!el || !onLoadEarlier || state.earlier === null || loadingEarlier) return;
    anchor.current = { height: el.scrollHeight, top: el.scrollTop };
    onLoadEarlier();
  };
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setBehind(!stuck.current);
    if (el.scrollTop < 300) requestEarlier();
  };
  const toLatest = () => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    stuck.current = true;
    setBehind(false);
  };
  // A styled dock that flows with the page ends it, and changes height as someone types or a dialog appears.
  const styledView = dockMode === 'styled' ? layout?.view ?? null : null;
  const flowView = flow ? styledView : null;
  const pinnedView = flow ? null : styledView;
  const flowSignature = flowView ? JSON.stringify(flowView) : '';
  const firstId = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    const first = state.blocks[0]?.id ?? null;
    const prepended = anchor.current !== null && firstId.current !== null && first !== firstId.current
      && state.blocks.some((b) => b.id === firstId.current);
    firstId.current = first;
    if (prepended && el && anchor.current) {
      el.scrollTop = anchor.current.top + (el.scrollHeight - anchor.current.height);
      anchor.current = null;
      stuck.current = false;
      return;
    }
    // Follow new content only while the reader is already at the bottom.
    if (stuck.current) toLatest();
  }, [state.blocks, working, layout?.bottomPx, flowSignature]);
  // A conversation too short to scroll has no way to reach its history by scrolling.
  useEffect(() => {
    const el = scroller.current;
    if (el && state.earlier !== null && state.blocks.length > 0 && el.scrollHeight <= el.clientHeight) requestEarlier();
  }, [state.blocks.length, state.earlier, layout?.bottomPx]);
  // Typing goes to the terminal; a dock scrolled out of sight must come back so what is typed can be seen.
  useEffect(() => {
    if (!flowView) return;
    const sub = getHost(sid)?.term.onData(() => { if (!stuck.current) toLatest(); });
    return () => sub?.dispose();
  }, [sid, flowView !== null]);

  // A click that selects nothing hands the keyboard back to the terminal, so typing never needs a click on the dock.
  const refocus = () => {
    // On a touch screen a tap would raise the keyboard every time someone touches the text to scroll.
    if (window.matchMedia('(pointer: coarse)').matches) return;
    if (window.getSelection()?.isCollapsed !== false) getHost(sid)?.focusTerminal();
  };

  // A pinned styled dock stands on top of the terminal rows it copies, so it must be at least as tall as they are.
  const view = pinnedView;
  const dockEl = useRef<HTMLDivElement>(null);
  const [dockH, setDockH] = useState(0);
  useEffect(() => {
    const el = dockEl.current;
    if (!el) { setDockH(0); return; }
    const ro = new ResizeObserver(() => setDockH(el.offsetHeight));
    ro.observe(el);
    setDockH(el.offsetHeight);
    return () => ro.disconnect();
  }, [view !== null]);
  // A flowing dock lives inside the page, so the page covers the terminal's input rows too.
  const bottom = layout ? (flowView ? 0 : view ? Math.max(layout.insetPx + dockH, layout.bottomPx) : layout.bottomPx) : 0;

  // The caption names what the bottom rows are; it shows while the pointer is near them.
  const root = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const stage = root.current?.parentElement;
    if (!stage) return;
    const move = (e: PointerEvent) => {
      const r = root.current?.getBoundingClientRect();
      setNear(!!r && e.clientY > r.bottom - 28);
    };
    const leave = () => setNear(false);
    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerleave', leave);
    return () => { stage.removeEventListener('pointermove', move); stage.removeEventListener('pointerleave', leave); };
  }, []);

  const queued = pendingMessages(state);
  const colW = layout ? Math.min(layout.widthPx, columnMax ?? Infinity) : 0;
  const cssVars = layout
    ? ({
        ['--rd-w' as string]: `${colW}px`,
        // Measured from the terminal's own left edge, so text, tool rows and the input rows start at the same x.
        ['--rd-left' as string]: `${layout.leftPx}px`,
        ...(fontSize ? { ['--rd-fs' as string]: `${fontSize + 1}px`, ['--rd-term-fs' as string]: `${fontSize}px` } : null),
        ...(topInset ? { ['--rd-top' as string]: `${topInset}px` } : null),
      } as React.CSSProperties)
    : null;
  const style = layout ? { bottom, ...cssVars } : ({ visibility: 'hidden' } as React.CSSProperties);

  return (
    <>
    <div className="rd-root" style={style} ref={root} {...paneProps}>
      <div className="rd-scroll" ref={scroller} onScroll={onScroll} onMouseUp={refocus} {...refLinkHandlers}>
        <div className={`rd-col${flowView ? ' rd-flow' : ''}`}>
          {state.earlier !== null && state.blocks.length > 0 ? (
            <button className="rd-earlier" onClick={requestEarlier} disabled={loadingEarlier}>{loadingEarlier ? 'Loading earlier messages…' : 'Load earlier messages'}</button>
          ) : null}
          <Body state={state} error={error} />
          {queued.map((text, i) => <div key={`q${i}`} className="rd-user rd-queued"><div className="rd-bubble">{text}</div></div>)}
          {working ? <Working since={turnStartedAt(state)} /> : null}
          {flowView ? <div className="rd-flow-dock"><StyledDock sid={sid} view={flowView} /></div> : null}
        </div>
      </div>
      {behind ? <button className="rd-jump" onClick={() => { toLatest(); getHost(sid)?.focusTerminal(); }}>↓ latest</button> : null}
      <div className={`rd-hint${near && !flowView ? ' near' : ''}`}>
        {view ? 'styled copy · typing goes to the terminal underneath' : `live terminal · last ${layout?.rows ?? 0} rows · PTY size unchanged`}
      </div>
    </div>
    {view && layout ? (
      <div className="rd-dock" ref={dockEl} style={{ bottom: layout.insetPx, minHeight: layout.bottomPx - layout.insetPx, ...cssVars }}>
        <StyledDock sid={sid} view={view} />
      </div>
    ) : null}
    </>
  );
}

function Body({ state, error }: { state: ReaderState; error: string | null }) {
  const narrow = useNarrow();
  if (state.supported === false) {
    return <div className="rd-empty">Reader mode isn’t available for this pane’s program yet. Switch back to the terminal.</div>;
  }
  if (state.supported === null) return <div className="rd-empty">{error ? `Can’t load the conversation: ${error}` : 'Loading…'}</div>;
  if (state.blocks.length === 0) return <div className="rd-empty">No conversation yet. Send a message below.</div>;
  return (
    <>
      {error ? <div className="rd-notice">Can’t refresh: {error}</div> : null}
      {groupRuns(attachSummaries(state.blocks), narrow).map((g) => Array.isArray(g)
        ? <ToolGroup key={g[0].id} tools={g} />
        : <BlockView key={g.id} block={g} />)}
    </>
  );
}

function BlockView({ block: b }: { block: Block }) {
  switch (b.kind) {
    case 'user':
      return (
        <div className="rd-user" title={new Date(b.at).toLocaleString()}>
          <div className="rd-bubble"><Linkified text={b.text} />{b.images ? <span className="rd-dim"> · {b.images} image{b.images > 1 ? 's' : ''}</span> : null}</div>
        </div>
      );
    case 'text': return <Markdown text={b.text} />;
    case 'thinking':
      return <details className="rd-think"><summary>Thinking</summary><div className="rd-think-body">{b.text}</div></details>;
    case 'notice': return <div className="rd-notice">{b.text}</div>;
    case 'boundary': return <Compaction label={b.label} summary={b.summary} />;
    case 'summary': return <Compaction label="Conversation compacted" summary={b.text} />;
    case 'tool': return <ToolRow tool={b} />;
    case 'turn-end': {
      const parts = [`Worked for ${formatDuration(b.durationMs)}`];
      if (b.tools) parts.push(`${b.tools} tool${b.tools > 1 ? 's' : ''}`);
      if (b.edited.length) parts.push(`edited ${b.edited.map(baseName).join(', ')}`);
      return <div className="rd-turn-end">{parts.join(' · ')}</div>;
    }
  }
}

/** The line where the conversation was compacted. Its summary is long and for the agent, so it stays shut until asked for. */
function Compaction({ label, summary }: { label: string; summary?: string }) {
  const [open, setOpen] = useState(false);
  if (!summary) return <div className="rd-boundary"><span>{label}</span></div>;
  return (
    <details className="rd-compact" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="rd-boundary"><span>{label} · summary {open ? '▾' : '▸'}</span></summary>
      {open ? <div className="rd-compact-body"><Markdown text={summary} /></div> : null}
    </details>
  );
}

const baseName = (path: string) => path.split('/').pop() || path;

/** The page's colour scheme (the `data-theme` on the root), so what was drawn in one is drawn again in the other. */
function useThemeName(): 'light' | 'dark' {
  return useSyncExternalStore((notify) => {
    const mo = new MutationObserver(notify);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, currentTheme);
}

function Markdown({ text }: { text: string }) {
  const [html, setHtml] = useState<string | undefined>(() => cachedMarkdown(text));
  useEffect(() => {
    let live = true;
    if (html === undefined) renderMarkdown(text).then((h) => { if (live) setHtml(h); }, () => {});
    return () => { live = false; };
  }, [text, html]);
  const box = useRef<HTMLDivElement>(null);
  const theme = useThemeName();
  useEffect(() => (html !== undefined && box.current ? hydrateMermaid(box.current) : undefined), [html, theme]);
  if (html === undefined) return <div className="rd-md rd-plain">{text}</div>;
  return <div className="rd-md" ref={box} dangerouslySetInnerHTML={{ __html: html }} />;
}

type ToolBlock = Extract<Block, { kind: 'tool' }>;

const NARROW_QUERY = '(max-width: 640px)';

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

function ToolGroup({ tools }: { tools: ToolBlock[] }) {
  const [pick, setPick] = useState<boolean | null>(null);
  const live = tools.some((t) => t.status === 'running' || t.status === 'error');
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  const summary = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(', ');
  const status = tools.some((t) => t.status === 'error') ? 'error' : tools.some((t) => t.status === 'running') ? 'running' : 'ok';
  return (
    <details className={`rd-tool rd-group rd-${status}`} open={pick ?? live} onToggle={(e) => {
      const o = (e.currentTarget as HTMLDetailsElement).open;
      if (o !== (pick ?? live)) setPick(o);
    }}>
      <summary>
        <span className="rd-dot" aria-label={status} />
        <span className="rd-tool-name">{tools.length} tool calls</span>
        <span className="rd-tool-target">{summary}</span>
      </summary>
      <div className="rd-group-body">{tools.map((t) => <ToolRow key={t.id} tool={t} />)}</div>
    </details>
  );
}

function ToolRow({ tool: t }: { tool: ToolBlock }) {
  const hasBody = !!t.patch || !!t.output || !!t.input;
  // An edit that went through is its diff; its "file updated" output says nothing more.
  const showOutput = !!t.output && !(t.patch && t.status === 'ok');
  const took = t.endedAt && t.at ? formatDuration(t.endedAt - t.at) : null;
  return (
    <details className={`rd-tool rd-${t.status}`} open={!!t.patch || t.status === 'error'}>
      <summary>
        <span className="rd-dot" aria-label={t.status} />
        <span className="rd-tool-name">{t.name}</span>
        <span className="rd-tool-target">{t.target}</span>
        {took && t.status !== 'running' ? <span className="rd-dim">{took}</span> : null}
      </summary>
      {hasBody ? (
        <div className="rd-tool-body">
          {t.patch ? <Diff patch={t.patch} /> : t.input ? <pre className="rd-pre">{t.input}</pre> : null}
          {showOutput ? <pre className={`rd-pre rd-out${t.status === 'error' ? ' rd-err' : ''}`}>{t.output}{t.truncated ? '\n… (truncated)' : ''}</pre> : null}
        </div>
      ) : null}
    </details>
  );
}

function Diff({ patch }: { patch: ReaderPatch }) {
  return (
    <div className="rd-diff">
      <div className="rd-diff-file">{patch.file}</div>
      {patch.hunks.map((h, i) => (
        <div key={i}>
          {h.header ? <div className="rd-diff-hunk">{h.header}</div> : null}
          {h.lines.map((l, j) => (
            <div key={j} className={l.op === '+' ? 'rd-add' : l.op === '-' ? 'rd-del' : 'rd-ctx'}>
              <span className="rd-sign">{l.op === ' ' ? '' : l.op}</span>{l.text || ' '}
            </div>
          ))}
        </div>
      ))}
      {patch.truncated ? <div className="rd-diff-hunk">… (truncated)</div> : null}
    </div>
  );
}

function Working({ since }: { since: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <div className="rd-working"><span className="rd-pulse" />Working…{since ? ` ${formatDuration(Math.max(0, now - since))}` : ''}</div>;
}
