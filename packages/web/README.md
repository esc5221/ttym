# @ttym/web

The browser app — a thin window onto the server, served *by* the server from
`packages/web/dist` (build with vite, ship with `scripts/build.sh`). The
terminal is the truth; this app adds navigation (workspaces, panes, zoom),
the settings modal, and the AI work map view. Capability belongs to the
server/CLI layer — when a feature needs new power, it lands there first.

Pages: DashboardPage (session previews), MapPage (work map), workspace view.
Shared helpers live in `src/app-shared.ts`.
