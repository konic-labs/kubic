# Third-party notices

Kubic itself is MIT-licensed — see [LICENSE](LICENSE) (Copyright (c) 2026 Konic Labs).

## Pi agent harness (reference + runtime dependency)

Kubic's worker runtime is built on the Pi agent harness by Mario Zechner
(earendil-works), MIT-licensed:

- `@earendil-works/chord`
- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-ai`
- `@earendil-works/pi-protocol`
- `@earendil-works/pi-telemetry`
- `@earendil-works/pi-tui`

Upstream: <https://github.com/earendil-works/pi>. Pinned versions and their
licences are recorded in `package-lock.json`; each package ships its own MIT
licence text under `node_modules/@earendil-works/*/`.

The `pi/` read-only reference clone used during design (see `README.md`) is
upstream code, gitignored, and not part of Kubic — it must be absent from any
published tree (see `docs/publish-checklist.md`).
