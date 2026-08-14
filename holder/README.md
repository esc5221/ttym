# holder

The Rust process that *is* a session's persistence: one per session, ~1MB,
holding the PTY fd and a ring buffer of output. Detached from the server —
servers come and go; the holder and the process inside it stay.

## Protocol (unix socket, server ⇄ holder)

```
0x02 STATE        0x06 DUMP_REQ      0x0C ACQUIRE     0x10 DUMP_SINCE
0x03 DATA_OUT     0x07 DUMP_RESP     0x0D ACQUIRED    0x11 REPLAY
0x04 DATA_IN      0x08 EXIT          0x0E DENIED      (gap-safe: replay
0x05 RESIZE       0x09 KILL          0x0F EVICTED      starts on an ANSI-
                  0x0A/0x0B PING/PONG                   safe boundary)
```

Load-bearing behaviors, each with a story behind it:
- **Controller lease** — one server at a time; a second `ACQUIRE` is DENIED.
  A denial means *occupied*, never *dead*.
- **Anchor tracker** — a UTF-8 + ECMA-48 lexer marks safe offsets so a replay
  never starts mid-escape-sequence.
- **Socket self-heal** — every 5s the holder re-checks its socket path and
  rebinds if the file vanished; a live PTY never becomes unreachable.

Socket path: `/tmp/ttym-<uid>/<fnv1a64(runtimeDir)>/session-<id>-<nonce>.sock`
(nonce prevents stale-socket interception; the server passes it via --socket).
