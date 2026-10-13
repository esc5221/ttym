import { useEffect, useState } from 'react';
import { miniLinkBtnStyle } from '../app-shared.js';

/**
 * What is left of the header while a phone pane has the whole screen: one small button in the
 * top-left corner that opens the few things the header held (back to the list, the neighbouring
 * panes, reader/input-area switches) and the way out of immersive mode.
 */
export function ImmersiveChip({ label, position, onBack, onPrev, onNext, reader, onToggleReader, dock, onToggleDock, onExit }: {
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
  onExit: () => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!(e.target as HTMLElement | null)?.closest('[data-immersive-chip]')) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  const act = (fn: () => void) => () => { setOpen(false); fn(); };

  return (
    <div data-immersive-chip style={chipRootStyle}>
      <button onClick={() => setOpen((v) => !v)} style={{ ...chipBtnStyle, opacity: open ? 1 : 0.55 }} aria-label="pane menu">{open ? '✕' : '⋯'}</button>
      {open ? (
        <div style={panelStyle}>
          <div style={{ color: 'var(--text-soft)', fontSize: 11, fontFamily: 'var(--mono)', padding: '2px 6px 6px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 220 }}>{label}</div>
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
            <button onClick={act(onExit)} style={itemStyle}>exit immersive</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// top comes from the safe area so the notch never covers it; z-index above the terminal and the reader page
const chipRootStyle: React.CSSProperties = {
  position: 'fixed', top: 'calc(env(safe-area-inset-top, 0px) + 6px)', left: 8, zIndex: 40,
};

const chipBtnStyle: React.CSSProperties = {
  width: 28, height: 28, borderRadius: 14, border: '1px solid var(--line-strong)',
  background: 'color-mix(in srgb, var(--bg1) 80%, transparent)', color: 'var(--text)',
  fontSize: 14, lineHeight: '24px', padding: 0, cursor: 'pointer', backdropFilter: 'blur(6px)',
};

const panelStyle: React.CSSProperties = {
  marginTop: 6, padding: 6, borderRadius: 10, border: '1px solid var(--line-strong)', background: 'var(--bg1)',
  boxShadow: '0 8px 24px rgba(0,0,0,.4)', display: 'flex', flexDirection: 'column', gap: 4, minWidth: 180,
};

const rowStyle: React.CSSProperties = { display: 'flex', gap: 6, alignItems: 'center' };

const itemStyle: React.CSSProperties = {
  ...miniLinkBtnStyle, flex: '0 0 auto', padding: '8px 10px', fontSize: 12, minHeight: 36,
  border: '1px solid var(--line)', borderRadius: 6,
};
