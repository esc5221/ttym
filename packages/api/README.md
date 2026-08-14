# @ttym/api

The HTTP client — the one door through which the three apps (web, desktop,
CLI) and any script drive a ttym server. Thin typed wrappers over the REST
surface, no state of its own.

## Boundary

Here: request helpers and response types for every `/api/*` route.
Not here: the WebSocket stream (→ vt), retry/queueing policy, UI concerns.

## Usage

```ts
import { createApi } from '@ttym/api';
const api = createApi('http://127.0.0.1:7690');
const sessions = await api.sessions.list();
await api.sessions.send(sessions[0].id, 'echo hi\n');
```

Depended on by: web, cli. Depends on: @ttym/shared (types).
