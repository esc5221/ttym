/**
 * The key that opens the session finder: ⌘K on a Mac, Ctrl+Shift+K elsewhere.
 * Plain Ctrl+K is readline's kill-line, so taking it would break the shell in every pane.
 */

export const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

export const SEARCH_KEY_LABEL = IS_MAC ? '⌘K' : 'Ctrl+Shift+K';

type KeyLike = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>;

export function isSearchKey(e: KeyLike, mac: boolean = IS_MAC): boolean {
  if (e.key.toLowerCase() !== 'k' || e.altKey) return false;
  return mac ? e.metaKey && !e.ctrlKey && !e.shiftKey : e.ctrlKey && e.shiftKey && !e.metaKey;
}
