# Security model

RockWorx Duo is a **local developer tool**. It runs an HTTP server on your machine that can spawn
terminals and read/write files in the workspace. Treat it like any local dev server.

## What the core enforces

- **Local bind only.** The HTTP + WebSocket servers bind to `127.0.0.1`, never a public interface.
- **Session token.** Every request must carry the token printed at startup. Requests without it are
  rejected.
- **Origin / Host allow-list.** Requests from unexpected Origins or Hosts are rejected -- defense against
  a random web page poking `localhost` (i.e. session hijacking from another browser tab).
- **Exclusive port bind.** The port is claimed outright (no address reuse), so another process can't
  bind the same port and shadow your session.
- **Path jail.** File, transcript, and plugin-asset serving is confined to the workspace / plugin
  directory; `../` escapes, drive switches, and hidden files are blocked.

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
