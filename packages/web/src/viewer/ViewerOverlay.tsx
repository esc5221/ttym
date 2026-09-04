import { createPortal } from 'react-dom';
import type { ViewerState } from '@ttym/api';
import { ViewerPanel } from './ViewerPanel.js';

/**
 * Full mode: the viewer over the whole workspace, in Zen's spot. The
 * terminal stays where it was — unlike Zen there is no host to move, a
 * viewer is not a terminal. The bar names the pane so the reader knows
 * whose tab they are looking at.
 */
export function ViewerOverlay({ sid, name, state, activeId, onSelect, onClose, onCloseAll, onOpen, onExit, jump }: {
  sid: number;
  name?: string;
  state: ViewerState;
  activeId: string | null;
  onSelect: (vid: string) => void;
  onClose: (vid: string) => void;
  onCloseAll: () => void;
  onOpen: (targets: string[]) => void;
  onExit: () => void;
  jump?: { vid: string; line: number; col?: number; nonce: number };
}) {
  return createPortal(
    <div className="viewer-overlay">
      <div className="viewer-overlay-bar">
        <span style={{ color: 'var(--text)', fontWeight: 700 }}>{name || `#${sid}`}</span>
        <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>#{sid} · viewer</span>
      </div>
      <div className="viewer-overlay-stage">
        <ViewerPanel
          sid={sid}
          state={state}
          activeId={activeId}
          onSelect={onSelect}
          onClose={onClose}
          onCloseAll={() => { onCloseAll(); onExit(); }}
          onOpen={onOpen}
          onPane={onExit}
          jump={jump}
          mode="full"
        />
      </div>
    </div>,
    document.body,
  );
}
