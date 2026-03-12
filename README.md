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
