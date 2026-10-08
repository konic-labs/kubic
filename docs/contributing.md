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

CI runs these commands in this order; run them locally first:

```sh
npm run typecheck
npm run lint                  # biome ci — exact CI parity
npm run lint:deps             # package dependency direction
npm run lint:dead             # knip: unused files, exports, dependencies, types
npm run lint:dead:prod        # knip, production code only: test imports count as no use
npm run check:pi              # exact pins on every dependency
npm run docs:check            # no dangling internal doc links
npm test                      # repo gates: scripts/*.test.mjs via node --test
npm run test:unit             # vitest
npm run build
npm run test:binary-contract  # runs the built binary: version / doctor / run
```

`npm run test:binary-contract` (`scripts/binary-contract.mjs`) is the
install-story gate: with `dist/` built it asserts the exact
`kubic <version> (license: MIT)` line (exit 0), `kubic doctor` exiting 6
with `FAIL limit:provider-availability (provider-down)`, and a
provider-less `kubic run -p` exiting 6 while still printing the
`session:`/`journal:`/`usage:`/`trajectory:` refs. It is hermetic — the
probes run under a temp `HOME` with no `models.json` in the cwd, so no
provider and no network.

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

The default gate does **not** report an export that only tests import, and it
does not report a source file that only tests reach. The production gate does
both: `npm run lint:dead:prod` runs knip with `knip.production.jsonc` and
`--production`, which skips the test files, so no test import counts as use.
It runs in CI next to `lint:dead`. Apart from `ignoreExportsUsedInFile` (below),
the only exports it exempts are the nine boundary seams, each tagged `@internal`
where it is re-exported (`pi-boundary.ts` and `tui-boundary.ts`). knip ignores
`@internal` only in production mode, so the default gate still checks them.

One gap remains, stated here so a green run is not read as more than it proves.
`ignoreExportsUsedInFile` is on in `knip.production.jsonc`: an export that
production code uses inside its own module counts as live. With the option off,
the gate would also flag 227 exports and 50 types. Production code uses each of
them only inside its own module, and tests import it from outside. Clearing
those is test restructuring for a later change; this gate does not report them.

## Tests

- **Test first.** Write the failing test, watch it fail, then write the
  code. One behaviour per test, real code over mocks.
- **No network, no paid tokens.** Agent tests use the `faux` provider;
  usage and cost tests use fixture `usage` rows.
- **Hermetic by default.** `test/vitest-setup.ts` runs every test file
  under a fresh temp `HOME` (so `~/.agents/skills`, `~/.pi/agent/skills`
  and `~/.kubic` are empty), with every ambient `KUBIC_*` variable cleared
  and non-loopback TCP connects refused. Loopback is exempt, so a test that
  owns a local server stays hermetic. A test that needs an environment
  variable stubs it with `vi.stubEnv` and restores it in `afterEach`.
- **Clean up.** A test removes every temp dir, environment change and child
  process it creates.
- **Lanes.** Boot a lane with `bootFauxLane`
  (`packages/agent/src/lane/test-harness.ts`): the real `bootLane`
  over in-memory or temp-dir storage. A faux tool round must end with
  `stopReason: 'toolUse'` (`fauxToolUse(...)`), or the tool never runs.
- **The TUI.** Render functions are pure and tested as headless snapshots;
  live frames are read back with `TuiAltScreen.getScreenLines()` over the
  one shared fake terminal, `test/fake-terminal.ts` (`fakeTerminal()`,
  `terminalRig()`). A test never sleeps for a render.
- **Real git.** Tests that run git use the shared sandbox
  (`packages/exec/src/test-support/git-sandbox.ts`); a direct
  `execFileSync('git', …)` in a test fails `npm test`.
- **Colour.** Tests never depend on the shell's colour variables:
  `FORCE_COLOR=3`, `FORCE_COLOR=0` and `NO_COLOR=1` runs all pass.

## Code conventions

- **Erasable-syntax TypeScript only** — no parameter properties, `enum`,
  `namespace`, `import =` / `export =`.
- **Exact pins** — no `^` / `~` on any dependency (`npm run check:pi`).
- **Dependency direction** — packages import "downward" only, and the TUI
  never imports `host` / `agent` implementation; contracts come from
  `core` (`npm run lint:deps`, see the [package map](packages/README.md)).
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
`npm run docs:check` must pass. The area map lives on the
[docs index](README.md). The docs style rules (present tense, behaviour rather
than history, no tracker references) are in
[CONTRIBUTING.md](../CONTRIBUTING.md#docs-style).

## CI

A push runs the `test` job: the static checks first (typecheck, biome,
`lint:deps`, `lint:dead`, `lint:dead:prod`, `check:pi`, `docs:check`), then the suites and the built
binary. It runs on Node 22 (the lowest supported) on every ref and on
Node 22 and 24 on `main`. A newer push cancels the older run of the same
ref; `main` is keyed by commit and never cancelled. Workflow permissions
are read-only.

## Mutation testing

The mutation jobs are switched off for now; the tooling stays in the repo.
The bar is a **mutation score ≥ 80% per file**, enforced by
`scripts/mutation-check.mjs` over Stryker's JSON report.

- **vitest side** — `stryker.conf.json` (`@stryker-mutator/vitest-runner`)
  with `coverageAnalysis: "perTest"`, so each mutant runs only the tests
  that cover it, and `ignoreStatic: true`.
- **tap side** — `stryker.tap.conf.json` mutates the script gates and runs
  their `node:test` suites in-process
  (`nodeArgs: ["--test-reporter=tap", "{{testFile}}"]`). `node --test` must
  not be the runner command: it runs each file in a child process, and
  Stryker then records no coverage.
- **ratchet** — `mutation-check.mjs --baseline <previous report>` holds
  each file to `min(80, its baseline score)`; a file new to the baseline
  needs 80.
- **scope** — `scripts/mutation-scope.mjs --ref <base>` maps a diff to the
  changed lines of the touched source files.

Run a scope locally with `npx stryker run --mutate "path/a.ts,path/b.ts"`,
then `node scripts/mutation-check.mjs --report reports/mutation/mutation.json`.

The vitest runner needs a patch (`scripts/patch-vitest-runner.mjs`, run on
`postinstall`): the stock runner filters each mutant's tests by a name
vitest 5 never matches, so every mutant would fall back to the full suite.
The patch is idempotent and fails loudly if the runner changes shape —
re-verify it before upgrading any `@stryker-mutator/*` package.

Stryker runs the suite from a gitignored sandbox copy with instrumented
sources: a test must not rely on `git ls-files` alone, and a test that
scans source text skips when `STRYKER_MUTATOR_WORKER` is set.

Back to the [docs index](README.md).
