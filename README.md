# ttym

> 🇰🇷 한국어: [README.ko.md](README.ko.md)

A terminal multiplexer built on **PTYs that outlive the server**. Restart or
upgrade the server and the agents, builds and ssh sessions inside it keep
going — same processes, same screens.

That property is exercised, not aspirational: the production instance has been
swapped live mid-day with every session surviving, child pids identical.

```sh
ttym new claude               # a session, filed in the default workspace
ttym split :claude logs       # a real split beside it — nesting and ratios survive
ttym send :claude -- 'hi'     # bytes to the PTY
ttym await :claude -- 'why is the build red?'   # ask an agent, get only its answer
ttym screen '#42'             # any session, workspace or not, by id
```

## Layout

```
packages/
  web        browser app            cli        headless surface (the compatibility boundary)
  desktop    Tauri app              protocol   wire format, one implementation for both ends
  ui         terminal component     api        HTTP client shared by the apps
  server     terminal state, sessions, workspaces, agent interactions
  shared     domain rules the server and clients must agree on
holder/      Rust; one detached process per session, owning the PTY
```

The holder is the load-bearing decision: it is connected to the server by a
unix socket only, so the server can die and nothing else does. The server owns
every higher meaning — cell grid, scrollback, checkpoints, transcripts — and
on reconnect seeds from its last rendered checkpoint, asking the holder only
for the bytes after it. A controller lease keeps two servers from silently
fighting over one PTY.

Sessions running Claude Code or Codex get request/response on top of the
terminal: `ttym await` returns the transcript of that turn only, settled by
the agent's stop hook — a failed turn resolves in milliseconds, not at the
timeout.

## Running

```sh
pnpm install
./scripts/build.sh          # Rust holder + server bundle + CLI bundle → dist/
./dist/ttym start           # :7690, web app included
open http://127.0.0.1:7690
```

`pnpm test` boots real holders, drives a real PTY over the wire protocol, and
replays a de-identified capture of the production runtime dir at full scale.

## Documentation

- [docs/architecture.md](docs/architecture.md) — layers, the holder contract, recovery, interactions
- [docs/adr-0001-membership.md](docs/adr-0001-membership.md) — what a session belongs to, decided

## License

Private, for now.
