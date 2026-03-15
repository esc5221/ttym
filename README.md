# ttym

Web-based terminal multiplexer with session persistence across server restarts.

```
┌─────────┐    WebSocket     ┌─────────┐    Unix Socket    ┌─────────┐
│  Client  │ ◄────────────► │  Server  │ ◄──────────────► │  Holder  │
│ (React)  │   mux protocol │ (Node.js)│  frame protocol  │  (Rust)  │
└─────────┘                 └─────────┘                   └─────────┘
                                                            │ PTY fd
                                                            ▼
                                                          /bin/sh
```

- **Holder**: per-session Rust process (~1MB RSS). Owns PTY fd + ring buffer. Survives server restart.
- **Server**: headless xterm mirror + multi-viewer broadcast + HTTP API.
- **Client**: React + xterm.js. Supports readwrite/readonly modes, workspaces, split panes.

## Install

```bash
# Prerequisites: Node.js, Rust, pnpm
pnpm install
./scripts/build.sh
```

Build output:
```
dist/
├── ttym              # CLI (4.8K)
├── ttym-server.js    # Bundled server (464K)
└── ttym-holder       # Rust binary (329K)
```

## Usage

```bash
./dist/ttym start              # Start server (background, port 7690)
./dist/ttym start --port 8080  # Custom port
./dist/ttym status             # Show server & session info
./dist/ttym log -f             # Tail server log
./dist/ttym restart            # Restart (sessions survive)
./dist/ttym stop               # Stop server (sessions survive)
```

Runtime files: `~/.ttym/` (pid, log, sockets)

## Workspace Control Plane

`ttym` now exposes a workspace-oriented CLI for agent workflows. The user-facing model is:

- `project`
- `workspace`
- `member`

Internally, each member is backed by a session/PTy.

```bash
# Inspect current context from inside a ttym session
TTYM_SESSION_ID=233 ./dist/ttym current --json

# List projects and workspaces
./dist/ttym project list --json
./dist/ttym workspace list --json
./dist/ttym workspace info default/workspace\ 1 --json

# Create a workspace under a project
./dist/ttym workspace create pilot --name core --json

# Add named members
./dist/ttym workspace add pilot/core --name lead --role agent --cmd /bin/sh -lc 'exec cat' --json
./dist/ttym workspace add pilot/core --name devserver --role server --cmd /bin/sh -lc 'exec cat' --json

# Send input, inspect screen, detach, terminate
./dist/ttym workspace send pilot/core lead -- 'echo ready\n'
./dist/ttym workspace screen pilot/core lead --json
./dist/ttym workspace detach pilot/core devserver --json
./dist/ttym workspace remove pilot/core lead --json
./dist/ttym workspace delete pilot/core --json
```

Addressing rules:

- project names are globally unique
- workspace names are unique inside a project
- member names are unique inside a workspace
- fully-qualified address is `project/workspace/member`
- inside the current workspace, short member names are allowed

For a complete smoke test, run:

```bash
./scripts/pilot-project-workspace-member.sh
```

## Development

```bash
pnpm -F @ttym/server dev      # Server with hot reload
pnpm -F @ttym/demo dev        # Demo UI (Vite)
pnpm test                     # Unit tests (vitest)
```

## HTTP API

```bash
# List sessions
curl http://localhost:7690/api/sessions

# Create session
curl -X POST http://localhost:7690/api/sessions \
  -d '{"cmd":["/bin/bash"],"cols":120,"rows":40}'

# Read screen
curl http://localhost:7690/api/sessions/1/screen

# Send keys
curl -X POST http://localhost:7690/api/sessions/1/send \
  -d '{"data":"ls -la\n"}'

# Resize
curl -X POST http://localhost:7690/api/sessions/1/resize \
  -d '{"cols":200,"rows":50}'

# Kill session
curl -X DELETE http://localhost:7690/api/sessions/1
```

## Session Persistence

Sessions survive server restarts. Each session runs in its own Rust holder process:

```bash
./dist/ttym start                    # Start
curl -X POST .../api/sessions ...    # Create sessions
./dist/ttym restart                  # Server restarts, sessions recovered
./dist/ttym status                   # Sessions still there
```

## Project Structure

```
ttym/
├── holder/    # Rust PTY holder binary
├── server/    # Node.js WebSocket + HTTP server
├── client/    # React client library (@ttym/client)
├── demo/      # Demo app (Vite + React)
├── bin/       # CLI source
└── scripts/   # Build scripts
```

## Environment Variables

```
PORT              Server port (default: 7690)
TTYM_RUNTIME_DIR  Socket/manifest dir (default: ~/.ttym/run)
TTYM_HOLDER_BIN   Holder binary path (default: auto-detect)
```
