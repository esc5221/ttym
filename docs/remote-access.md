# Remote access

Reach this machine's ttym from a phone or another computer.

## For agents

If you are an agent asked to "set up remote access for ttym":

1. Run `ttym remote doctor --json`. It reports the current state; `ok: true`
   with no allowed hosts means remote access is off and safe.
2. Pick a path. **Tailscale is the default.** Use Cloudflare only if the user
   asks for a public URL on their own domain.
   - `ttym remote tailscale --json`
   - `ttym remote cloudflare --host <host> --email <email> --json` (preview with `--dry-run` first — it creates a tunnel, a DNS record and an Access app)
3. Read `steps[]`. For each step:
   - `ok` / `changed`: done.
   - `fail`: run `fix` if it is a command, then re-run the same setup command.
   - `human`: tell the user what `detail` says and give them `url`. Wait until
     they confirm, then re-run the same setup command. Finished steps come back
     `ok`; nothing is created twice.
4. On `ok: true` the JSON has `link` (one-time login URL, 10 minutes) and
   `next`. Give both to the user. The link logs in one browser; mint another
   with `ttym remote link --json`.

Every `ttym remote` command is non-interactive, takes `--json`, and is safe to
re-run. Never print the Cloudflare API token; read it from the environment or
`~/.ttym/cloudflare-token`.

## How access works

ttym listens on `127.0.0.1` only. Local callers (the CLI, agent hooks, the web
UI on `localhost`) need no login. Every request that did not originate on this
machine — through a tunnel, `tailscale serve`, or the LAN — must:

- name a host in the allow-list (`ttym remote allow-host <host>`), and
- carry a login cookie, which a browser gets by opening a one-time link from
  `ttym remote link`.

The allow-list and signed-in browsers live in `~/.ttym/remote.json` (0600,
tokens stored as hashes). Only local callers can change them. Signed-in
browsers last 30 days; `ttym remote sessions` lists them and
`ttym remote revoke <id>|--all` signs them out.

Locally, the server also refuses writes and WebSocket connections from other
websites (Origin check) and requests for unknown host names (DNS rebinding).
No setup needed.

## Path 1 · Tailscale (recommended)

Only devices signed in to your tailnet can reach the URL, and Tailscale issues
the HTTPS certificate. No domain, no port forwarding.

```sh
ttym remote tailscale
```

What it does: finds the `tailscale` CLI, checks that this machine is signed in,
runs `tailscale serve --bg --https=443 http://127.0.0.1:7690`, allows
`<machine>.<tailnet>.ts.net`, verifies the URL asks for a login, and prints a
login link with a QR code.

What you do, once:

| Step | Where |
|---|---|
| Install Tailscale on this machine and sign in | https://tailscale.com/download |
| Turn on **HTTPS Certificates** (DNS page of the admin console) | https://login.tailscale.com/admin/dns |
| Install Tailscale on the phone, same account | App Store / Play Store |

Then open the printed link on the phone.

`tailscale funnel` would put the same URL on the public internet. Don't use
it for ttym.

## Path 2 · Cloudflare Tunnel + Access

A URL on your own domain (`ttym.example.com`) that works from any browser
without an app. Cloudflare Access sits in front: visitors prove their email
with a one-time PIN before they reach ttym, and then ttym asks for its own login.

### With the API (one command)

You need: the domain on Cloudflare, Zero Trust enabled once on the account
(https://one.dash.cloudflare.com/ → pick a team name, Free plan), `cloudflared`
installed, and an API token with:

- Account · Cloudflare Tunnel · Edit
- Account · Access: Apps and Policies · Edit
- Zone · DNS · Edit

```sh
export CLOUDFLARE_API_TOKEN=…          # or save it to ~/.ttym/cloudflare-token (chmod 600)
ttym remote cloudflare --host ttym.example.com --email you@example.com --dry-run
ttym remote cloudflare --host ttym.example.com --email you@example.com
```

It creates a remotely-managed tunnel `ttym-<host>`, routes the host to
`127.0.0.1:7690`, adds a proxied CNAME, creates an Access app that allows your
email, and installs the connector as a user service (launchd
`com.ttym.cloudflared.<id>` / systemd `ttym-cloudflared-<id>.service`) that
reads its token from `~/.ttym/cloudflared-<id>.token`. Then it allows the host,
checks that the URL demands a login, and prints a link.

If the host already has a DNS record, the command stops and changes nothing.
Keep the existing route with `ttym remote allow-host <host>`, or move it to
the new tunnel with `--replace-dns`.

### By hand

```sh
cloudflared tunnel login                              # browser: pick the domain
cloudflared tunnel create ttym
cloudflared tunnel route dns ttym ttym.example.com
```

`route dns` reports success even when a CNAME for that name already exists and
points elsewhere. Check the record in the dashboard.

`~/.cloudflared/ttym.yml`:

```yaml
tunnel: <tunnel-id>
credentials-file: /Users/you/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: ttym.example.com
    service: http://127.0.0.1:7690
  - service: http_status:404
```

Create the Access app before the tunnel goes live: Zero Trust → Access →
Applications → Self-hosted → `ttym.example.com`, policy Allow → your email.
Without it, ttym's login page is exposed to the internet.

```sh
cloudflared --config ~/.cloudflared/ttym.yml service install
ttym remote allow-host ttym.example.com
ttym remote doctor https://ttym.example.com            # want: "Cloudflare Access login first"
ttym remote link
```

Cloudflare drops WebSockets that carry no data for ~100 s. ttym pings every 30 s,
so nothing to configure.

## Path 3 · SSH port forward

No setup on the server side. From the other computer:

```sh
ssh -L 7690:127.0.0.1:7690 you@machine
open http://localhost:7690
```

The request arrives as local, so no login is asked. Awkward on a phone.

## Not recommended · LAN

```sh
TTYM_BIND=0.0.0.0 ttym restart
ttym remote allow-host 192.168.0.10     # the address other devices use
ttym remote link
```

Traffic, including the login cookie, crosses the network in plain HTTP. Anyone
on the same Wi-Fi can read it.

## Turning it off

```sh
ttym remote off                          # forget all hosts, sign every browser out
tailscale serve reset                    # Tailscale: stop serving (clears all serve config)
```

With no allowed hosts, anything still pointing at the machine gets 403.
