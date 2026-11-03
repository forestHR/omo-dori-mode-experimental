# herdr web

A Dori on herdr has no web dashboard of its own: herdr 0.9.5 has no web UI, aoe's web frontend reads aoe's session
store rather than herdr's socket, and doriface needs herdr-core's `hc`. This directory gives the same kind of access a
Dori had with `aoe serve`: a browser on the tailnet logs in with the same passphrase, sees the session list, opens a
session and types into it.

It runs plain `herdr` inside ttyd 1.7.7, with a small Bun HTTP/WebSocket cookie-login proxy (`proxy.ts`) in front. The
TUI talks to the account's own default `~/.config/herdr/herdr.sock`, so browser terminals are clients of the account's
server, not a second session store, and closing a browser leaves the sessions running. ttyd needs `--writable`; without
it keyboard input is disabled. ttyd's HTML gets a viewport declaration, so phone browsers use their real width.

The proxy reuses `AOE_SERVE_PASSPHRASE` from `~/.config/agent-of-empires/serve.env`. It does not copy or log the
passphrase. It binds loopback only. On login it sets a random token, valid for the life of the proxy process, in a
cookie named `herdr_session_<front-port>`, with HttpOnly, Secure, SameSite=Strict and Path=/. Cookies have no port scope,
so several Dori on one host each need a cookie with its own name. Restarting the proxy logs everyone out. Requests and
WebSocket upgrades without the cookie get the login page. The Origin must equal `HERDR_WEB_ORIGIN` exactly. ttyd is
never exposed to the tailnet directly. This is a shell as the account owner, not a multi-user boundary: only trusted
tailnet users should reach it.

## Units

- `herdr-web-terminal@<front-port>.service` (user): ttyd on `127.0.0.1:$HERDR_TTYD_PORT` running `herdr`.
- `herdr-web@<front-port>.service` (user): the proxy on `127.0.0.1:<front-port>`. It requires the terminal unit.

Both read `~/.config/herdr/web-<front-port>.env` (mode 0600):

```ini
HERDR_TTYD_PORT=<a free loopback port>
HERDR_WEB_ORIGIN=https://<this host's tailnet name>[:<https port>]
```

## Deploy

1. Install Bun at `~/.bun/bin/bun`, herdr at `~/.local/bin/herdr`, and ttyd 1.7.7 (the release binary for the host's
   architecture) as `~/.local/bin/ttyd`. If they live elsewhere, adjust ExecStart.
2. Copy both unit templates into `~/.config/systemd/user/`, write the env file, then run
   `systemctl --user daemon-reload`. Do not set `XDG_CONFIG_HOME`: the terminal must reach the account's own herdr
   server.
3. Read `tailscale serve status --json`. Keep its HTTPS listener, certificate and ACL as they are. The front port is
   the one `aoe serve` (or its cookie proxy) listens on today, so the route usually stays unchanged.
4. At the cutover, stop the account's aoe serve unit and any cookie proxy that owns the front port, then
   `systemctl --user enable --now herdr-web@<front-port>.service`.
5. Check at the real address, at a desktop and a phone size: log in with the old passphrase, see the sidebar, open a
   tab, type a harmless line, then close and reopen the browser and find the session still there. Disable the aoe units
   only after this passes.

Rollback: stop and disable `herdr-web@<front-port>` and its terminal unit, start the old aoe units again, and restore
any Tailscale target you changed.

An account whose own loopback egress is blocked (a gated account) cannot reach its ttyd from a proxy it runs itself.
Run its terminal unit as that account and the proxy as a system unit under the account the gate allows. That system
unit reads the gated account's env and passphrase files before dropping privileges. This is host configuration, so it
belongs in the host's own setup, not here.

## Test

```sh
bun test skills/dori-mode/setups/herdr-web/proxy.test.ts
```

Browser QA uses a temporary XDG_CONFIG_HOME, a task-owned browser profile, a test passphrase and ephemeral loopback
ports, never the ports a Dori serves on. Secure cookies work on browser-trusted loopback HTTP for that test. A deployed
Dori is always reached over Tailscale HTTPS.
