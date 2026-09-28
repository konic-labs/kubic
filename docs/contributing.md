# Contributing

> Owner: issue [#64](https://github.com/konic-labs/kubic/issues/64).
> `AGENTS.md` at the repo root is the authority — this page mirrors it
> for humans. If the two ever disagree, `AGENTS.md` wins.

Kubic is Konic's open-source terminal coding agent: model-agnostic,
with a VCS-independent change journal and an opt-in orchestrator mode.
Solo mode is the architecture; delegation is a mode — solo has no
isolation, never imply otherwise in code, docs, or CLI text.

## Workflow (LC0–LC6)

Every issue, every wave, no freelancing:

- **LC0 Scope** — `gh issue view <n> --comments`, then
  `gh issue develop <n> --checkout` (`feat/issue-<n>-<slug>`). Read the
  issue's Design ref / Acceptance / Dependencies fully. If the approach
  is genuinely unknowable upfront, spike first and throw it away.
- **LC1 TDD** — one acceptance checkbox at a time: failing test → watch
  it fail → minimal code → watch it pass → refactor. Runner is vitest
  with the `faux` provider (zero network, zero paid tokens in CI); TUI
  work adds `VirtualTerminal` headless snapshots. One behavior per
  test, real code over mocks.
- **LC2 Debug** — anything red goes through root-cause investigation
  first (tight repro loop, recent changes, data flow — no fix proposals
  yet), then pattern analysis, ranked falsifiable hypotheses tested one
  variable at a time, and finally a regression test plus a single fix.
  Three failed fixes means questioning the architecture with a human,
  never a fourth blind attempt.
- **LC3 Review gate** — before every commit on a staged diff: static
  security scan of added lines (secrets, shell/SQL injection,
  eval/exec, unsafe deserialization), baseline tests + lint (only NEW
  failures block), self-review, then an independent reviewer on the
  diff alone (fail-closed), max 2 auto-fix cycles. Never verify your
  own work. Lint gate is `biome ci` (exact CI parity).
- **LC4 Simplify** — only on explicit request, per wave, never bundled
  into feature commits.
- **LC5 Commit** — Conventional Commits, one commit per finished issue
  minimum, pushed iteratively; wave merges carry `fixes #<n>` (repeat
  the keyword per issue — `closes #1, #2` closes only the first). Never
  `git add -A`, `reset --hard`, `stash`, `clean -fd`, or `--no-verify`;
  never force-push. See below.
- **LC6 Capture** — reusable procedures learned doing the work go to a
  skill; memory is only for facts true of every future session.

## Commits

`type(scope): summary` — e.g. `feat(journal): …`, `fix(worker): …`,
`chore(scaffold): …`. Post issue/PR comments with
`gh issue comment <n> --body-file <file>`, never multi-line `--body`.

## Conventions that bite contributors

- **Erasable-syntax TypeScript only** — no parameter properties,
  `enum`, `namespace`, `import =`/`export =`. Node >= 22.19. Exact
  (no `^`/`~`) pins on all `@earendil-works/*` deps.
- **Dep direction** — the TUI package must never import `host`/`worker`
  implementation (contracts from `core` only), enforced by lint.
- **Issue body contract** — `## Design ref`, `## Goal`, `## Scope`
  (in/out), `## Acceptance criteria` (checkboxes), `## Dependencies`.
- **`pi/` is read-only reference** — never build, modify, lint, or test
  anything under `pi/`; it is gitignored upstream material, not Kubic.
- **Tests never need network or paid tokens** — `faux` provider,
  headless `VirtualTerminal`, fixture `usage` rows.

## Docs rule

Each implementation wave updates its docs page in the same commit — a
behaviour change without its docs page is incomplete and fails review.
`node scripts/check-docs-links.mjs` must pass (it runs in CI as the
standalone `npm run docs:check` step, and again inside `npm test` via
`scripts/check-docs-links.test.mjs`). The area map lives on the
[docs index](README.md#separation-of-concerns-soc).

## CI gates (run these locally)

A push runs the `verify` job (the suites + linters below) and the
`binary-contract` job (the shipped artifact), each on node 22 and 24, plus
the per-push `mutation` job on the changed lines (see "The gate"). The
nightly full-scope `mutation-nightly` job is postponed (#137). Mirror `verify` and
`binary-contract` before you push — same commands, same order:

```sh
npm ci
npm test                    # scripts/*.test.mjs via node --test
npm run test:unit           # vitest
npm run typecheck
npm run lint:deps
npm run check:pi
npx biome ci .              # exact CI lint parity (never --no-verify)
npm run docs:check          # dangling links + dep-table drift
npm run build               # tsc -> gitignored dist/
npm run test:binary-contract  # runs the built bin: version / doctor / run
```

`npm run test:binary-contract` (`scripts/binary-contract.mjs`) is the
install-story gate: with `dist/` built it asserts the exact
`kubic <version> (license: MIT)` line (exit 0), `kubic doctor` exiting 6
with `FAIL limit:provider-availability (provider-down)`, and a
provider-less `kubic run -p` exiting 6 while still printing the
`session:`/`journal:`/`usage:`/`trajectory:` refs. It is hermetic — the
probes run under a temp `HOME` with no `models.json` in the cwd, so no
provider and no network. Move `dist/apps/kubic/src/main.js` aside to
watch it fail: a broken dist path or entry fails the job, not a human
review.

## The gate

The bar is **mutation score ≥ 80% per file**, enforced by
`scripts/mutation-check.mjs` over Stryker's JSON report (Stryker's own
`thresholds.break` is total-only, so the vitest config sets it to `null` and
leaves gating to the per-file check).

- **vitest side** — `stryker.conf.json` (`@stryker-mutator/vitest-runner`,
  patched on `postinstall`, see "vitest-runner × vitest 5" below) with
  `coverageAnalysis: "perTest"`: each mutant runs only the tests that cover
  it. `ignoreStatic: true` skips module-level mutants, which are ~5% of
  mutants but ~67% of the runtime (each would re-run the whole suite).
- **tap side** — `stryker.tap.conf.json` (`@stryker-mutator/tap-runner`)
  mutates the script systems under test (`scripts/dep-lint.mjs`,
  `scripts/check-pinned-deps.mjs`) and runs the killing suites
  (`scripts/dep-lint.test.mjs`, `scripts/pi-boundary.test.mjs`,
  `scripts/check-docs-links.test.mjs` — the only suite exercising
  `listInternalEdges`) with
  `nodeArgs: ["--test-reporter=tap", "{{testFile}}"]` — in-process, so
  coverage attribution and mutant activation share one process — and
  `coverageAnalysis: "perTest"` (file-level: every hit lands in the static
  bucket, which the tap runner maps per test file). Proof run (#72): **83.57
  total (351 killed), 82.93 check-pinned-deps, 83.73 dep-lint — gate exit 0**.
- **ratchet** — `mutation-check.mjs --baseline <previous report>` holds each
  file to `min(80, its baseline score)`: a file below 80 may not drop below
  its baseline, a file at or above 80 must stay ≥ 80, and files new to the
  baseline need 80. Without `--baseline` every file needs 80 (`npm run
  test:mutation`, the full local run).
- **concurrency** — both configs default to `"50%"` of the cores (CI passes
  `--concurrency 4`); vitest itself runs at `maxWorkers: '50%'`.

### CI: per push and nightly

- **`mutation` (every push / PR)** — `scripts/mutation-scope.mjs --ref <base>`
  maps `git diff -U0` hunks to the **changed lines** of touched source files
  (`path:start-end` ranges; a core file alone can hold ~1k mutants covered by
  ~500 tests), capped at 25 files — the rest are left to the nightly run
  with a warning. Test-only changes mutate nothing per push; the nightly
  ratchet catches weakened tests. `--tap` maps changed scripts to their SUTs.
  No mutable change → the step is skipped; a failed diff exits 1 rather
  than widening or emptying the scope. The changed lines' score is
  ratcheted against the file's nightly baseline: new code may not drag a
  file down.
- **`mutation-nightly`** — *postponed (backlog #137): the job is disabled and
  no baseline exists yet, so per-push changed lines are held to a strict 80%.*
  When enabled (03:00 UTC + `workflow_dispatch`) — full scope with
  `--incremental` against the previous run (only changed code and tests
  re-run), ratcheted against the baseline. The incremental file is cached
  after every run; the baseline only when the ratchet passes, so a
  regression never becomes the new floor.

Run a scope locally: `npx stryker run --mutate "path/a.ts,path/b.ts"`, then
`node scripts/mutation-check.mjs --report reports/mutation/mutation.json`.

## Suite selection notes (all evidence-based)

- `erasable.test.mjs` is **not** in the tap `testFiles`: it imports no script
  SUT (node builtins only), so it kills zero script mutants by construction.
  It stays green via `npm test` in the CI `verify` job.
- `node --test <file>` must **not** be used as the tap runner command: `--test`
  delegates execution to child processes, so the parent process (whose hook
  output file Stryker reads) records zero coverage and every mutant lands in
  `NoCoverage`. Direct execution (`node --test-reporter=tap <file>`) keeps
  everything in-process; the default spec reporter it would otherwise emit is
  not TAP and the parser scores every failing mutant as `RuntimeError`.
- There are exactly **five mutator exclusions**, all in
  `scripts/check-pinned-deps.mjs`, each a proven equivalent with its reason
  and `(tracking: #66)` in the comment: junk-seed array entry (statSync
  skips it), empty catch fallthrough (loop is a no-op), unconditional push
  (later read/parse throws and skips just the same), `""` read encoding
  (Buffer coerces identically under JSON.parse), dropped typeof guard (no
  non-string JSON value stringifies to an exact-version match). Zero
  unexplained exclusions.

## vitest-runner × vitest 5 (fixed locally, issue #72)

`@stryker-mutator/vitest-runner` 10.0.0 names tests by space-joining suite +
test names and filters each mutant run with that name as `testNamePattern`;
vitest 5 matches the pattern against `fullTestName` (`" > "`-joined). Every
filtered run executed **zero** tests, so `coverageAnalysis: "perTest"` was
unusable and every mutant fell back to the full suite (~9h CI runs, #72).

`scripts/patch-vitest-runner.mjs` (run on `postinstall`) names tests by
vitest's own `fullTestName` and anchors the filter (`^(?:a|b)$`). It is
idempotent and fails loudly if the runner changes shape, so a runner
upgrade can never silently drop the fix. Verified: on the trajectory scope
`perTest` and a filter-free `coverageAnalysis: "all"` run produce identical
per-mutant statuses (0 differences), at seconds instead of hours. Scores
before this fix were artifacts of the bug; the first nightly report is the
real baseline.

Tests that scan **source text** (e.g. `clean-docs`, `tui-keys-doc`) cannot
run under Stryker — every literal is instrumented — and kill no mutants, so
they skip when `STRYKER_MUTATOR_WORKER` is set; plain `vitest` still runs
them. Tests that list repo files must not rely on `git ls-files` alone:
Stryker's sandbox is a gitignored copy (see `orchestrate-roles-docs`).

## What new suites owe the gate

Every new source file must reach ≥ 80% per file the first time it is
mutated (it is absent from the nightly baseline, so the ratchet holds it to
80). A new package goes into `mutate` in `stryker.conf.json`.

## Spike verdict (recorded for #66)

tap-runner wiring against ESM `node:test` suites: **confirmed working** with
the in-process TAP invocation above (full proof run green at 83.50; fail
direction verified at 47.17/76.66/79.85 during test-strengthening). The issue's
suggested `node --test --test-reporter=tap` form is documented here as
not-working for Stryker's coverage model; Stryker symlinks `node_modules`
into the sandbox, so `tsc`-dependent suites run unmodified (dry-run green on
all three suites including `erasable`).

See also the docs rule from the [docs index](README.md): **each implementation wave updates its docs page in the same commit** — a behaviour change without its docs page is incomplete and fails review.

Back to the [docs index](README.md).
