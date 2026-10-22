# Third-party notices

Kubic itself is MIT-licensed — see [LICENSE](LICENSE) (Copyright (c) 2026 Konic Labs).

## Pi agent harness (runtime dependency)

Kubic's agent runtime is built on the Pi agent harness by Mario Zechner
(earendil-works), MIT-licensed:

- `@earendil-works/chord`
- `@earendil-works/pi-ai`
- `@earendil-works/pi-durable`
- `@earendil-works/pi-telemetry`
- `@earendil-works/pi-tui`

Upstream: <https://github.com/earendil-works/pi>. Each package is a direct
dependency pinned to an exact version in the root `package.json`, the manifest
npm installs, and ships its own MIT licence text under
`node_modules/@earendil-works/*/`.

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

Fenced code in `kubic tui` answers is highlighted with:

- `lowlight` (MIT) — highlight.js grammars as a syntax tree, loaded when the
  TUI starts
- `highlight.js` (BSD-3-Clause, a dependency of `lowlight`) — the grammars

Both ship their licence texts under `node_modules/`.
