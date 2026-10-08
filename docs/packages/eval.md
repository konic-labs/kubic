# `@kubic/eval`

> Eval harness; source: `packages/eval/COMMUNITY.md`
> (quoted, not copied).
> Source: `packages/eval/src`.

`@kubic/eval` is the benchmark harness. Every
stored result carries how it ran — model/thinking/worktree, the record
size, and the determinism tier; records missing any of
them are rejected (exit 2), never stored. Cost/latency/tokens reconcile against usage rows
before a record is accepted. Each executable suite carries a fixture
(prompt, starting files, gate commands); `kubic eval --task` and
`kubic benchmark` run it through the real solo lane and score the
trajectory it writes. Suites run faux-only in CI (zero network, zero paid
tokens); anything needing a capability the binary does not ship (a live
PTY) stays `stub: true` and reports `skipped`, never passing work.

Quoted from `packages/eval/COMMUNITY.md`:

> Anyone can add a benchmark suite. The path is stub-first: land the suite
> as `stub: true`, then implement it — the matrix reports stubs as
> `skipped` (never as passing work), so a stub can never fake a green
> board.

> `--size` is mandatory on every invocation, and `--worktree` is mandatory
> for `--task` and `benchmark` (a `--trajectory` run takes it from the
> export). Records missing a mandatory flag are rejected (exit 2), never
> stored.

`--json` shapes: eval success `{ ok: true, exitCode: 0, record: {
suite, success } }`; rejection `{ ok: false, exitCode: 2, error: {
code, message } }`; benchmark matrix `{ ok: true, exitCode, results: [{
suite, category, stub, skipped, success }] }` (exit 0 all pass, 1 a
suite failed, 2 usage). Checklist before review: ≥1 test in
`packages/eval/src` (test first), vitest green, `tsc` clean, `biome
ci` clean, usage reconciliation, RL export fields untouched.

## Public API (`packages/eval/src`)

| Module | Exports |
| --- | --- |
| `records.ts` | `EvalRecord`, `EvalRecordInput`, `EvalSize`, `isEvalSize`, `EvalDeterminism`, `RecordValidation`, `validateEvalRecord`, `UsageRowLike`, `ReconcileResult`, `reconcileUsage` |
| `suites.ts` | `EvalSuite`, `EVAL_SUITES`, `findSuite` |
| `categories.ts` | `EvalCategory`, `EVAL_CATEGORIES`, `isEvalCategory` |
| `signals.ts` | `EvalSignals`, `GateSignal`, `computeSignals`, `gatesPass`, `patchQuality` |
| `runner.ts` | `EvalRunnerErrorCode`, `EvalRunnerError`, `EvalTaskDeps`, `EvalTaskOptions`, `EvalTrajectoryOptions`, `EvalWorkspace`, `SuiteRunOutcome`, `runEvalTask`, `runEvalTrajectory` |
| `cli.ts` | `BenchmarkResult`, `EvalCliDeps`, `EvalOptions`, `EVAL_DEFAULT_MODEL`, `runEvalCommand`, `runBenchmarkCommand` (both return a `CommandResult`; their exit codes are core's `EXIT_*`). The handlers take the options commander parses in `apps/kubic/src/commands/analysis.ts`; the benchmark matrix is assembled here over `EVAL_SUITES` |
| `suites.test.ts` | Category/suite coverage test over `categories.ts` + `suites.ts` — eight categories in order, one suite each, stubs marked. There is no `matrix.ts`: matrix assembly is a function of `runBenchmarkCommand` |
| `export-cli.ts` | `ExportCliDeps`, `ExportCommandOptions`, `DATASET_TYPES`, `runExportCommand` — single-trajectory describe/export plus the `--dataset` batch mode |
| `rl/` | RL dataset export: `types`, `manifest`, `coding`, `tooluse`, `sft`, `grpo`, `dpo`, `preference`, `provenance`, `verifier`, `dataset` (`ExportDatasetType`; directory/glob in, streamed JSONL + `dataset/1` manifest out; incl. pairs/sft-grpo/tooluse-coding shapes) |
| `index.ts` | Re-exports the surface above |

## Contracts

### `EvalRecord` (`records.ts`)

| Field | Type | Notes |
| --- | --- | --- |
| `suite` | `string` (non-empty) | required |
| `caseId` | `string` (non-empty) | required; the suite's name (a suite is one case) |
| `category` | `EvalCategory` (one of 8) | required |
| `success` | `boolean` | — |
| `costUsd` | `number` (≥ 0) | reconciled vs usage rows |
| `tokens` | `number` (≥ 0) | reconciled vs usage rows |
| `latencyMs` | `number` (≥ 0) | reconciled vs usage rows |
| `toolCalls` | `number` (≥ 0) | — |
| `model` | `string` (non-empty) | required |
| `thinking` | `string \| null` | string or null only |
| `worktree` | `string` (non-empty) | required |
| `size` | `EvalSize` | required; `smoke \| standard \| extended` — the record's size class (an implementation-side label, not a tier) |
| `determinism` | `EvalDeterminism` | required; `recorded \| deterministic \| live` — derived from the path: `recorded` for `--trajectory`, `live` for `--task`; benchmark rows publish `live` |
| `signals` | `EvalSignals` | optional on input |
| `recordedAt` | `string` (ISO) | set on accept |

`validateEvalRecord` returns `{ valid: true, record }` or `{ valid:
false, errors }` with no record — callers must not persist invalid
input. `reconcileUsage` checks tokens/cost/latency against
`UsageRowLike` (`inputTokens`, `outputTokens`, `costUsd`,
`latencyMs?`) into `ReconcileResult` (`{ ok, errors }`).

### Suites (`suites.ts`, `categories.ts`)

`EVAL_CATEGORIES` (8): `swe`, `repo-mod`, `bugfix`, `refactor`,
`testgen`, `review`, `terminal`, `agentic`. `EvalSuite` fields: `id`,
`category`, `title`, `stub`, `description`, `fixture?` (`prompt`, `files`, `verify` gate commands, `timeoutMs?`).
`resolveSuites(selector)` accepts an id, a category alias (`swe` → every
suite of that category) or `all`/undefined. Built-ins — one per category:

| `id` | `category` | `stub` | fixture |
| --- | --- | --- | --- |
| `swe-bench-mini` | `swe` | false | write the fix file, gate on it |
| `repo-mod-rename` | `repo-mod` | false | rename via bash, gate on both paths |
| `bugfix-repro` | `bugfix` | false | write the answer, gate runs the repro script |
| `refactor-extract` | `refactor` | false | write the extracted module, gate on it |
| `testgen-cover` | `testgen` | false | write the test file, gate greps it |
| `review-diff` | `review` | false | write the findings, gate greps the path |
| `terminal-live` | `terminal` | true | — (needs a live PTY) |
| `agentic-live` | `agentic` | false | one tool step, gate on its artifact |

### Signals (`signals.ts`)

`EvalSignals` fields: `tests`, `build`, `lint`, `typecheck:
GateSignal` (`pass|fail|unknown`), `completion: boolean`, `quality:
number`, `regressionFree: boolean`, `tokens`, `costUsd`, `latencyMs`,
`toolCalls: number`, `toolCounts: Record<string, number>`,
`escalations: number`. Derived from a parsed
[trajectory](trajectory.md) export (this package never redefines the
trajectory shape): counts come straight from it; gate signals are
`unknown` unless the trajectory eval labels carry an explicit
`signal:<name>` = pass|fail — never guessed. `gatesPass` vetoes on any
red gate: a completed run with red tests/build/lint/typecheck is not a
success.

### Signals and patch quality

The shipped producer of the gate labels is the run verifier (`packages/host/src/verify/verifier.ts`). The `[verify]` commands (see
[configuration](../cli/configuration.md#gate-verification-verify)) run in
the worktree after `kubic run` settles, and their exit statuses become
`signal:tests|build|lint|typecheck`. A baseline run at the base revision
adds `signal:regression`.

- **`regressionFree`**: with a `signal:regression` label, it is true
  exactly when the run completed and no gate that passed at the base
  revision fails now. A gate that was already red at base is not a
  regression. Without the label it falls back to "completed with no red
  gate".
- **`quality`** (`patchQuality`), graded in [0, 1]:
  - 0 when the run did not complete;
  - otherwise the fraction of known gates that pass (1 when no gate is
    known, since unknown gates abstain);
  - halved when a regression was detected.

  For example, tests/build/typecheck pass and lint fails gives 0.75; the
  same with a regression gives 0.375.
- **Reference verifier** (`rl/verifier.ts`): `pass` needs
  `signal:tests = pass` and no red gate. Verified runs therefore feed
  GRPO rewards and preference pairs without hand-set labels.

## Dep-direction neighbours

- May import: core, [agents](agents-pkg.md),
  [trajectory](trajectory.md) (reads exports via
  `parseTrajectoryExport`) — never exec/worker/host/tui.
- Records stay complete so the RL exporter (`rl/`) builds on
  them; RL fields are untouched by harness edits.

```text
core + agents + trajectory ──→ @kubic/eval ──→ benchmark matrix
```

Back to the [docs index](../README.md).
