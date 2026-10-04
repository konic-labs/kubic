# `@kubic/eval`

> Design ref: eval harness; source: `packages/eval/COMMUNITY.md`
> (quoted, not copied).
> Owner: issue
> [#63](https://github.com/konic-labs/kubic/issues/63).
> Source: `packages/eval/src` (read-only — this page quotes it, never moves it).

`@kubic/eval` is the benchmark harness (issue #53; §48, §72, §73). Every
stored result carries how it ran — model/thinking/worktree/generation/
tier; records missing worktree, generation, or tier are rejected (exit
2), never stored. Cost/latency/tokens reconcile against §39 usage rows
before a record is accepted. Suites run faux-only in CI (zero network,
zero paid tokens); anything needing a live PTY or model stays
`stub: true` and reports `skipped`, never passing work.

Quoted from `packages/eval/COMMUNITY.md` (stub-first contribution path):
append one row to `EVAL_SUITES` in `suites.ts` (`{ id` — unique,
lowercase, hyphenated; `category` — one of the 8 `EVAL_CATEGORIES`;
`title`; `stub: true`; `description` — what signal it measures `}`),
flip `stub` to `false` when it runs faux-only. `--worktree`,
`--generation`, and `--tier` are mandatory on every CLI invocation.
`--json` shapes: eval success `{ ok: true, exitCode: 0, record: {
suite, success } }`; rejection `{ ok: false, exitCode: 2, error: {
code, message } }`; benchmark matrix `{ ok: true, exitCode, results: [{
suite, category, stub, skipped, success }] }` (exit 0 all pass, 1 a
suite failed, 2 usage). Checklist before review: ≥1 test in
`packages/eval/src` (TDD RED first), vitest green, `tsc` clean, `biome
ci` clean, usage reconciliation, RL export fields untouched (#54).

## Public API (`packages/eval/src`)

| Module | Exports |
| --- | --- |
| `records.ts` | `EvalRecord`, `EvalRecordInput`, `EvalTier`, `EVAL_TIERS`, `isEvalTier`, `RecordValidation`, `validateEvalRecord`, `UsageRowLike`, `ReconcileResult`, `reconcileUsage` |
| `suites.ts` | `EvalSuite`, `EVAL_SUITES`, `findSuite` |
| `categories.ts` | `EvalCategory`, `EVAL_CATEGORIES`, `isEvalCategory` |
| `signals.ts` | `EvalSignals`, `GateSignal`, `computeSignals`, `gatesPass` |
| `runner.ts` | `EvalRunnerErrorCode`, `EvalRunnerError`, `EvalTaskDeps`, `EvalTaskOptions`, `EvalTrajectoryOptions`, `EvalWorkspace`, `SuiteRunOutcome`, `runEvalTask`, `runEvalTrajectory` |
| `cli.ts` | `BenchmarkResult`, `EvalCliDeps`, `EvalOptions`, `EVAL_DEFAULT_MODEL`, `EVAL_EXIT_OK/FAILED/USAGE`, `runEvalCommand`, `runBenchmarkCommand`. The handlers take the options commander parses in `apps/kubic/src/commands/analysis.ts`; the benchmark matrix is assembled here over `EVAL_SUITES` |
| `suites.test.ts` | Category/suite coverage test over `categories.ts` + `suites.ts` — eight categories in order, one suite each, stubs marked. There is no `matrix.ts`: matrix assembly is a function of `runBenchmarkCommand` |
| `rl/` | Phase-4 RL export: `types`, `manifest`, `fixtures`, `coding`, `tooluse`, `sft`, `grpo`, `dpo`, `preference`, `provenance`, `verifier` (incl. pairs/sft-grpo/tooluse-coding shapes) |
| `index.ts` | Re-exports the surface above |

## Contracts

### `EvalRecord` (`records.ts`, §72–§73)

| Field | Type | Notes |
| --- | --- | --- |
| `suite` | `string` (non-empty) | required |
| `caseId` | `string` (non-empty) | required |
| `category` | `EvalCategory` (one of 8) | required |
| `success` | `boolean` | — |
| `costUsd` | `number` (≥ 0) | reconciled vs §39 rows |
| `tokens` | `number` (≥ 0) | reconciled vs §39 rows |
| `latencyMs` | `number` (≥ 0) | reconciled vs §39 rows |
| `toolCalls` | `number` (≥ 0) | — |
| `model` | `string` (non-empty) | required |
| `thinking` | `string \| null` | string or null only |
| `worktree` | `string` (non-empty) | required (§73) |
| `generation` | `number` (integer ≥ 0) | required (§73) |
| `tier` | `EvalTier` | required; `smoke \| standard \| extended` |
| `signals` | `EvalSignals` | optional on input |
| `recordedAt` | `string` (ISO) | set on accept |

`validateEvalRecord` returns `{ valid: true, record }` or `{ valid:
false, errors }` with no record — callers must not persist invalid
input. `reconcileUsage` checks tokens/cost/latency against
`UsageRowLike` (`inputTokens`, `outputTokens`, `costUsd`,
`latencyMs?`) into `ReconcileResult` (`{ ok, errors }`).

### Suites (`suites.ts`, `categories.ts`, §48/§76.1)

`EVAL_CATEGORIES` (8): `swe`, `repo-mod`, `bugfix`, `refactor`,
`testgen`, `review`, `terminal`, `agentic`. `EvalSuite` fields: `id`,
`category`, `title`, `stub`, `description`. Built-ins — one per
category:

| `id` | `category` | `stub` |
| --- | --- | --- |
| `swe-bench-mini` | `swe` | false |
| `repo-mod-rename` | `repo-mod` | false |
| `bugfix-repro` | `bugfix` | false |
| `refactor-extract` | `refactor` | false |
| `testgen-cover` | `testgen` | false |
| `review-diff` | `review` | false |
| `terminal-live` | `terminal` | true (needs live PTY) |
| `agentic-live` | `agentic` | true (needs live model) |

### Signals (`signals.ts`, §48)

`EvalSignals` fields: `tests`, `build`, `lint`, `typecheck:
GateSignal` (`pass|fail|unknown`), `completion: boolean`, `quality:
number`, `regressionFree: boolean`, `tokens`, `costUsd`, `latencyMs`,
`toolCalls: number`, `toolCounts: Record<string, number>`,
`escalations: number`. Derived from a parsed
[trajectory](trajectory.md) export (this package never redefines the
trajectory shape): counts come straight from it; gate signals are
`unknown` unless the trajectory eval labels carry an explicit
`signal:<name>` = pass|fail override — never guessed. `gatesPass`
vetoes on any red gate: a completed run with red tests/build/lint/
typecheck has `quality: 0` and is not a success.

## Dep-direction neighbours

- May import: core, [agents](agents-pkg.md),
  [trajectory](trajectory.md) (reads exports via
  `parseTrajectoryExport`) — never exec/worker/host/tui.
- Records stay complete so the Phase-4 RL exporter (`rl/`) builds on
  them; RL fields are untouched by harness edits.

```text
core + agents + trajectory ──→ @kubic/eval ──→ benchmark matrix
```

Back to the [docs index](../README.md).
