# ttym

> 🇰🇷 한국어: [README.ko.md](README.ko.md)

Web-based terminal multiplexer. A single server owns the PTY sessions; you can attach from the CLI, a browser, or a desktop app and operate the same session. Sessions survive a server restart.

## Why

- Run long-lived agents (Claude Code, Codex, …) and attach/detach freely from any viewer.
- Group terminals as `workspace / member` and script them with `send` / `await`.
- See the same session in the browser without extra config.

## Architecture

### Process layout

```
         Clients (viewers)                     Server                  PTY backend
         ─────────────────                    ────────                ───────────────

         ttym attach        (Node TUI)       ┌──────────┐             ┌─ Holder #1 ─► zsh
                                             │          │         UDS │
         @ttym/demo         (browser)   ───► │  server  │ ──────────► ├─ Holder #2 ─► claude
                                             │  (Node)  │  frame      │
         @ttym/native       (Tauri)          │          │  protocol   └─ Holder #N ─► codex
                                             └──────────┘
                                                  ▲                   Rust · ~1MB · one per session
         ttym workspace/meta/agent  ──────────────┘                   survives server restart
         ttym start/stop/status       HTTP only
         (CLI control-plane)
```

Key points:

- **Server is the only hub.** Holders talk to the server and nothing else.
- **Three viewer forms, one protocol.** All three clients use the same `HTTP + WebSocket`.
- **CLI wears two hats.** `attach` is a viewer; `workspace/meta/agent/start/stop` is the control plane.
- **One Holder per session.** PTY and ring buffer stay alive even when the server dies.

### Components

```
Component       Lang         Role                                      Source
──────────────────────────────────────────────────────────────────────────────
ttym (CLI)      Node ESM     server lifecycle · attach TUI ·          bin/ttym
                             workspace/agent control plane
server          TS → Node    HTTP + WS hub, headless xterm mirror,     server/src
                             OutputRing (seq-based delta), workspace
                             store, agent hook API
holder          Rust         PTY fd + ring buffer. Owns persistence.   holder/src
@ttym/client    React/TS     xterm.js wrapper + mux protocol           client/src
@ttym/demo      React/Vite   browser viewer                            demo/
@ttym/native    Tauri        desktop viewer                            native/
shared          TS           workspace domain logic                    shared/src
```

### Data flow (per session)

```
Input (keystroke):
  viewer → CMD.DATA(sessionId, bytes) → WS → server → unix socket → holder → PTY

Output (PTY bytes):
  PTY → holder ring → unix socket → server.OutputRing.append(seq)
                                      ├─► CMD.DATA(seq) to every attached viewer
                                      └─► update headless xterm mirror (for future ATTACH snapshot)
  viewer → render → CMD.ACK(seq)

New attach:
  viewer → CMD.ATTACH{ fromSeq, cols, rows, mode }
  server → CMD.SNAPSHOT (full screen) → then CMD.DATA deltas
```

## Install

Prerequisites: Node.js, Rust, pnpm.

```bash
pnpm install
./scripts/build.sh
```

Build output:

```
dist/
├── ttym              # CLI (ESM)
├── ttym-server.js    # bundled server + demo static assets
└── ttym-holder       # Rust binary
```

## Quick start

```bash
./dist/ttym start                                  # background server on port 7690

./dist/ttym workspace create demo --name onboard   # project=demo, workspace=onboard
./dist/ttym workspace add demo/onboard --name sh --cmd /bin/zsh
./dist/ttym attach demo/onboard/sh                 # attach TUI (C-] to detach)

# Same server in the browser:
open http://localhost:7690
```

## CLI reference

### Server lifecycle

```bash
ttym start [--port 7690]   # background. PID: ~/.ttym/ttym.pid
ttym stop                  # stop server; holders survive
ttym restart               # restart → sessions auto-recover
ttym status                # server + session list
ttym log [-f]              # ~/.ttym/ttym.log
```

### attach — interactive TUI

```bash
ttym attach <session-id>                 # raw session id
ttym attach <workspace>/<member>         # when workspace name is unique
ttym attach <project>/<workspace>/<member>
ttym attach <ws>/<member> --new --cmd claude --dangerously-skip-permissions
                                         # creates the member on demand if missing
ttym attach <target> --readonly          # observe only
ttym attach <target> --prefix C-a        # override prefix key (default C-b)
```

Keybindings (prefix defaults to `C-b`):

```
C-b d         detach (session keeps running)
C-b s         session picker (j/k to move, Enter to select, Esc to cancel)
C-b n         next workspace member
C-b p         previous workspace member
C-b ?         help
C-b C-b       send the prefix literal to the PTY
C-]           alternate detach
```

Env var `TTYM_PREFIX=C-a` overrides the default prefix globally.

### workspace / member control plane

```bash
ttym current [--json]                                    # project/workspace/member of current session
ttym project list [--json]
ttym workspace list [project] [--json]
ttym workspace info <ws|--current> [--json]
ttym workspace create <project> --name <name>
ttym workspace rename <ws|--current> --name <new>
ttym workspace delete <ws|--current>

ttym workspace add <ws|--current> --name <m> [--role <r>] [--cmd <cmd...>]
ttym workspace member rename <ws|--current> <m> --name <new>

ttym workspace detach    <ws|--current> <m>    # unlink membership, keep session
ttym workspace remove    <ws|--current> <m>    # unlink + kill session
ttym workspace terminate <ws|--current> <m>    # alias for remove
```

`--current` resolves via `TTYM_SESSION_ID` (auto-injected inside a ttym session), so you can drop the address when running from within a session.

### Automation — send / screen / await

```bash
# Send keystrokes (raw bytes, no escape interpretation)
ttym workspace send --current runner -- $'echo hello\n'
ttym workspace send --current claude-sub -- 'prompt body'
ttym workspace send --current claude-sub -- $'\r'         # submit separately

# Dump current screen
ttym workspace screen --current claude-sub [--json]

# Request-response blocking (Claude/Codex only)
ttym workspace await --current claude-sub --json -- 'question'
ttym workspace await --current claude-sub --raw --timeout 60000 -- 'question'
```

**CR vs LF matters.** `send` passes the string through as-is with `Buffer.from(data)`.

- zsh / bash: newline = `\n` (LF)
- Claude Code / Codex TUI: Enter = `\r` (CR) because of raw mode
- `await` appends `\r` automatically

**How await works.** Bump `meta.seq` → send `payload + CR` → the agent's Stop hook writes `meta.stopSeq` on completion → the CLI polls until `seq == stopSeq` → returns the screen. It only works if the hook is installed (see the agent section).

### meta — session KV

```bash
ttym meta <session-id>                           # read full meta
ttym meta <id> --set name=worker --set role=exec # arbitrary key=value
ttym meta <id> --claude-session <uuid>           # link a Claude session
ttym meta <id> --clear-claude-session
ttym meta <id> --codex-session <uuid>            # same for Codex
```

Workspace membership, Claude/Codex session IDs, `stopSeq`, and user KV all live here.

### agent — agent hook installer

```bash
ttym agent install claude       # inject SessionStart+Stop hooks into ~/.claude/settings.json
ttym agent install codex        # same into ~/.codex/hooks.json (requires codex_hooks v0.114+)
ttym agent uninstall <agent>
ttym agent status               # show install state

ttym agent info [session-id]    # show linked Claude/Codex session IDs
ttym agent resume [agent]       # run claude --resume / codex resume with the linked session
```

What the hooks actually do lives in the [Agent integration](#agent-integration) section below.

## HTTP API

All responses are JSON. Base URL defaults to `http://localhost:7690`.

```
GET    /api/sessions                        list sessions
POST   /api/sessions                        create session { cmd, cols, rows, cwd?, verify? }
GET    /api/sessions/:id                    session detail
DELETE /api/sessions/:id                    kill session (kills holder)
POST   /api/sessions/:id/send               { data: string } → raw bytes to PTY
GET    /api/sessions/:id/screen             current screen dump
POST   /api/sessions/:id/resize             { cols, rows }
GET    /api/sessions/:id/meta               read KV
PATCH  /api/sessions/:id/meta               merge KV

GET    /api/projects                        aggregated project list
GET    /api/workspaces[?project=<p>]        list workspaces
POST   /api/workspaces                      create workspace
GET    /api/workspaces/:id                  workspace detail
PATCH  /api/workspaces/:id                  rename, etc.
DELETE /api/workspaces/:id                  delete
POST   /api/workspaces/:id/members          add member { sessionId, name, role?, tags? }
PATCH  /api/workspaces/:id/members/:sid     update member
DELETE /api/workspaces/:id/members/:sid     remove member
POST   /api/workspaces/:id/split            mutate layout tree
```

## WebSocket frame protocol

Endpoint: `ws://localhost:7690/ws`. Binary frames.

```
Base header (3B):   uint16 LE sessionId | uint8 cmd
DATA header (7B):   + uint32 LE seq
Payload:            binary or UTF-8 JSON, depending on cmd
```

CMD codes:

```
0x00 DATA         PTY ↔ viewer byte stream (output includes seq)
0x01 RESIZE       { cols, rows } as 2×uint16
0x02 CREATE       (unused, superseded by HTTP)
0x03 DESTROY      session-gone notification
0x04 PAUSE        pause session output
0x05 RESUME
0x06 HELLO        { clientId }
0x07 LIST         (unused)
0x08 ATTACH       { fromSeq, cols, rows, mode }
0x09 DETACH
0x0a SNAPSHOT     full-screen UTF-8 (response to ATTACH)
0x0b ACK          { seq } — viewer acknowledges a DATA
0x0c PAUSE_VIEW   (viewer-side pause)
0x0d RESUME_VIEW
```

Typical session flow:

```
viewer → HELLO { clientId }
viewer → ATTACH { sessionId, fromSeq=0, cols, rows, mode }
server → ATTACH { ok: true, lastSeq }
server → SNAPSHOT (full screen)
server → DATA(seq=1), DATA(seq=2), ...
viewer → ACK(seq) ...
viewer → DATA(keystroke)
viewer → DETACH   # or just close the socket
```

## Session persistence

Because Holder is a separate process, the PTY stays alive when the server dies.

```bash
ttym start
curl -X POST .../api/sessions -d '{"cmd":["zsh"],"cols":120,"rows":40}'
ttym restart                  # server goes down and back up
ttym status                   # sessions still listed; attach resumes exactly where it left off
```

Recovery: on restart the server scans `~/.ttym/run/sockets/*`, reconnects to each Holder, and reconciles against `workspaces.json` to restore workspaces.

## Agent integration

### What the hooks do

- **SessionStart**: when Claude/Codex starts, it records its session ID into the meta of the ttym session identified by `TTYM_SESSION_ID` (`claudeSessionId` / `codexSessionId`).
- **Stop**: at response completion, the hook clears `claudeActive` and writes `stopSeq = <bumped seq>` into meta. This is the completion signal that `ttym workspace await` polls for.

The hook scripts:

```
scripts/ttym-claude-hook.sh           Claude SessionStart
scripts/ttym-claude-stop-hook.sh      Claude Stop
scripts/ttym-codex-stop-hook.sh       Codex Stop
```

### Install examples

```bash
ttym agent install claude
# → injects the hooks block into ~/.claude/settings.json
#   existing settings are backed up to .bak

ttym agent install codex
# → injects the hooks block into ~/.codex/hooks.json
#   requires: ~/.codex/config.toml with [features] codex_hooks = true
```

### Parallel awaits

Issuing `await` on several members at once works — each member's Stop hook fires independently, so the awaits complete in parallel.

## Development

```bash
pnpm -F @ttym/server dev      # server with hot reload
pnpm -F @ttym/demo   dev      # browser demo (Vite, separate port)
pnpm test                     # unit tests (vitest)
pnpm test:e2e                 # Playwright

./scripts/pilot-project-workspace-member.sh   # control-plane smoke test
```

pnpm workspace members: `server`, `client`, `demo`, `native`. `shared/` is imported as TS source directly.

## Environment variables

```
PORT                   server port (default 7690)
TTYM_RUNTIME_DIR       holder sockets / manifest directory (default ~/.ttym/run)
TTYM_HOLDER_BIN        holder binary path (default: auto-detected under dist/)
TTYM_SESSION_ID        auto-injected inside a ttym session (used by attach/hooks)
TTYM_PREFIX            attach TUI prefix key (default C-b)
TTYM_HTTP_TIMEOUT_MS   CLI HTTP request timeout (default 5000)
TTYM_ATTACH_RETRY_MS   attach reconnect interval (default 1000)
```

## Runtime paths

```
~/.ttym/
├── ttym.pid           server PID
├── ttym.log           server stdout/stderr
└── run/
    ├── workspaces.json     workspaces + members (atomic writes)
    ├── sessions.json       session meta snapshot
    └── sockets/<id>.sock   holder unix socket (one per session)
```
