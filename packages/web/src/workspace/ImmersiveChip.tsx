import { useEffect, useState } from 'react';
import { useFullscreen } from '../fullscreen.js';
import { PaneMenu } from './PaneMenu.js';

/**
 * What is left of the header while a phone pane has the whole screen: a small button in the top-left
 * corner that opens the pane menu, and, where the browser allows it, one in the top-right for full screen.
 */
export function ImmersiveChip(props: Omit<React.ComponentProps<typeof PaneMenu>, 'immersive' | 'onToggleImmersive' | 'onClose'> & { onExit: () => void }) {
  const [open, setOpen] = useState(false);
  const full = useFullscreen();
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!(e.target as HTMLElement | null)?.closest('[data-immersive-chip]')) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const { onExit, ...menu } = props;
  return (
    <>
      <div data-immersive-chip style={{ ...cornerStyle, left: 8 }}>
        <button onClick={() => setOpen((v) => !v)} style={{ ...chipBtnStyle, opacity: open ? 1 : 0.55 }} aria-label="pane menu">{open ? '✕' : '⋯'}</button>
        {open ? <div style={{ marginTop: 6 }}><PaneMenu {...menu} immersive onToggleImmersive={onExit} onClose={() => setOpen(false)} /></div> : null}
      </div>
      {full.supported ? (
        <div style={{ ...cornerStyle, right: 8 }}>
          <button onClick={full.toggle} style={{ ...chipBtnStyle, opacity: 0.55 }} aria-label={full.on ? 'exit full screen' : 'full screen'} title={full.on ? 'exit full screen' : 'full screen'}>{full.on ? '⤡' : '⛶'}</button>
        </div>
      ) : null}
    </>
  );
}

// top comes from the safe area so the notch never covers it; z-index above the terminal and the reader page
const cornerStyle: React.CSSProperties = { position: 'fixed', top: 'calc(env(safe-area-inset-top, 0px) + 6px)', zIndex: 40 };

const chipBtnStyle: React.CSSProperties = {
  width: 28, height: 28, borderRadius: 14, border: '1px solid var(--line-strong)',
  background: 'color-mix(in srgb, var(--bg1) 80%, transparent)', color: 'var(--text)',
  fontSize: 14, lineHeight: '24px', padding: 0, cursor: 'pointer', backdropFilter: 'blur(6px)',
};
