import { useEffect, useRef, useState } from 'react';
import { READER_COLUMN_PX } from '../app-shared.js';
import { ReaderView, type DockMode } from '../reader/ReaderView.js';
import { usePaneDock, usePaneReader } from '../reader/paneReader.js';
import { useReader } from '../reader/useReader.js';
import { SessionBody, type SessionBodyProps } from './SessionBody.js';
import { paneView, useWorkspaceSessions } from './session-context.js';

/** A pane is only narrowed to the reading column when it has at least this much room (px) on each side of it. */
const NARROW_MARGIN_PX = 24;

/** Whether a grid pane can show reader mode at all: an agent that has a reader, on its terminal tab, on a pointer device. */
export function paneReaderAvailable(agentKind: string | null | undefined, dead: boolean, touch: boolean): boolean {
  return agentKind === 'claude-code' && !dead && !touch;
}

/**
 * A grid pane's body: the session, and over it the conversation when this pane
 * is switched to reader mode. The header owns the switch; this only reads it.
 */
export function PaneBody(props: SessionBodyProps) {
  const { sid } = props;
  const ctx = useWorkspaceSessions();
  const agent = ctx.agentStates[sid];
  const view = paneView(ctx, sid);
  const on = usePaneReader(sid) && paneReaderAvailable(agent?.kind, ctx.deadSessions.has(sid), ctx.touch) && view.item === null;
  const stageRef = useRef<HTMLDivElement>(null);
  const { transcript, dock, working } = useReader(sid, agent, stageRef, on);
  const chosen = usePaneDock();
  const dockMode: DockMode = chosen ?? 'native';

  // A pane wider than the reading column would leave the terminal's input rows wider than the text above them. The pane then
  // borrows a PTY width that matches the column (as Zen does), the terminal sits in the middle, and the original size comes back
  // when reader mode is turned off.
  const [stageWidth, setStageWidth] = useState(0);
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !on) return;
    const ro = new ResizeObserver(() => setStageWidth(el.clientWidth));
    ro.observe(el);
    setStageWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [on]);
  const narrowed = on && stageWidth > READER_COLUMN_PX + 2 * NARROW_MARGIN_PX;
  const fixedCols = narrowed ? Math.max(40, Math.floor(READER_COLUMN_PX / (dock?.cellW ?? props.terminal.fontSize * 0.6))) : undefined;
  const bodyProps: SessionBodyProps = narrowed
    ? {
        ...props,
        terminal: { ...props.terminal, geometry: 'borrow', fixedCols, style: { width: 'max-content', height: '100%' } },
        wrapStyle: { ...props.wrapStyle, display: 'flex', justifyContent: 'center' },
      }
    : props;

  return (
    <div ref={stageRef} style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <SessionBody {...bodyProps} />
      {on ? <ReaderView sid={sid} state={transcript.state} error={transcript.error} working={working} layout={dock} dockMode={dockMode} columnMax={READER_COLUMN_PX} fontSize={props.terminal.fontSize} onLoadEarlier={transcript.loadEarlier} loadingEarlier={transcript.loadingEarlier} /> : null}
    </div>
  );
}
