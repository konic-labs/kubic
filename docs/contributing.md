# Contributing

> How to build, test and change Kubic, and the checks every change passes.

Kubic is a model-agnostic terminal coding agent with a VCS-independent
change journal. Kubic has no isolation — never imply otherwise in
code, docs, or CLI text.

## Getting set up

Node >= 22.19 is the only requirement:

```sh
npm ci
npm run build                # esbuild bundle -> gitignored dist/kubic.js
./bin/kubic.js --version
```

Kubic runs on the Pi agent harness (`@earendil-works/*` **1.0.2**, exact
pins), installed from npm like every other dependency.

## Before you push

Three commands cover everything CI runs:

```sh
npm run check                         # every static gate, listed below
npm test                              # the vitest suite: unit and integration tests
npm run build && npm run test:binary  # the built binary's contract and the faux smoke
```

`npm run check` runs, in this order:

```sh
npm run typecheck        # tsc --noEmit: typecheck only, no emit
npm run lint             # biome ci: formatting and lint, exact CI parity
npm run lint:deps        # import rules: package direction, seams, test fixtures
npm run lint:dead        # knip: unused files, exports, dependencies, types
npm run lint:dead:prod   # knip on production code only: test imports count as no use
npm run check:pins       # exact pins on every dependency
npm run docs:check       # no dangling internal doc links; generated config docs current
npm run check:gates      # the repo gates and the scripts' own tests (node --test)
```

`npm run docs:config` regenerates the config docs and `example.toml` from the
config schema. `npm run test:coverage` runs the suite with v8 coverage of the
product sources: the floors in `vitest.config.ts` (statements, branches,
functions, lines) fail a run that drops below them, and the HTML report lands
in the gitignored `coverage/`.

`npm run test:binary` (`scripts/binary-contract.mjs`, then
`scripts/faux-smoke.mjs`) is the install-story gate: with `dist/` built it
asserts the exact `kubic <version> (license: MIT)` line (exit 0), `kubic
doctor` exiting 6 with `FAIL limit:provider-availability (provider-down)`,
and a provider-less `kubic run -p` exiting 6 while still printing the
`session:`/`journal:`/`usage:`/`trajectory:` refs, then drives a full faux
run through the binary. It is hermetic — the probes run under a temp `HOME`
with no `models.json` in the cwd, so no provider and no network.

## Repo scripts

The gates use standard tools where one fits (TypeScript, biome, knip, vitest).
The scripts under `scripts/` cover what those tools cannot, each with its own
`*.test.mjs` beside it:

| Script | Why it exists |
| --- | --- |
| `build.mjs` | Bundles Kubic's own code into `dist/kubic.js` with esbuild. Third-party packages stay external, and a bare import that no manifest declares fails the build. |
| `binary-contract.mjs` | Runs the built binary: only the shipped artifact proves its exit codes, its startup output and the purity of its `--json` output. |
| `faux-smoke.mjs` | Drives the built binary through a whole faux-provider run with a tool call. |
| `dep-lint.mjs` | The import rules: package direction, no relative import across packages, test fixtures in tests only, `node:fs`/`node:child_process` only in `exec`, the two Pi boundary files, a host concern folder reached through its `index.ts`, and one argv parser. It reads `vi.mock` specifiers as imports too. dependency-cruiser, the standard tool, cannot parse TypeScript 7 sources. |
| `check-pinned-deps.mjs` | Every dependency in every manifest is one exact version. `.npmrc` sets `save-exact=true` for new installs; the check catches a hand edit. |
| `check-docs-links.mjs` | Every relative link in `docs/` resolves, with no dependency to install. |
| `gen-config-docs.mjs` | Generates the config key tables and `example.toml` from the config schema; `--check` fails when they are stale. |
| `pi-boundary.test.mjs` | The Pi dependency contract: exact Pi pins, one hoisted copy of each Pi package in the lockfile, and a `JUSTIFICATION:` block on every boundary export. |
| `git-sandbox-gate.test.mjs` | Real-git tests go through the shared sandbox: a direct git spawn reads the developer's own git config. |
| `license.test.mjs` | MIT on every manifest, the NOTICE attributions, and a permissive license for every runtime dependency in the lockfile. |
| `build-contract.test.mjs` | The packaging story: the ESM root manifest, the `kubic` bin wrapper loading `dist/kubic.js`, `dist/` ignored, the Node floor. |

### Dead-code gate

`npm run lint:dead` runs knip (pinned exactly in `package.json`) with
`knip.jsonc`, which carries the reason for each choice. It reports unused
files, exports, types and dependencies, and unlisted or unresolved imports.

- Entries are `scripts/*.mjs` and `test/*.ts` at the root, and each package's
  and the app's `*.test.ts` files; the app's `src/main.ts` is its entry, and
  `bin/kubic.js` comes from the `bin` field. A test file is an entry, so an
  export that only tests import counts as used.
- `mkfifo` is in `ignoreBinaries`: one exec journal test calls the POSIX
  utility to make a named pipe. It is a system tool, not a dependency.
- `ignoreExportsUsedInFile` is off: an export that only its own module uses is
  reported, so it must be module-private.
- `includeEntryExports` is on for the package and app workspaces (`knip.jsonc`)
  and in `knip.production.jsonc`. Each package's exports map makes its modules
  entry files for knip, and this setting keeps an export that nothing uses
  reported. knip may print an informational `Unused tag` hint for a boundary
  seam; a hint does not fail the gate.

The default gate does **not** report an export that only tests import, and it
does not report a source file that only tests reach. The production gate does
both: `npm run lint:dead:prod` runs knip with `knip.production.jsonc` and
`--production`, which skips the test files, so no test import counts as use,
and `ignoreExportsUsedInFile` is off there too. An export that tests import
while production code uses it only inside its own module (a limit, a pure
helper a test pins directly) is tagged `/** @internal */`: knip skips
`@internal` exports in production mode only, so the default gate still
requires a use, and the tag tells a reader the export is not API. The Pi and
TUI boundary seams that only tests reach are tagged the same way where they
are re-exported.

## Tests

- **Test first.** Write the failing test, watch it fail, then write the
  code. One behaviour per test, real code over mocks.
- **Placement.** A unit test sits beside its module (`foo.ts` and
  `foo.test.ts`). The composition root's integration tests, which drive
  `kubic run`, `kubic tui` and the command front door through the real
  wiring, live in `apps/kubic/test/`, grouped by surface (`run/`, `tui/`,
  `cli/`, `approvals/`, `lane/`, `replay/`, `config/`) and named by the
  behaviour they cover.
- **No network, no paid tokens.** Agent tests use the `faux` provider;
  usage and cost tests use fixture `usage` rows.
- **Hermetic by default.** `test/vitest-setup.ts` runs every test file
  under a fresh temp `HOME` (so `~/.agents/skills`, `~/.pi/agent/skills`
  and `~/.kubic` are empty), with every ambient `KUBIC_*` variable cleared
  and non-loopback TCP connects refused. Loopback is exempt, so a test that
  owns a local server stays hermetic. A test that needs an environment
  variable stubs it with `vi.stubEnv` and restores it in `afterEach`.
- **Clean up.** A test removes every temp dir, environment change and child
  process it creates. `tempDir()` from `test/temp-dir.ts` makes a directory
  that is removed after the current test.
- **Shared fixtures.** A helper two test files need lives in one place: a
  package's `src/test-support/` (for its own tests, or through its exports
  map), `apps/kubic/test/fixtures/` for the integration tests, or the root
  `test/` folder across packages. Test fixtures never ship: a production
  module that imports one fails `npm run lint:deps`.
- **Lanes.** Boot a lane with `bootFauxLane`
  (`packages/agent/src/test-support/lane-harness.ts`): the real `bootLane`
  over in-memory or temp-dir storage. A faux tool round must end with
  `stopReason: 'toolUse'` (`fauxToolUse(...)`), or the tool never runs.
- **The TUI.** Render functions are pure and tested as headless snapshots;
  live frames are read back with `TuiAltScreen.getScreenLines()` over the
  one shared fake terminal, `test/fake-terminal.ts` (`fakeTerminal()`,
  `terminalRig()`). A test never sleeps for a render.
- **Real git.** Tests that run git use the shared sandbox
  (`packages/exec/src/test-support/git-sandbox.ts`); a direct
  `execFileSync('git', …)` in a test fails `npm run check`, whether the call
  spans lines, names a path to git or a variable bound to it.
- **Colour.** Tests never depend on the shell's colour variables:
  `FORCE_COLOR=3`, `FORCE_COLOR=0` and `NO_COLOR=1` runs all pass.

## Code conventions

- **Erasable-syntax TypeScript only** — no parameter properties, `enum`,
  `namespace`, `import =` / `export =`.
- **Exact pins** — no `^` / `~` on any dependency (`npm run check:pins`).
- **Dependency direction** — packages import "downward" only, and the TUI
  never imports `host` / `agent` implementation; contracts come from
  `core`. A package imports another as `@kubic/<pkg>/<subpath>`, a subpath its
  exports map lists; a relative path into another package fails
  `npm run lint:deps` (see the [package import rule](packages/README.md)).
  Test fixtures (`test-support/` and the root `test/` folder) serve tests
  only: a production module that imports one fails it too.
- **The Pi boundary** — only `packages/agent/src/pi-boundary.ts` and
  `packages/tui/src/tui-boundary.ts` import `@earendil-works/*`. Every
  re-export carries a `JUSTIFICATION:` block naming the seam, its users
  and why Kubic cannot do without it (`scripts/pi-boundary.test.mjs`), and
  CODEOWNERS puts every change to `pi-boundary.ts` up for maintainer
  review. The
  runtime packages are `pi-durable` (the harness, conversations, durable
  tasks, documents, the extension registry), `pi-ai` (the model layer)
  and `chord` (`Context`); `pi-tui` is presentation only.
- **Exactly one copy of each `@earendil-works/*` package** in
  `package-lock.json` and `node_modules`. A nested duplicate keeps vitest
  green but breaks the built binary; after a Pi bump run `npm dedupe`,
  then `npm ci`.
- **CLI commands** — commander is the only argv parser; see
  [contributing-cli.md](contributing-cli.md).

## Commits and docs

[Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): summary` — imperative, lower-case, no trailing period
(`feat(journal): …`, `fix(agent): …`, `docs(cli): …`). Types are `feat`,
`fix`, `refactor`, `perf`, `test`, `docs`, `style`, `chore`, `build`,
`ci`; a breaking change uses `type(scope)!:` and a `BREAKING CHANGE:`
footer.

A behaviour change ships its docs page in the same commit, and
`npm run docs:check` must pass. Configuration keys are declared once, in
`packages/host/src/config/schema.ts`: the parser's checks, the runtime's
effect rows, `example.toml` and the key tables in
[configuration.md](cli/configuration.md) all derive from it. After changing a
key, run `npm run docs:config` to regenerate the docs and the example. The area map lives on the
[docs index](README.md). The docs style rules (present tense, behaviour rather
than history, no tracker references) are in
[CONTRIBUTING.md](../CONTRIBUTING.md#docs-style).

## CI

A push runs the `test` job: `npm run check` first (once, on Node 22: the
gates do not depend on the Node version), then the suite (with coverage on
the Node 22 leg), the build and `npm run test:binary`. It runs on Node 22 (the lowest supported) on every ref and on
Node 22 and 24 on `main`. A newer push cancels the older run of the same
ref; `main` is keyed by commit and never cancelled. Workflow permissions
are read-only.

Back to the [docs index](README.md).
