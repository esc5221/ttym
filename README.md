# ttym

> 🇰🇷 한국어: [README.ko.md](README.ko.md)

A web-based terminal multiplexer. One server owns the PTY sessions; attach from
the CLI, a browser, or the desktop app and you see and drive the same session.
Restart the server, or swap in a new build, and the sessions survive: same
processes, same screens.

## Why

- Run agents (Claude Code, Codex, …) for hours and attach/detach from anywhere.
- Group terminals into a `workspace` and script them with `send` / `await`.
- Watch the very same session from a browser.
- Upgrade the server without killing the work running inside it.

## Architecture

### Processes

```
         Clients (viewers)                     Server                  PTY backend
         ─────────────────                    ────────                ───────────────

         ttym attach        (Node TUI)       ┌──────────┐             ┌─ Holder #1 ─► zsh
                                             │          │         UDS │
         @ttym/web          (browser)   ───► │  server  │ ──────────► ├─ Holder #2 ─► claude
                                             │  (Node)  │  frame      │
         @ttym/desktop      (Tauri)          │          │  protocol   └─ Holder #N ─► codex
                                             └──────────┘
                                                  ▲                   Rust · ~1MB · one per session
         ttym new/split/send/await  ────────────┘                    outlives the server
         ttym start/stop/status       HTTP only
         (CLI control-plane)
```

Key points:

- **The server is the only hub.** Nothing but the server talks to holders.
- **Three viewers.** All speak the same `HTTP + WebSocket` protocol.
- **The CLI plays two roles.** `attach` is a viewer; everything else is the
  control plane — and the compatibility boundary.
- **One holder per session.** The server can die; the PTY and its ring buffer stay.

### Components

```
Component        Lang         Role                                      Source
───────────────────────────────────────────────────────────────────────────────────────
@ttym/cli        Node ESM     server lifecycle · attach TUI ·           packages/cli
                              new/split/send/await control plane
@ttym/server     TS → Node    HTTP + WS hub, headless xterm mirror,     packages/server
                              OutputRing (seq-based delta), workspace
                              store, interactions, agent hook API
holder           Rust         PTY fd + ring buffer. The persistence.    holder/src
@ttym/protocol   TS           WS wire format — one impl for both ends   packages/protocol
@ttym/api        TS           HTTP client shared by all three apps      packages/api
@ttym/ui         React/TS     xterm.js wrapper + mux components         packages/ui
@ttym/web        React/Vite   browser viewer                            packages/web
@ttym/desktop    Tauri        desktop viewer                            packages/desktop
@ttym/shared     TS           domain rules, e.g. the layout tree        packages/shared
```

### Data flow (one session)

```
input (keystroke):
  viewer → CMD.DATA(sessionId, bytes) → WS → server → unix socket → holder → PTY

output (PTY byte):
  PTY → holder ring → unix socket → server.OutputRing.append(seq)
                                      ├─► CMD.DATA(seq) to every attached viewer
                                      └─► headless xterm mirror (feeds SNAPSHOT on ATTACH)
  viewer → renders → replies CMD.ACK(seq)

fresh attach:
  viewer → CMD.ATTACH{ fromSeq, cols, rows, mode }
  server → CMD.SNAPSHOT (full screen) → then CMD.DATA deltas only

server restart:
  server → seeds xterm from the per-session checkpoint (rendered ANSI + offset)
         → DUMP_SINCE(offset) to the holder → REPLAY of the delta only
```

## Install

Prerequisites: Node.js, Rust, pnpm.

```bash
pnpm install
./scripts/build.sh
```

Build outputs:

```
dist/
├── ttym              # CLI (esbuild bundle)
├── ttym-server.js    # bundled server + web static assets
└── ttym-holder       # Rust binary
```

## Quick start

```bash
./dist/ttym start                       # server in the background (port 7690)

./dist/ttym new claude -- claude        # a session, named in the default workspace
./dist/ttym split :claude logs          # a real split beside it — nesting and ratios survive
./dist/ttym attach default/claude       # TUI (C-b d to detach)

# the browser sees the same server:
open http://localhost:7690
```

## CLI reference

### Addresses

```
ws:name     member "name" of workspace "ws"
:name       member of the current workspace (inferred from TTYM_SESSION_ID)
#42         raw session id — reaches sessions outside any workspace too
```

On startup the CLI checks `API_VERSION` against `/api/version` and refuses to
run on mismatch rather than misbehaving quietly.

Global flags (`--port`, `--json`) may appear anywhere in the command line —
they are extracted before dispatch, so `--cmd` never swallows them. Everything
after `--` is passed through verbatim.

Exit codes are a contract, verified by the contract suite:

```
0  success
1  general failure
2  usage error
3  target resolution failed (unknown or ambiguous address)
4  server unreachable
5  API version mismatch
```

### Sessions

```bash
ttym new <name> [-- <cmd...>]              # default cmd: $SHELL
ttym split <ws:name|:name> <new> [-- cmd]  # split next to the target
ttym send <ws:name|:name|#id> -- "data"    # raw bytes to the PTY
ttym screen <ws:name|:name|#id> [--json]   # read the current screen
ttym await <ws:name|:name|#id> [--timeout ms] -- "prompt"
                                           # ask an agent, get only this turn's answer
ttym resize <ws:name|:name|#id> <cols> <rows>
ttym kill <ws:name|:name|#id>              # end the session, holder included
ttym map refresh [--model haiku] [--force] # AI-summarize stale sessions into the work map
```

`map refresh` reads each stale session's screen tail (stale = output advanced
past the last summary's seq), batches them into one model call, and writes
the results back: per-session summaries into session annotations
(`mapSummary`), per-workspace placement (`stream`/`column`/`order`) into the
workspace store. The web's **map** main view (settings → main view) renders
it. Fresh sessions cost nothing — they are skipped.

**Model backend — one rule**: if a base URL is set, the summarizer speaks
OpenAI-compatible HTTP; otherwise it shells out to `claude -p`. Configure in
`~/.ttym/config`:

```
map-model    = deepseek-v4-flash            # default: haiku (claude CLI)
map-base-url = https://opencode.ai/zen/go/v1  # unset → claude CLI
```

The API key never goes in the config file (it is served to every client
over `GET /api/config`). Put it in `~/.ttym/map-api-key` (chmod 600) or
`OPENAI_API_KEY`. Reasoning models are handled: the request disables
thinking (`thinking: {type: "disabled"}`) and retries without the knob if
the server rejects it — measured on deepseek-v4-flash, which otherwise
burns its whole token budget on reasoning and returns empty content.
`claude -p` runs with `--no-session-persistence` so a 10-minute cadence
does not litter `~/.claude/projects` with session transcripts.

For a standing cadence, install the launchd template:

```bash
cp scripts/com.lullu.ttym-map-refresh.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.lullu.ttym-map-refresh.plist
```

### Server lifecycle

```bash
ttym start [--port 7690]   # background start. PID: ~/.ttym/ttym.pid
ttym stop                  # stop the server. Holders survive
ttym restart               # restart → sessions auto-recover. Yields if launchd respawns first
ttym status                # server + session list
ttym log [-f]              # ~/.ttym/ttym.log
```

### attach — interactive TUI

```bash
ttym attach <session-id>
ttym attach <workspace>/<member>
ttym attach <ws>/<member> --new --cmd claude --dangerously-skip-permissions
ttym attach <target> --readonly          # observe only
ttym attach <target> --prefix C-a        # change the prefix key (default C-b)
```

Key bindings (prefix = `C-b` by default):

```
C-b d         detach (session keeps running)
C-b s         session picker
C-b n / p     next / previous workspace member
C-b ?         help
C-b C-b       send a literal prefix to the PTY
C-]           alternate detach
```

### Workspace control plane

```bash
ttym current [--json]                       # this session's project/workspace/member
ttym project list [--json]
ttym workspace list [project] [--json]
ttym workspace info <ws|--current> [--json]
ttym workspace create <project> --name <name>
ttym workspace rename <ws|--current> --name <new>
ttym workspace delete <ws|--current>

ttym workspace add <ws|--current> --name <m> [--role <r>] [--cmd <cmd...>]
ttym workspace member rename <ws|--current> <m> --name <new>

ttym workspace detach    <ws|--current> <m>   # drop membership, keep the session
ttym workspace remove    <ws|--current> <m>   # drop membership, kill the session
ttym workspace send/screen/await ...          # legacy syntax — coexists with colon addresses
# `terminate` is gone — it was `remove` under a second name.
```

`--current` resolves the workspace through `TTYM_SESSION_ID`, injected
automatically inside every ttym session.

### meta — session KV

```bash
ttym meta <session-id>                           # merged view (runtime + annotations)
ttym meta <id> --set name=worker                 # user KV → routed to annotations
ttym meta <id> --claude-session <uuid>           # link a Claude session
ttym meta <id> --codex-session <uuid>
```

Meta has split ownership: runtime keys (`claude*`, `codex*`, `stopSeq`, …) are
server-owned — a public PATCH gets a 400, hooks write them through an internal
API. Everything else is user-owned (annotations). The classification lives in
`@ttym/protocol`.

### agent — hook installation

```bash
ttym agent install claude       # injects SessionStart+Stop hooks into ~/.claude/settings.json
ttym agent install codex        # ~/.codex/hooks.json (needs the codex_hooks flag, v0.114+)
ttym agent uninstall <agent>
ttym agent status
ttym agent info [session-id]    # the claude/codex session linked to a ttym session
ttym agent resume [agent]       # claude --resume / codex resume into that session
```

## HTTP API

All responses are JSON. Default base `http://localhost:7690`.

```
GET    /api/version                         API_VERSION — client compatibility check
GET    /api/sessions                        list sessions
POST   /api/sessions                        create {cmd, cols, rows, cwd?}
GET    /api/sessions/:id                    one session
DELETE /api/sessions/:id                    kill (holder included)
POST   /api/sessions/:id/send               {data} → raw bytes to the PTY
GET    /api/sessions/:id/screen             current screen dump
POST   /api/sessions/:id/resize             {cols, rows}
GET    /api/map                             work map: workspaces + sessions + AI summaries + freshness
POST   /api/sessions/:id/interactions       {prompt, timeoutMs?} → blocks until answered
GET    /api/sessions/:id/interactions/:iid  resume an interaction handed off with a 202
GET    /api/sessions/:id/runtime            assembled server-owned view (terminal·process·agent)
GET|PATCH /api/sessions/:id/annotations     user-owned KV
GET|PATCH /api/sessions/:id/meta            merged view — compat adapter. Runtime keys → 400
POST   /api/internal/sessions/:id/stop      agent Stop hooks only
POST   /api/internal/sessions/:id/agent     runtime-key writes from hooks only

GET    /api/projects                        project aggregation
GET    /api/workspaces[?project=<p>]        list workspaces
POST   /api/workspaces                      create
GET|PATCH|DELETE /api/workspaces/:id
POST   /api/workspaces/:id/members          add member {sessionId, name, role?, tags?}
PATCH|DELETE /api/workspaces/:id/members/:sid
POST   /api/workspaces/:id/split            layout operations
```

## WebSocket frame protocol

Endpoint `ws://localhost:7690/ws`. Binary frames.

```
base header (3B):              uint16 LE sessionId | uint8 cmd
DATA header (7B, server→client only):  + uint32 LE seq
payload:                       binary or UTF-8 JSON depending on cmd
```

**DATA frames differ by direction.** Server→client output carries a `seq` for
replay/ACK; client→server input is the key bytes, nothing else. The decoders
are split accordingly into `decodeServerFrame` and `decodeClientFrame`. Merging them
into one symmetric decode makes the server eat the first 4 bytes of input as a
seq; that exact merge shipped once and swallowed Korean IME commits (syllable +
space = 7 bytes) whole. A regression test now drives a real PTY through that
scenario.

CMD codes:

```
0x00 DATA         PTY ↔ viewer byte stream (seq on output only)
0x01 RESIZE       {cols, rows}
0x03 DESTROY      session ended
0x04 PAUSE        pause session output
0x05 RESUME
0x06 HELLO        {clientId}
0x08 ATTACH       {fromSeq, cols, rows, mode}
0x09 DETACH
0x0a SNAPSHOT     full screen, UTF-8 (ATTACH response)
0x0b ACK          {seq} — viewer confirms DATA receipt
0x0c PAUSE_VIEW   (viewer-side pause)
0x0d RESUME_VIEW
```

## Session persistence

The holder is a separate process, so the PTY survives the server.

```bash
ttym start
ttym new work
ttym restart                  # the server goes down and comes back, but
ttym status                   # the sessions are still there, same pids; attach and continue
```

Recovery is three layers deep:

- **Checkpoints.** The server periodically writes each session's rendered ANSI
  snapshot to disk (2s idle / 30s max, with the applied offset, holder
  generation, and per-row wrap bits). On restart it seeds xterm from the
  checkpoint and asks the holder only for the delta past that offset. If the
  offset has fallen out of the ring, the holder answers with `gap` — and the
  server does not dress that up as a clean recovery.
- **Controller lease.** A holder accepts one controller. A new server must
  `ACQUIRE` explicitly and is refused while the seat is taken. Before these
  frames existed, a second server silently evicted the first — which is how a
  session got lost when two servers raced.
- **Socket self-heal.** Every 5s the holder checks its own socket path; if the
  file is gone it rebinds and rewrites its manifest, so a live PTY never
  becomes unreachable.

Boot recovery revives only sessions referenced by a workspace; unreferenced
snapshot/meta files are GC'd after a 14-day grace (`TTYM_GC_DAYS`, 0=off).

## Agent integration

### What the hooks do

- **SessionStart**: when Claude/Codex starts, its session id is recorded on the
  ttym session named by `TTYM_SESSION_ID` (`claudeSessionId` / `codexSessionId`).
- **Stop**: reports turn completion to the server
  (`POST /api/internal/sessions/:id/stop`). StopFailure and SessionEnd are
  registered too, so a failed turn settles immediately instead of at the timeout.

```
scripts/ttym-claude-hook.sh           Claude SessionStart
scripts/ttym-claude-stop-hook.sh      Claude Stop
scripts/ttym-codex-stop-hook.sh       Codex Stop
```

### How await works

`ttym await` returns **this turn's transcript**, not a screen dump. The server
pins the buffer position with an xterm marker, sends prompt+CR, and when the
Stop hook fires extracts the rendered rows from marker to cursor. If the marker
scrolled out, you get null rather than someone else's output. On timeout the
interaction is handed off with 202 + Location and can be resumed by id.

`await` on several members at once completes independently for each.

## Development

```bash
pnpm test                     # vitest — spawns real holders, real PTYs, replays a production fixture
pnpm test:e2e                 # Playwright
pnpm --dir packages/server dev
pnpm --dir packages/web dev   # browser app (Vite, separate port)
pnpm desktop:dev              # Tauri app (dev shell; point it with TTYM_PORT)
```

### Desktop release

```bash
pnpm desktop:build            # tauri build → .app  (runs scripts/build.sh first,
                              #  so the bundled fallback dist ships current)
ditto packages/desktop/src-tauri/target/release/bundle/macos/ttym.app /Applications/ttym.app
```

When to rebuild: the app is a native shell around the *served* web UI, so web
changes reach it through a normal server deploy — no rebuild. Rebuild only when
`packages/desktop/src-tauri` changes, or to refresh the bundled `dist/` the app
uses to bootstrap a server when none is running.

pnpm workspace members: the 8 `packages/*` plus the Rust `holder/`.

## Config file

`~/.ttym/config` — flat `key = value`, `#` comments (the ghostty model). The
server owns the file and serves it over `GET /api/config`; clients PATCH it
and every surface (web, desktop, every window) follows. Comments and unknown
lines survive edits. Never put secrets here — it is served to every client.

```
theme        = dark | light         UI + terminal palette
ui-style     = frame | classic      chrome style
main-view    = preview | map        main page: session previews or the work map
font-size    = 14                   terminal font size (8–32)
local-echo   = true | false         optimistic local echo (experimental)
zoom         = 1.0                  desktop window zoom (written by the app)
map-model    = haiku                summarizer model (see `map refresh`)
map-base-url =                      set → OpenAI-compatible HTTP; unset → claude CLI
```

Related but deliberately outside this file: the summarizer API key lives in
`~/.ttym/map-api-key` (chmod 600) or `OPENAI_API_KEY`.

## Environment variables

```
PORT                   server port (default 7690)
TTYM_HOME              replaces the ~/.ttym root (test isolation)
TTYM_RUNTIME_DIR       holder socket/manifest dir (default ~/.ttym/run)
TTYM_HOLDER_BIN        holder binary path (default: auto-detected in dist/)
TTYM_GC_DAYS           grace days for unreferenced snapshot/meta (default 14, 0=off)
TTYM_SESSION_ID        auto-injected inside ttym sessions (used by attach/hooks)
TTYM_PREFIX            attach TUI prefix key (default C-b)
TTYM_HTTP_TIMEOUT_MS   CLI HTTP timeout (default 5000)
TTYM_ATTACH_RETRY_MS   attach reconnect interval (default 1000)
```

## Runtime paths

```
~/.ttym/
├── ttym.pid              server PID
├── ttym.log              server stdout/stderr (copy-truncate at 64MB → .1)
└── run/
    ├── workspaces.json       workspaces + members (atomic writes)
    ├── session-<id>.json     holder manifest
    ├── session-<id>.sock     holder unix socket
    ├── snapshot-<id>.json    checkpoint (rendered ANSI + offset)
    ├── meta-<id>.json        session meta
    └── next-id               session id counter
```

## Documentation

- [docs/architecture.md](docs/architecture.md) — layers, the holder contract, recovery, interactions
- [docs/adr-0001-membership.md](docs/adr-0001-membership.md) — what a session belongs to, decided
