import { localFlag } from './local-flag.js';

/**
 * Phone: whether the focused pane takes the whole screen (no tab strip, no pane header).
 * The strip lives in App and the header in the workspace screen, so the choice is shared state.
 */
const flag = localFlag('ttym-phone-immersive');
export const usePhoneImmersive = flag.use;
export const setPhoneImmersive = flag.set;
