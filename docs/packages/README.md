# Package pages

One page per package. Each page
documents its package's public API, contracts, and dep-direction
neighbours — no architecture rationale, no CLI usage.

- [core.md](core.md) — `packages/core`
- [exec.md](exec.md) — `packages/exec`
- [agent.md](agent.md) — `packages/agent`
- [host.md](host.md) — `packages/host`
- [trajectory.md](trajectory.md) — `packages/trajectory`
- [eval.md](eval.md) — `packages/eval`
- [tui.md](tui.md) — `packages/tui`

## Import rule

A package's public API is its `exports` map in `packages/<name>/package.json`.
It lists one explicit subpath for each module that another package imports, and
each subpath maps to that module's `src/*.ts` file. A module the map does not
list is internal to its package.

- **Import by name.** Another package is imported as `@kubic/<pkg>/<subpath>`,
  for example `@kubic/core/cli/prompt`. A relative path that leaves the
  importing package (`../../core/src/...`) is a violation: `npm run lint:deps`
  (`scripts/dep-lint.mjs`) fails on it, root-level code included.
- **Unlisted modules do not resolve.** The typecheck resolves `@kubic/*` through
  the npm workspace links and the exports maps under the `source` condition
  (`customConditions` in `tsconfig.base.json`), so importing a module the map
  does not list is a type error. vitest (`vitest.config.ts`) and the bundle
  (`scripts/build.mjs`) select the same condition.
- **Expose a module on purpose.** Add its subpath to the exports map, with the
  `source` and `default` targets naming the same `src/*.ts` file, and import
  it by subpath. knip (`npm run lint:dead`) reports an export that nothing uses,
  so the public surface stays as small as its users.
- **Test support.** The `test-support/*` subpaths are test scaffolding. Only test
  files and other `test-support/` modules may import them.
- **Root tooling.** The shared fixtures in `test/` belong to no package. Package
  tests reach them by relative path, and the root code imports packages by name.
- **`@kubic/cli`** (`apps/kubic`, the composition root) exports nothing. It is
  built from `apps/kubic/src/main.ts` into `dist/kubic.js`, not imported.

## Import direction (matches `scripts/dep-lint.mjs`)

One-way dependencies: packages may only import "downward". The diagram
below summarizes the allowed direction — the allowlist itself lives in
`scripts/dep-lint.mjs` (`npm run lint:deps`); if the two disagree, the
lint governs.

```text
@kubic/core         ← imports nothing internal; imported by all
@kubic/exec         ← core
@kubic/trajectory   ← core
@kubic/agent        ← core, exec
@kubic/eval         ← core, trajectory
@kubic/host         ← core, exec, agent, trajectory, eval
@kubic/tui          ← core only (never host/agent implementation)
apps/kubic          ← composition root: wires host + tui together
```

I/O confinement (component split; enforced by
`scripts/dep-lint.mjs`): only `@kubic/exec` touches
`node:fs`/`node:child_process`, with test scaffolding exempt. Pi seams:
`@kubic/agent` via `src/pi-boundary.ts` only, `@kubic/tui` via
`src/tui-boundary.ts` only.

## Public API per package

The subpaths each package's exports map lists, which are the modules other
packages import. The count is the number of subpaths; each one is the module's
path under `src/` without its extension.

### `@kubic/core` (21)

`cli/exit-codes`, `cli/kit`, `cli/logger`, `cli/output`, `cli/prompt`, `cli/spinner`, `cli/table`, `cli/theme`, `cli/width`, `license`, `presentation`, `run-role`, `secret-keys`, `secret-refs`, `secret-shapes`, `suggest`, `ui/color`, `ui/glyphs`, `ui/style`, `ui/theme-file`, `ui/tokens`

### `@kubic/exec` (16)

`env`, `file-bridge`, `git-clean`, `ignore`, `journal`, `journal-diff`, `journal-reconcile`, `journal-status`, `journal-undo`, `lock-file`, `read-roots`, `runtime-exclude`, `secret-runner`, `stdin`, `test-support/env-fakes`, `test-support/git-sandbox`

### `@kubic/agent` (29)

`compaction`, `lane/abort`, `lane/boot`, `lane/events`, `lane/failures`, `lane/interceptors`, `lane/pending`, `lane/policy`, `lane/session-fs`, `lane/session-store`, `lane/settle`, `lane/test-harness`, `lane/transcript`, `lane/turn`, `lane/wrap`, `model-select`, `models-config`, `ops/display-diff`, `ops/git`, `ops/memos`, `ops/registry`, `ops/types`, `ops/walk`, `permissions`, `pi-boundary`, `prompts`, `skills/skills`, `stream-options`, `test-support/models-fixtures`

### `@kubic/host` (18)

One entry per concern folder (see [host.md](host.md#layout-packageshostsrc)):

`approvals`, `audit`, `cli`, `config`, `cost`, `doctor`, `git`, `journal`, `models`, `policy`, `presentation`, `replay`, `roles`, `run`, `secret-refs`, `sessions`, `skills`, `test-support/audit-fixtures`

### `@kubic/trajectory` (2)

`export`, `schema`

### `@kubic/eval` (8)

`cli`, `export-cli`, `rl/preference`, `rl/verifier`, `runner`, `signals`, `suites`, `test-support/fixtures`

### `@kubic/tui` (19)

`approval-surface`, `attachments`, `chrome`, `editor-frame`, `keybindings`, `lane-cells`, `layout`, `preflight`, `screen`, `slash-commands`, `status-bar`, `theme`, `transcript`, `tree`, `tui-app`, `tui-boundary`, `ui/clipboard`, `ui/highlight`, `ui/palette`

Back to the [docs index](../README.md).
