// Imported first by the panel: terminal-host reads this when it registers fonts.
// The panel is served under a consumer's path prefix (/studio/embed/v1/), so the
// fonts come relative to the page — the server maps embed/v1/fonts/* to them.
(globalThis as { __TTYM_ASSET_BASE__?: string }).__TTYM_ASSET_BASE__ = './';
export {};
