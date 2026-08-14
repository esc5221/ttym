# @ttym/vt

The framework-free client core: everything a ttym viewer needs between the
wire and the screen, with no DOM and no React. Build a TUI, a Svelte app, or
a bot on this alone.

## Boundary

Here: pure logic between wire frames and terminal state.
Not here: rendering/React (→ ui), HTTP control (→ api), frame byte layout (→ protocol).

## Key exports

```
TerminalMux            the client's heart — WS connect, attach/detach, seq ACK,
                       snapshot/delta replay, workspace/agent/config push events
LocalEchoController    optimistic echo before server confirmation (experimental)
ansiToHtml / stripAnsi ANSI text utilities
movePanel / …          panel arrangement state
```

## Usage

```ts
import { TerminalMux } from '@ttym/vt';
const mux = new TerminalMux('ws://127.0.0.1:7690/ws');
await mux.connect();
await mux.attachSession(42, { onData: (bytes, seq) => { render(bytes); mux.ack(42, seq); } });
```

Depended on by: ui, web, cli (attach). Depends on: @ttym/protocol.
