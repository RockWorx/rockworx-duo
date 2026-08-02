# Security model

Agent Harness is a **local developer tool**. It runs an HTTP server on your machine that can spawn
terminals and read/write files in the workspace. Treat it like any local dev server.

## What the core enforces

- **Session token.** Every request must carry the token printed at startup. Requests without it are
  rejected.
- **Origin / Host allow-list.** Requests from unexpected Origins or Hosts are rejected (defense against
  a random web page poking `localhost`).
- **Path jail.** File and plugin-asset serving is confined to the workspace / plugin directory;
  `../` escapes, drive switches, and hidden files are blocked.

## Plugins are trusted local code

Plugins run **in-process** -- their `backend.py` executes as Python in the server, and their `panel.js`
runs in the harness page. There is **no sandbox** (by design -- like editor extensions). A plugin can
do anything your user account can.

**Install only plugins you trust and have read.** The directory-drop model has no registry, signing, or
auto-update; you add plugins deliberately by copying a directory in.

## Reporting

This is early software. If you find a security issue, open an issue describing it (avoid posting a live
exploit against others).
