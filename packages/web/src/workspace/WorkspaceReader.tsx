import { ReaderView } from '../reader/ReaderView.js';
import { PANE_BODY_ATTR, usePaneFileDrop, usePaneSelection } from './pane-input.js';
import { useWorkspaceSessions } from './session-context.js';

/**
 * The reader page as a pane's page: `ReaderView` plus what a pane does with the pointer.
 * The reader knows nothing of workspaces, so the pane's own input handling comes in here
 * (the same hooks the terminal body uses) and goes down as `paneProps`.
 */
export function WorkspaceReader(props: Omit<React.ComponentProps<typeof ReaderView>, 'paneProps'>) {
  const { sid } = props;
  const ctx = useWorkspaceSessions();
  const fileDrop = usePaneFileDrop(sid);
  const beginSelection = usePaneSelection(sid);
  return (
    <ReaderView
      {...props}
      paneProps={{
        ...fileDrop,
        onMouseDown: (e) => {
          ctx.focusSid(sid);
          // The path menu is placed in the terminal body's box, which sits next to the page in the same stage.
          const body = (e.currentTarget.parentElement?.querySelector(`[${PANE_BODY_ATTR}]`) ?? null) as HTMLElement | null;
          beginSelection(e, { body, readText: () => window.getSelection()?.toString() ?? '' });
        },
      }}
    />
  );
}
