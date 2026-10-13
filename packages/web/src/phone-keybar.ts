import { localFlag } from './local-flag.js';

/** Phone: whether the row of terminal keys (esc, tab, arrows…) is folded away. */
const flag = localFlag('ttym-phone-keys-hidden');
export const useKeyBarHidden = flag.use;
export const setKeyBarHidden = flag.set;
