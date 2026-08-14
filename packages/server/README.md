# @ttym/server

The hub — the only process that talks to holders. Owns the headless xterm
mirror per session (screens exist server-side), the OutputRing (seq-based
delta replay with ACK-driven trim), the workspace store, the shell-integration
command index, interactions (await), and the work-map assembly.

Bundled into `dist/ttym-server.js`, which also serves the built web app and
the HTTP/WS API. Reliability doctrine, enforced by tests: every state signal
is verified, expiring, or recoverable from a snapshot — recovery gaps are
reported as `integrity: "degraded"`, never dressed up.

See the root README for the HTTP/WS reference and docs/architecture.md for
the holder protocol and recovery layers.
