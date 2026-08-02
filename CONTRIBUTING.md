# Contributing to RockWorx Duo

RockWorx Duo is an open-source contribution from [RockWorx](https://github.com/RockWorx), shared in the
spirit of power-factor Human-AI collaboration. Feedback and contributions are genuinely welcome.

## Ways to help

- **Report a bug** — open a [Bug report](../../issues/new?template=bug_report.yml).
- **Request a feature** — open a [Feature request](../../issues/new?template=feature_request.yml).
- **Ask or share** — start a [Discussion](../../discussions): questions, ideas, or "show & tell" for a
  plugin you built.
- **Build a plugin** — the seam is a directory drop; see [`docs/PLUGINS.md`](docs/PLUGINS.md). The
  bundled `plugins/local-models/` is a copy-paste template.
- **Send a pull request** — for fixes and improvements (see below).

## Pull requests

1. Keep changes focused — one topic per PR.
2. The **core stays dependency-light** (Python stdlib + `websockets`, plus `pywinpty` on Windows). Domain
   features belong in **plugins**, not the core.
3. Test on your platform and note your OS + Python version.
4. Be kind. This is a small project built in the open.

## Security

Please report vulnerabilities **privately** via
[GitHub Security Advisories](../../security/advisories/new) or `mike@rockworx.io` — **not** as a public
issue. See [`docs/SECURITY.md`](docs/SECURITY.md).
