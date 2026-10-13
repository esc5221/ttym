import { useEffect, useState } from 'react';

/**
 * The browser's own full screen (no address bar, no system bars). Android Chrome and iPad allow it;
 * iPhone browsers do not allow it for a page, only for an app opened from the home screen.
 */
export const fullscreenSupported = (): boolean => typeof document !== 'undefined' && document.fullscreenEnabled === true;

export function useFullscreen(): { supported: boolean; on: boolean; toggle: () => void } {
  const [on, setOn] = useState(() => typeof document !== 'undefined' && document.fullscreenElement !== null);
  useEffect(() => {
    const sync = () => setOn(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  const toggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  };
  return { supported: fullscreenSupported(), on, toggle };
}
