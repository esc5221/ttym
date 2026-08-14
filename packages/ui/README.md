# @ttym/ui

React components around xterm.js. The centerpiece is `TerminalHost`: it owns
the xterm instance, renderer, and write pipeline, and **outlives any React
component that displays it** — views reparent the host's DOM in and out, so
scrollback and renderer state survive every navigation (the vscode terminal
model).

## Boundary

Here: xterm ownership, the write/ACK pipeline, addons (search, links,
clipboard, webgl, fonts), layout rendering.
Not here: wire/mux logic (→ vt), app routing and pages (→ web).

## Key exports

```
<Terminal mux sessionId mode …/>   one live pane (readwrite or readonly)
<LayoutView …/>                    a workspace's split tree
getHost(sessionId)                 imperative host access (search, markers)
refreshTerminalThemes()            repaint all live terminals after a theme change
```

Depended on by: web. Depends on: @ttym/vt, @ttym/shared, @xterm/*, react (host app provides).
