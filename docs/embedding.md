# Embedding ttym in another app

Put a ttym terminal panel inside your own web app. ttym serves the panel and
decides what it can reach; your app decides who may open it.

```
your backend   POST /api/embed/v1/grants on ttym's admin socket (consumer key)   "this user, workspace X, 5 minutes"
browser        <iframe src=".../embed/v1/#g=<grant>">                → ttym     panel: tabs + terminal
               WebSocket .../embed/v1/ws  (grant in the first frame)          reaches X's members only
your proxy     forwards /embed/v1/*, /api/embed/v1/grant, /api/embed/v1/workspaces/* — behind your login
```

## Before you start: run a ttym just for the app

A shell in an embedded tab runs as the OS user ttym runs as, and it can call
ttym's local API (`ttym` CLI, `TTYM_PORT` is in its environment), which needs no
login on loopback. The grant limits what the **panel** can reach, not what a
**shell** can do. So:

- Give each app its own ttym instance. Do not register an app with the ttym that
  holds your own sessions.
- Run that instance as a user without sudo, or in a container, if the people
  opening the panel should not get more than that.

A second instance is a separate home and port:

```sh
TTYM_HOME=~/.ttym-studio PORT=7700 ttym start      # or a container running ttym on its own
```

## 1. Register the app

On the machine running that instance:

```sh
TTYM_HOME=~/.ttym-studio ttym embed consumer add studio \
  --origin https://studio.example.com \
  --workspace studio \
  --profile default='zsh -l' --cwd /work --max-tabs 8 --keep-one
```

| Option | Meaning |
|---|---|
| `--origin` | Page origin the panel is framed from (repeatable). The panel's `frame-ancestors` and the WebSocket Origin check use it. |
| `--workspace` | Workspaces this app may hand out (repeatable, exact names). Created on the first tab if missing. |
| `--profile name=cmd` | A command new tabs may run (repeatable). A grant names a profile; it never carries a command. |
| `--cwd`, `--max-tabs`, `--keep-one` | Apply to the profiles in the same command. `--keep-one`: closing the last tab opens a new one. |
| `--max-ttl` | Longest grant this app may ask for (default `12h`). |

It prints a key once. Put it in the app's backend config. ttym stores only its hash
in `~/.ttym/embed-consumers.json`; the server picks up changes without a restart.

```sh
ttym embed consumer list
ttym embed consumer rotate studio     # new key; grants from the old one end now
ttym embed consumer remove studio     # its grants end now
```

## 2. Mint a grant in your backend

Minting and revoking answer only on ttym's **admin listener**, never on the port
the browser reaches. A proxy that forwards too much still cannot expose them.

| `TTYM_EMBED_ADMIN` | Admin listener |
|---|---|
| unset | unix socket `<TTYM_HOME>/embed.sock` (mode 0600) — for a backend on the same machine |
| `host:port` | TCP, for a backend in another container, e.g. `0.0.0.0:7701` on the container network. Never publish it. |
| `off` | none — this instance mints nothing |

After your app has decided this request may open a terminal (login, office
network, admin role — whatever your app requires):

```sh
curl --unix-socket ~/.ttym-studio/embed.sock http://ttym/api/embed/v1/grants \
  -H "Authorization: Bearer $TTYM_EMBED_KEY" -H 'Content-Type: application/json' \
  -d '{"subject":"kim@example.com","ttlMs":300000,"access":[{"workspace":"studio","caps":["terminal.read","terminal.write","tabs.write"],"profile":"default"}]}'
```

The request body in full:

```http
POST /api/embed/v1/grants
Authorization: Bearer <consumer key>
Content-Type: application/json

{
  "subject": "kim@example.com",
  "ttlMs": 300000,
  "access": [
    { "workspace": "studio", "caps": ["terminal.read", "terminal.write", "tabs.write"], "profile": "default" }
  ]
}
```

```json
{ "grant": "…", "id": "g_…", "expiresAt": 1790000000000, "access": [ … ] }
```

| Capability | Allows |
|---|---|
| `terminal.read` | See the terminals: list, attach, scroll. Required in every entry. |
| `terminal.write` | Type and resize. Without it the panel attaches read-only. |
| `tabs.write` | Open, rename and close tabs (workspace entries only; needs `profile`). |

An entry names a `workspace` (its current members; a closed tab stops being
reachable at once) or one `session` (a read-only view of one terminal, say). A
session must be in one of the app's workspaces when the grant is minted.

Anything outside the registration — another workspace, an unknown capability or
profile, a longer TTL — is a 400 with the reason, never a narrower grant.
`subject` goes to ttym's log (`EMBED grant|open|tab-create|tab-close …`); it is
not stored.

Grants live in ttym's memory: a restart ends them all, and the panel asks your
backend for a new one. To end one early (on the admin listener too):

```http
DELETE /api/embed/v1/grants/<id>
Authorization: Bearer <consumer key>
```

**How long.** Keep grants short — 5 minutes is a good default. The SDK asks your
grant route again before each one ends, so the person keeps working, and your
route re-applies its checks every time: someone who signed out or left the office
network loses the panel within one TTL. A grant also lives in page memory, so a
script injected into your page could carry it off; a short TTL bounds that, and
keeping the WebSocket behind your login (step 3) stops it being used elsewhere.

ttym re-checks grants every few seconds, so `consumer remove` or `rotate` closes
idle sockets too, not only busy ones.

Open panels on it close within a moment (WebSocket close 4401) and ask for a
new grant; if your backend refuses, the panel says the session has ended.

## 3. Proxy three paths to ttym, behind your login

The browser talks to ttym through your origin. Forward **only** these, path
prefix stripped, WebSocket upgrades included:

```
/<prefix>/embed/v1/*                  → ttym /embed/v1/*            panel, sdk.js, the WebSocket
/<prefix>/api/embed/v1/grant          → ttym /api/embed/v1/grant    what a grant reaches
/<prefix>/api/embed/v1/workspaces/*   → ttym /api/embed/v1/workspaces/*   tabs
```

Put them behind the same login your app uses (Caddy `forward_auth`, Cloudflare
Access, an nginx `auth_request`) — the WebSocket upgrade included. ttym checks the
grant either way; your login on the socket is what stops a grant carried off the
page from working on another network or after the person signed out.

Caddy:

```caddy
handle_path /studio/embed/v1/* {
	rewrite * /embed/v1{uri}
	reverse_proxy 127.0.0.1:7700
}
@ttym_api path /studio/api/embed/v1/grant /studio/api/embed/v1/workspaces/*
handle @ttym_api {
	uri strip_prefix /studio
	reverse_proxy 127.0.0.1:7700
}
```

(`forward_auth` before these, as for the rest of your app.)

nginx:

```nginx
location /studio/embed/v1/ {
  proxy_pass http://127.0.0.1:7700/embed/v1/;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
}
location = /studio/api/embed/v1/grant  { proxy_pass http://127.0.0.1:7700/api/embed/v1/grant; }
location /studio/api/embed/v1/workspaces/ { proxy_pass http://127.0.0.1:7700/api/embed/v1/workspaces/; }
```

Do not forward ttym's `/ws` or other `/api/*` paths. Those are the owner's
interface and trust loopback callers, which your proxy is. Forwarding
`/api/embed/v1/grants` by mistake does nothing — it answers 404 on the main port.

## 4. Mount the panel

```html
<div id="term" style="height: 420px"></div>
<script src="/studio/embed/v1/sdk.js"></script>
<script>
  const t = TtymEmbed.mount(document.getElementById('term'), {
    base: '/studio',                                   // your proxy prefix
    grant: () => fetch('/studio/grant', { method: 'POST' }).then((r) => r.json()),
    theme: 'dark',
  });
  t.on('auth', () => showSignIn());
</script>
```

`grant` may be a string, the mint response, or a function returning either. With a
function the SDK asks again before the grant ends and after a revoke, and the
panel re-dials without a reload.

### mount options

| Option | Default | |
|---|---|---|
| `base` | `''` | Path (or URL) your proxy serves ttym under. |
| `grant` | — | String, `{ grant }`, or a function returning one (sync or async). |
| `workspace` / `session` | the grant's first entry | What to show. |
| `chrome` | `'tabs'` | `'none'` hides the tab bar; draw your own from the events. |
| `theme` | `'system'` | `'system'`, `'dark'`, `'light'`. |
| `fontSize` | `13` | px. |
| `initialTab` | last used | Session id to open first. |
| `title` | `'Terminal'` | The iframe's accessible name. |

### Handle

| Method | |
|---|---|
| `on(event, fn)` | Returns an unsubscribe function. |
| `focus()` | Focus the terminal. |
| `setVisible(bool)` | Pause the stream while your panel is hidden. |
| `setTheme(theme)` | |
| `selectTab(sid)` · `createTab(name?)` · `renameTab(sid, name)` · `closeTab(sid)` | Promises; reject with the server's reason. |
| `paste(text)` | Put `text` on the active tab's input line, without Enter. Promise. Needs `terminal.write`. Bracketed when the program asked for it (Claude Code, zsh, bash), so a newline does not submit; multi-line text is refused otherwise. Rejects text over 4 KB (UTF-8) and any control character but tab and newline — ESC included, so it cannot end the paste early or send keys. `TtymEmbed.version >= 2`. |
| `destroy()` | Remove the iframe. |

| Event | Detail |
|---|---|
| `ready` | `{ tabs, active, access, canWrite, canTabs }` |
| `tabs` | `{ tabs: [{ sid, name, status, createdAt }], active }` — after any change, from any browser |
| `active` | `{ sid }` |
| `exit` | `{ sid }` — a shell ended |
| `bell` | `{ sid }` |
| `auth` | `{ reason }` — the grant was refused or ended; the SDK is asking `grant` again |
| `connected` · `disconnected` | |

### Your own tab bar

```js
const t = TtymEmbed.mount(el, { base: '/studio', grant, chrome: 'none' });
t.on('tabs', ({ tabs, active }) => renderMyTabs(tabs, active));
myTabs.onSelect = (sid) => t.selectTab(sid);
myTabs.onAdd = () => t.createTab();
```

### Without the SDK

The panel also works as a plain iframe:

```html
<iframe src="/studio/embed/v1/#g=GRANT&theme=light&chrome=none"></iframe>
```

Fragment keys: `g` (required), `ws` or `s`, `theme`, `chrome`, `font`, `tab`. The
panel removes the fragment from the address bar on load. With no SDK it cannot
renew its grant, so it stops when the grant ends.

## Tab API

The panel uses these (main port); call them yourself only if you draw your own terminal.
`Authorization: Bearer <grant>`; from a browser, Origin must be a registered one.

```http
GET    /api/embed/v1/grant                          what this grant reaches, until when
GET    /api/embed/v1/workspaces/:ws/tabs            terminal.read   { tabs }
POST   /api/embed/v1/workspaces/:ws/tabs {name?}    tabs.write      { tab, tabs }   409 tab_limit
PATCH  /api/embed/v1/workspaces/:ws/tabs/:sid {name} tabs.write     { tabs }        409 member_name_taken
DELETE /api/embed/v1/workspaces/:ws/tabs/:sid       tabs.write      { tabs }        the shell ends
```

Tab mutations run one at a time per workspace. Listing drops tabs whose shell
has ended; with a `keepOne` profile and `tabs.write` it opens one if none is left.

## What a grant connection never gets

The panel's WebSocket (`/embed/v1/ws`) accepts nothing until a valid grant
arrives in the first frame, loopback or not, and closes after 10 s without one.
After that:

- Frames for sessions outside the grant are dropped (an attach gets `ok: false`).
- Creating or destroying sessions over the socket, and stopping a process, are refused.
- Server pushes are filtered: workspace changes only for the granted workspaces;
  agent state, viewer tabs and config never. Viewer pushes carry file
  capabilities and paths, and config is the owner's.
- Commands added to ttym later are refused on grant connections until they are
  given a rule (`packages/server/src/embed/authorize.ts`).

## Compatibility

| Surface | Promise |
|---|---|
| `/api/embed/v1/*`, the grant and tab shapes | Fields are only added. A removal or change of meaning goes to `/v2`. Mint and revoke stay on the admin listener. |
| `sdk.js`: mount options, methods, events | Only added. A breaking change is a new path (`/embed/v2/`). |
| Fragment keys | Only added. |
| Capability names | Meanings never change. A new capability is never added to existing registrations or grants. |
| The panel's WebSocket frames, DOM, and its messages to the SDK | Not a contract. The panel and server ship together. |

`GET /api/version` reports `embed: { api, sdk }`. Clients ignore response
fields they do not know; ttym rejects capabilities it does not know.
