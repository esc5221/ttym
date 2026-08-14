# @ttym/protocol

The WebSocket wire format — one implementation imported by both ends, so the
server and every client always agree byte-for-byte. Also home to
`API_VERSION` (the compatibility gate) and the meta key ownership rules.

## Boundary

Here: frame encode/decode, opcode table, version constant, which meta keys
are server-owned vs user-owned.
Not here: transport (→ vt's mux), HTTP (→ api), any behavior.

## Key exports

```
API_VERSION            bumped when the contract changes; clients refuse a mismatch
CMD                    opcode table 0x00–0x10 (DATA … WORKSPACE, AGENT, CONFIG)
encode / decode        uint16 sessionId · uint8 cmd · payload
encodeData             the DATA variant with a seq header
isRuntimeMetaKey …     meta ownership classification (server enforces, CLI routes)
```

Depended on by: server, cli, vt. Depends on: nothing.
