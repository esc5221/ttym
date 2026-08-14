# @ttym/desktop

A Tauri shell worn around the *served* web app — it loads the same UI the
server hosts, so web changes arrive with a normal server deploy and no app
rebuild. Rebuild only when `src-tauri` changes or to refresh the bundled
fallback `dist/` used to bootstrap a server when none is running.

```bash
pnpm desktop:dev      # dev shell (point with TTYM_PORT)
pnpm desktop:build    # .app bundle (runs scripts/build.sh first)
```

Native extras over the browser: real file paths on drag-and-drop, window
zoom persisted via the shared config file.
