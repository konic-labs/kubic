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
`node scripts/check-docs-links.mjs` must pass (it runs in CI via
`npm test`). The area map lives on the
[docs index](README.md#separation-of-concerns-soc).

## The gate

`npm run test:mutation` runs the Stryker vitest gate, the Stryker tap gate,
then the per-file check over both JSON reports. The bar is **total and
per-file mutation score ≥ 80%**:

- **vitest side** — `stryker.conf.json` (`@stryker-mutator/vitest-runner`)
  mutates `packages/*/src/**/*.ts` (test files excluded).
  `thresholds.break: 80` fails the run below 80% total. Currently
  advisory-only in CI (see "Known blocker" below).
- **tap side** — `stryker.tap.conf.json` (`@stryker-mutator/tap-runner`)
  mutates the script systems under test (`scripts/dep-lint.mjs`,
  `scripts/check-pinned-deps.mjs`) and runs the killing suites
  (`scripts/dep-lint.test.mjs`, `scripts/pi-boundary.test.mjs`) with
  `nodeArgs: ["--test-reporter=tap", "{{testFile}}"]` — in-process, so
  coverage attribution and mutant activation share one process — and
  `coverageAnalysis: "perTest"` (file-level: every hit lands in the static
  bucket, which the tap runner maps per test file). Proof run: **83.50 total
  (334 killed), 83.53 check-pinned-deps, 83.49 dep-lint — gate exit 0**.
- **per-file enforcement** — Stryker's `break` threshold is total-only, so
  both runs are followed by
  `node scripts/mutation-check.mjs --report <mutation.json> --min 80`, which
  exits 1 listing any file below 80% (verified: exit 0 at 83.5, exit 1 with
  `--min 100`).

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

## Known blocker: vitest-runner × vitest 5 (upstream)

Full vitest-side runs do not yet produce real scores with the project's
vitest 5.0.1. Root-caused, not assumed:

- `VitestTestRunner.mutantRun` filters each mutant to its covering tests via
  `testNamePattern` built from space-joined suite+test names
  (`collectTestName`: `nameParts.join(' ')`).
- Vitest 5 matches `testNamePattern` against `>`-joined full test names
  (`task-utils.js`: `createTaskName(names, separator = " > ")`, then
  `if (namePattern && !t.fullTestName.match(namePattern)) t.mode = "skip"`).
- Result: every filtered mutant run executes **zero** tests (339/339 covered
  mutants at `testsCompleted: 0` → `Survived`); only uncovered mutants run the
  full suite. Independent repro (throwaway, since removed): files-only
  selection runs 15 tests, adding the runner-style pattern drops it to 0,
  test-name-only pattern runs 1. `coverageAnalysis: "off"` does not bypass
  the filter — the "off" run shows the identical 0.71 artifact. Also
  observed: the runner's debug log line `JSON.stringify(this.ctx.config)`
  crashes on vitest 5's circular project config — do not use
  `--fileLogLevel debug` with the vitest runner.

What still holds on the vitest side: instrumentation (424 mutants across the
trajectory proof scope), dry-run green (115 tests), and the fail direction —
the gate exits 1 below `thresholds.break`. Until the upstream runner supports
vitest 5 name matching, the CI `mutation` job runs the vitest gate
**advisory-only** (`continue-on-error`) while the tap gate blocks. Per-area
follow-ups (#67–#70) own re-enabling full vitest runs once fixed upstream.

## What new suites owe the gate

Every new suite must survive mutation at ≥ 80% per file. When your area lands
(per-area tracking in #67–#70), widen the default `mutate` lists in
`stryker.conf.json` / `stryker.tap.conf.json` to include it — keep them in sync
with `DEFAULT_VITEST_MUTATE` / `DEFAULT_TAP_MUTATE` in
`scripts/mutation-scope.mjs`.

## Changed-package CI

The `mutation` CI job (main pushes + PRs) mutates touched packages at minimum:
`scripts/mutation-scope.mjs --ref <base> [--tap]` maps the diff to `--mutate`
globs. Detection failures warn on stderr and fall back to the proven
trajectory/scripts scope — the gate never goes silently empty.

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
