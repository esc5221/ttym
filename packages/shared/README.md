# @ttym/shared

Domain rules the server and clients must answer identically — mostly the
workspace layout tree: splitting, removing, resizing, presets, and the
member/session bookkeeping derived from it.

## Boundary

Here: pure functions over the layout tree and workspace domain types.
Not here: storage (→ server's workspace-store), rendering (→ ui), I/O of any kind.

## Key exports

```
splitPane / removePane / resizeSplit / swapPanes    layout tree surgery
insertPane / layoutToSessionIds / presetLayout      construction and queries
workspaceLabel / memberNameBySession / formatCwd    display helpers
```

Depended on by: server, api, ui, web. Depends on: nothing.
