# Package pages

One page per package. Each page names the package's entry points, the
invariants it keeps and its neighbours; architecture rationale and CLI
usage live elsewhere.

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

I/O confinement, also enforced by `scripts/dep-lint.mjs`: only
`@kubic/exec` touches `node:fs` and `node:child_process`, with test
scaffolding exempt. Pi seams: `@kubic/agent` through `src/pi-boundary.ts`
only, `@kubic/tui` through `src/tui-boundary.ts` only.

Back to the [docs index](../README.md).
