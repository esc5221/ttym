import { miniLinkBtnStyle } from '../app-shared.js';
import { useFullscreen } from '../fullscreen.js';

/**
 * What a phone pane's header used to spread over a dozen buttons, in one panel: back to the list,
 * the neighbouring panes, reader and input-area switches, terminal search, immersive and full screen.
 * The header opens it under a `⋯`; in immersive mode the corner button opens the same panel.
 */
export function PaneMenu({ label, position, onBack, onPrev, onNext, reader, onToggleReader, dock, onToggleDock, onFind, immersive, onToggleImmersive, onClose }: {
  label: string;
  /** "2/5" */
  position: string;
  onBack: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  /** null when this pane has no reader (a shell, a file tab). */
  reader: boolean | null;
  onToggleReader: () => void;
  /** Only while reader mode is on. */
  dock: 'native' | 'styled' | null;
  onToggleDock: () => void;
  onFind: () => void;
  immersive: boolean;
  onToggleImmersive: () => void;
  onClose: () => void;
}) {
  const full = useFullscreen();
  const act = (fn: () => void) => () => { onClose(); fn(); };
  return (
    <div style={panelStyle}>
      <div style={labelStyle}>{label}</div>
      <div style={rowStyle}>
        <button onClick={act(onBack)} style={itemStyle}>‹ list</button>
        <button onClick={act(() => onPrev?.())} disabled={!onPrev} style={{ ...itemStyle, opacity: onPrev ? 1 : 0.3 }}>‹</button>
        <span style={{ color: 'var(--text-dim)', fontSize: 11, fontFamily: 'var(--mono)', alignSelf: 'center' }}>{position}</span>
        <button onClick={act(() => onNext?.())} disabled={!onNext} style={{ ...itemStyle, opacity: onNext ? 1 : 0.3 }}>›</button>
      </div>
      {reader !== null ? (
        <div style={rowStyle}>
          <button onClick={act(onToggleReader)} style={{ ...itemStyle, ...(reader ? { color: 'var(--accent)' } : null) }}>reader</button>
          {reader && dock ? <button onClick={act(onToggleDock)} style={itemStyle}>{dock}</button> : null}
        </div>
      ) : null}
      <div style={rowStyle}>
        <button onClick={act(onFind)} style={itemStyle}>find</button>
        <button onClick={act(onToggleImmersive)} style={{ ...itemStyle, ...(immersive ? { color: 'var(--accent)' } : null) }}>{immersive ? 'exit immersive' : 'immersive'}</button>
        {full.supported ? <button onClick={act(full.toggle)} style={{ ...itemStyle, ...(full.on ? { color: 'var(--accent)' } : null) }}>{full.on ? 'exit full screen' : 'full screen'}</button> : null}
      </div>
      {full.supported ? null : <div style={hintStyle}>Full screen on iPhone: Share → Add to Home Screen, then open it from there.</div>}
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  padding: 6, borderRadius: 10, border: '1px solid var(--line-strong)', background: 'var(--bg1)',
  boxShadow: '0 8px 24px rgba(0,0,0,.4)', display: 'flex', flexDirection: 'column', gap: 4, minWidth: 190, maxWidth: 'calc(100vw - 16px)',
};
const labelStyle: React.CSSProperties = { color: 'var(--text-soft)', fontSize: 11, fontFamily: 'var(--mono)', padding: '2px 6px 6px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const rowStyle: React.CSSProperties = { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' };
const hintStyle: React.CSSProperties = { color: 'var(--text-dim)', fontSize: 10, lineHeight: 1.4, padding: '2px 6px', maxWidth: 230 };
const itemStyle: React.CSSProperties = {
  ...miniLinkBtnStyle, flex: '0 0 auto', padding: '8px 10px', fontSize: 12, minHeight: 36,
  border: '1px solid var(--line)', borderRadius: 6,
};
