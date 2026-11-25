# Security model

RockWorx Duo is a **local developer tool**. It runs an HTTP server on your machine that can spawn
terminals and read/write files in the workspace. Treat it like any local dev server.

## What the core enforces

- **Loopback bind by default.** The HTTP + WebSocket servers bind to `127.0.0.1` only. They never bind
  `0.0.0.0` or a public interface.
- **Tailnet listener: opt-in, off by default.** See [Remote access over Tailscale](#remote-access-over-tailscale-opt-in).
  Without an explicit opt-in the server does not query Tailscale and does not listen on a tailnet address.
- **Session token.** A random token is generated for each run. The UI obtains it from `/api/config`, which
  answers only:
  - a request from a **loopback** client (`127.0.0.1` / `::1`), or
  - a request whose `Origin` is in the allow-list (below).

  A request with **no `Origin` from any other address gets `403`**, and so does a no-`Origin` request that a local
  reverse proxy forwarded (it carries `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Real-IP` or
  `Tailscale-User-Login`). Every other API call and the terminal WebSocket require the token. The static UI
  files (HTML, JS, CSS, icons) are served without it. The token is not printed at startup.
- **Origin / Host allow-list.** Requests from unexpected Origins or Hosts are rejected -- defense against
  a random web page poking `localhost` (i.e. session hijacking from another browser tab). The allow-list is
  `http://127.0.0.1:<port>` and `http://localhost:<port>`; tailnet origins are added only when the tailnet
  listener is opted in. The terminal WebSocket handshake needs the token and an allowed `Origin`; a
  handshake without an `Origin` is accepted only from a loopback client.
- **Exclusive port bind.** The port is claimed outright (no address reuse), so another process can't
  bind the same port and shadow your session.
- **Path jail.** File, transcript, and plugin-asset serving is confined to the workspace / plugin
  directory; `../` escapes, drive switches, and hidden files are blocked.

Any program running on your machine can reach the loopback port and obtain the token, just as it could
read your files. The local user account is the trust boundary.

## Remote access over Tailscale (opt-in)

Off by default. To reach the harness from another device on your own tailnet, opt in before starting the
server:

| Variable | Effect |
|---|---|
| `HARNESS_TAILNET=1` | Opt in. The server asks the Tailscale CLI for this machine's tailnet address (in `100.64.0.0/10`) and name, and listens on that address **as well as** `127.0.0.1`. |
| `HARNESS_TAILNET_BIND=<address>` | Opt in with an explicit tailnet address instead of asking Tailscale. |
| `HARNESS_TAILNET_HOST=<name>` | Opt in with an explicit tailnet DNS name (used for the Origin / Host allow-list). |
| `HARNESS_NO_TAILNET=1` | Force the tailnet listener off, overriding all of the above. |

When the tailnet listener is on, **every device on your tailnet can reach the server**, and a page or
client that presents the tailnet `Origin` receives the session token. The tailnet is then the trust
boundary, so opt in only on a tailnet that you alone control, and never expose the port to the public
internet (for example with a public funnel or port forward). If Tailscale is not installed or not running,
the server stays loopback-only.

## Plugins are trusted local code

Plugins run **in-process** -- their `backend.py` executes as Python in the server, and their `panel.js`
runs in the harness page. There is **no sandbox** (by design -- like editor extensions). A plugin can
do anything your user account can.

**Install only plugins you trust and have read.** The directory-drop model has no registry, signing, or
auto-update; you add plugins deliberately by copying a directory in.

## Reporting

This is early software. If you find a security issue, please report it **privately** -- use the repo's
**Security -> Report a vulnerability** (GitHub security advisories) rather than a public issue. Avoid
posting a live exploit against others.
