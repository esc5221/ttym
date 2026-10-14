/**
 * The key that flips a pane between the terminal and reader mode: ⌘, on a Mac, Ctrl+, elsewhere.
 * A comma with Ctrl sends no byte to the terminal, so taking it costs nothing there
 * (Ctrl+/ would: it is ^_, the undo key of readline and of Claude Code's prompt).
 */

export const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

/** What the key is called on this machine, for tooltips. */
export const READER_KEY_LABEL = IS_MAC ? '⌘,' : 'Ctrl+,';

type KeyLike = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>;

export function isReaderToggleKey(e: KeyLike, mac: boolean = IS_MAC): boolean {
  if (e.key !== ',' || e.shiftKey || e.altKey) return false;
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}
