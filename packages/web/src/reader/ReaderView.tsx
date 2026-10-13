import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getHost } from '@ttym/ui';
import type { ReaderPatch } from '@ttym/api';
import '../viewer/viewer.css';
import './reader.css';
import { cachedMarkdown, renderMarkdown } from './markdown.js';
import { formatDuration, pendingMessages, turnStartedAt, type Block, type ReaderState } from './model.js';
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
export function ReaderView({ sid, state, error, working, layout, dockMode }: {
  sid: number;
  state: ReaderState;
  error: string | null;
  /** The agent is mid-turn (from its own hooks), which the transcript alone can't say. */
  working: boolean;
  layout: DockLayout | null;
  dockMode: DockMode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [behind, setBehind] = useState(false);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setBehind(!stuck.current);
  };
  const toLatest = () => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    stuck.current = true;
    setBehind(false);
  };
  // Follow new content only while the reader is already at the bottom.
  useLayoutEffect(() => { if (stuck.current) toLatest(); }, [state.blocks, working, layout?.bottomPx]);

  // A click that selects nothing hands the keyboard back to the terminal, so typing never needs a click on the dock.
  const refocus = () => {
    // On a touch screen a tap would raise the keyboard every time someone touches the text to scroll.
    if (window.matchMedia('(pointer: coarse)').matches) return;
    if (window.getSelection()?.isCollapsed !== false) getHost(sid)?.focusTerminal();
  };

  // A styled dock stands on top of the terminal rows it copies, so it must be at least as tall as they are.
  const view = dockMode === 'styled' ? layout?.view ?? null : null;
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
  const bottom = layout ? (view ? Math.max(layout.insetPx + dockH, layout.bottomPx) : layout.bottomPx) : 0;

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
  const cssVars = layout ? ({ ['--rd-w' as string]: `${layout.widthPx}px` } as React.CSSProperties) : null;
  const style = layout ? { bottom, ...cssVars } : ({ visibility: 'hidden' } as React.CSSProperties);

  return (
    <>
    <div className="rd-root" style={style} ref={root}>
      <div className="rd-scroll" ref={scroller} onScroll={onScroll} onMouseUp={refocus}>
        <div className="rd-col">
          <Body state={state} error={error} />
          {queued.map((text, i) => <div key={`q${i}`} className="rd-user rd-queued"><div className="rd-bubble">{text}</div></div>)}
          {working ? <Working since={turnStartedAt(state)} /> : null}
        </div>
      </div>
      {behind ? <button className="rd-jump" onClick={() => { toLatest(); getHost(sid)?.focusTerminal(); }}>↓ latest</button> : null}
      <div className={`rd-hint${near ? ' near' : ''}`}>
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
  if (state.supported === false) {
    return <div className="rd-empty">Reader mode isn’t available for this pane’s program yet. Switch back to the terminal.</div>;
  }
  if (state.supported === null) return <div className="rd-empty">{error ? `Can’t load the conversation: ${error}` : 'Loading…'}</div>;
  if (state.blocks.length === 0) return <div className="rd-empty">No conversation yet. Send a message below.</div>;
  return (
    <>
      {error ? <div className="rd-notice">Can’t refresh: {error}</div> : null}
      {state.blocks.map((b) => <BlockView key={b.id} block={b} />)}
    </>
  );
}

function BlockView({ block: b }: { block: Block }) {
  switch (b.kind) {
    case 'user':
      return (
        <div className="rd-user" title={new Date(b.at).toLocaleString()}>
          <div className="rd-bubble">{b.text}{b.images ? <span className="rd-dim"> · {b.images} image{b.images > 1 ? 's' : ''}</span> : null}</div>
        </div>
      );
    case 'text': return <Markdown text={b.text} />;
    case 'thinking':
      return <details className="rd-think"><summary>Thinking</summary><div className="rd-think-body">{b.text}</div></details>;
    case 'notice': return <div className="rd-notice">{b.text}</div>;
    case 'boundary': return <div className="rd-boundary"><span>{b.label}</span></div>;
    case 'tool': return <ToolRow tool={b} />;
    case 'turn-end': {
      const parts = [`Worked for ${formatDuration(b.durationMs)}`];
      if (b.tools) parts.push(`${b.tools} tool${b.tools > 1 ? 's' : ''}`);
      if (b.edited.length) parts.push(`edited ${b.edited.map(baseName).join(', ')}`);
      return <div className="rd-turn-end">{parts.join(' · ')}</div>;
    }
  }
}

const baseName = (path: string) => path.split('/').pop() || path;

function Markdown({ text }: { text: string }) {
  const [html, setHtml] = useState<string | undefined>(() => cachedMarkdown(text));
  useEffect(() => {
    let live = true;
    if (html === undefined) renderMarkdown(text).then((h) => { if (live) setHtml(h); }, () => {});
    return () => { live = false; };
  }, [text, html]);
  if (html === undefined) return <div className="rd-md rd-plain">{text}</div>;
  return <div className="rd-md" dangerouslySetInnerHTML={{ __html: html }} />;
}

type ToolBlock = Extract<Block, { kind: 'tool' }>;

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
