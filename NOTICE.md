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

## CLI stack (runtime dependencies)

The non-TUI command line is built on these MIT-licensed packages (colour and tables
are Kubic's own output kit, `packages/core/src/ui` and `packages/core/src/cli`), declared
with exact pins in the root `package.json` (the manifest that owns the
`kubic` bin and the `dist/` build):

- `commander` and `@commander-js/extra-typings` — argv parsing, commands, help
- `consola` — leveled logging
- `@clack/prompts` — interactive prompts and spinners

Their transitive dependencies are MIT as well; `scripts/license.test.mjs`
fails CI if any shipped (non-dev) package in `package-lock.json` carries a
non-permissive licence.

## TUI code highlighting (runtime dependency)

Fenced code in `kubic tui` answers is highlighted with (issue #458):

- `lowlight` (MIT) — highlight.js grammars as a syntax tree, loaded when the
  TUI starts
- `highlight.js` (BSD-3-Clause, a dependency of `lowlight`) — the grammars

Both ship their licence texts under `node_modules/`.

The `pi/` read-only reference clone used during design (see `README.md`) is
upstream code, gitignored, and not part of Kubic — it must be absent from any
published tree (see `docs/publish-checklist.md`).
