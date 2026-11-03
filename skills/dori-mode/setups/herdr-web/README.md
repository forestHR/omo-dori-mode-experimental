# herdr web

A Dori on herdr has no web dashboard of its own: herdr 0.9.5 has no web UI, aoe's web frontend reads aoe's session
store rather than herdr's socket, and doriface needs herdr-core's `hc`. This directory gives the same kind of access a
Dori had with `aoe serve`: a browser on the tailnet logs in with the same passphrase, sees the session list, opens a
session and types into it.

It runs plain `herdr` inside ttyd 1.7.7, with a small Bun HTTP/WebSocket cookie-login proxy (`proxy.ts`) in front. The
TUI talks to the account's own default `~/.config/herdr/herdr.sock`, so browser terminals are clients of the account's
server, not a second session store, and closing a browser leaves the sessions running. ttyd needs `--writable`; without
it keyboard input is disabled. Each new browser terminal first reads `leadPane` through Dori's config loader
(`DORI_CONFIG`, with `DORI_LEAD_PANE` overriding it), focuses that pane's tab, then attaches to herdr.
Set `DORI_CONFIG` in the terminal unit's environment file when the account uses a non-default config.

The terminal page has a wrapping pane-state bar, including the focused tab, above the terminal. Labels and states stay
visible on phones; the terminal is resized to the remaining height. Its cookie-protected `GET /__dori/state` polls every
three seconds. A state helper running as the terminal account shares one pending collection across clients and caches
its result for two seconds after collection completes. It reuses `herdrSessions` and `paneActivity`: agent screens are read
through `herdrLife`/`herdrRead`, mapping busy/running to working, questions/waiting/errors to waiting, idle to idle,
and panes without an agent to none. Herdr's own agent status is not used to judge omo.

The proxy takes the passphrase from `HERDR_WEB_PASSPHRASE` in its env file below; when that is unset it reuses
`AOE_SERVE_PASSPHRASE` from `~/.config/agent-of-empires/serve.env` (optional, so an account that never ran aoe needs no
aoe file), so a Dori that moved from aoe logs in with its old passphrase. It does not copy or log the passphrase. It binds loopback only. On login it sets a random token, valid for the life of the proxy process, in a
cookie named `herdr_session_<front-port>`, with HttpOnly, Secure, SameSite=Strict and Path=/. Cookies have no port scope,
so several Dori on one host each need a cookie with its own name. Restarting the proxy logs everyone out. Requests and
WebSocket upgrades without the cookie get the login page. The Origin must equal `HERDR_WEB_ORIGIN` exactly. ttyd is
never exposed to the tailnet directly. This is a shell as the account owner, not a multi-user boundary: only trusted
tailnet users should reach it.

## Units

- `herdr-web-terminal@<front-port>.service` (user): ttyd on `127.0.0.1:$HERDR_TTYD_PORT` running `herdr`.
- `herdr-web-state@<front-port>.service` (same user as the terminal): the state helper on
  `127.0.0.1:$HERDR_STATE_PORT`. The terminal unit starts it and propagates stops/restarts to it.
- `herdr-web@<front-port>.service` (user): the proxy on `127.0.0.1:<front-port>`. It requires the terminal unit.

All three read `~/.config/herdr/web-<front-port>.env` (mode 0600):

```ini
HERDR_TTYD_PORT=<a free loopback port>
HERDR_WEB_ORIGIN=https://<this host's tailnet name>[:<https port>]
# only on an account without aoe's serve.env (a fresh install); a moved Dori leaves it out and keeps its aoe passphrase
HERDR_WEB_PASSPHRASE=<a passphrase, for example from openssl rand -hex 16>
HERDR_STATE_PORT=<another free loopback port, distinct from ttyd and front ports>
HERDR_STATE_SECRET=<a random shared secret, for example from openssl rand -hex 32>
```

The helper is the single state source in both same-account and split-account deployments. It accepts only a
secret-authenticated `GET /state`; browser cookies do not authorize it. The proxy supplies the shared secret server-side
and never sends it to the browser. Keep this port loopback-only; do not add a public route to it.

When upgrading an existing deployment, add the two `HERDR_STATE_*` values to the env file, install the new state unit
and updated terminal unit, run `systemctl --user daemon-reload`, then restart the terminal and proxy units. Starting the
terminal automatically starts the helper; do not enable a second helper under the proxy account.

## Skip the first-run welcome

For each Dori account, set this **top-level** key (before any `[section]`) in its existing
`~/.config/herdr/config.toml`:

```toml
onboarding = false
```

This is a documented account-config step, not a unit override or a second herdr config. In herdr 0.9.5,
`src/config.rs::should_show_onboarding` treats a missing key as true. Continuing the welcome writes false to
the client's local config (`src/client/shell/overlay_input.rs::complete_onboarding`) and opens integration settings.
A browser disconnected before continuing therefore sees it again on the next terminal. The next web terminal
reads the setting at attachment; existing panes and their server do not need to be restarted.

## Deploy

1. Install Bun at `~/.bun/bin/bun`, herdr at `~/.local/bin/herdr`, and ttyd 1.7.7 (the release binary for the host's
   architecture) as `~/.local/bin/ttyd`. If they live elsewhere, adjust ExecStart.
2. Copy all three unit templates into `~/.config/systemd/user/`, write the env file, then run
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
belongs in the host's own setup, not here. Keep the state helper in the **terminal account's** user manager: the terminal
unit's dependency starts it there, where its herdr socket and agent process tree belong. The system proxy must read the
same `HERDR_STATE_PORT` and `HERDR_STATE_SECRET` from the terminal account's env file before dropping privileges. It only
makes an authenticated loopback request to that helper; it never runs herdr or queries the proxy account's server.
Reload/restart the terminal account's user units and restart the separately managed system proxy after upgrading.

## Test

```sh
bun test skills/dori-mode/setups/herdr-web
```

The split-account test uses separate helper/proxy processes with different HOME, XDG_CONFIG_HOME and fake herdr data.
The delayed-runner tests advance a fake clock while a collection is unresolved; they use no sleeps.

Browser QA uses a temporary XDG_CONFIG_HOME, a task-owned browser profile, a test passphrase and ephemeral loopback
ports, never the ports a Dori serves on. Secure cookies work on browser-trusted loopback HTTP for that test. A deployed
Dori is always reached over Tailscale HTTPS.
