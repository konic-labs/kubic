# Trajectory export contract — v1.3 (`stable`)

Every run can emit one versioned JSON record that is sufficient for replay,
benchmarking, SFT/RL datasets and debugging — and that never claims
configuration the run did not use.

## Stability

`stable`: additive-only within major 1. Readers pinned to major 1 (replay
and eval) parse every same-major record with no shim; unknown fields are
preserved; an unknown major is refused with `unknown-major` (exit 3).
Breaking changes mint major 2. The one exception is 1.3, made before the
first public release: it retired the run-budget values (see the
changelog).

## Fields (all present, every export)

`schema_version`, `task`, `identity` (+`parentSessionId`, `role`),
`model` (+`escalations`: `reason`/`at`/`fromModel`/`toModel`/`thinking`),
`prompt`, `resources`, `transfer`, `actions` (+args), `observations`
(truncated), `state` (durable: `phase`, `snapshot`, `operations[]`
`{id, kind}`, `memos[]` refs), `provenance`
(pid/generation/worktree/model), `environment` (USED snapshot),
`worktree` (+baseRevision), `diff`, `approvals` (+`requested` redacted
summary, `justification`), `timestamps`, `usage` (+cost), `result`
(+`tests`, `artifacts` refs), `eval` (slot).

The 1.1 additions are optional on read (a 1.0 record still parses, no
shim) and written by the exporter: an absent parent is `null`, an absent
role falls back to `task.role`, absent leaves/memos/evidence are `[]`,
and absent approval details are `null` — never an invented value.

## Non-negotiables (fail-closed, never a silent drop)

- Provenance missing/incomplete → `missing-provenance` /
  `invalid-provenance` (exit 2). `pid` is an explicit `null` for
  process-less (faux) runs — never omitted.
- Used-`ExecutionEnv` snapshot missing → `missing-environment`
  (exit 2). Only the env the run actually used is recorded:
  `environment.capturedFrom` must be `'used'`; anything else
  (intended/configured) is refused with `untrusted-environment`. Every
  key the run saw is recorded; the value of each secret-classified key is
  replaced with `<redacted>`.
- Every non-`completed` result carries a `failureCategory` (the 16 lane
  failure codes, pinned equal by test); otherwise
  `missing-failure-category` (exit 2). A `completed` result carrying
  a `failureCategory` or `error` is `contradictory-result` (exit 2).
- `usage.byModel` rows are validated (`requests`/`input`/`output`/
  `costTotal` non-negative numbers); otherwise `invalid-usage` (exit 2).
  A caller that omits the rollup gets `byModel: {}` — the exporter never
  emits a record the parser would refuse.
- An escalation without a non-empty `toModel` → `invalid-escalation`
  (exit 2): an escalation that cannot name its target model cannot be
  attributed in RL pairing or cost analysis.
- Structural validation: every section is type-checked with its required
  nested keys (`model.provider`/`model`, `result.status` in
  `RESULT_STATUSES`, `actions`/`observations`/`approvals` arrays, the
  `usage` numbers, …). A null or mistyped section/key is `malformed`
  (exit 3) naming the JSON path (`trajectory.actions must be an array`),
  never a raw `TypeError` downstream. Unknown extra keys are preserved.
- Observations over 8 KiB are truncated on a UTF-8 character boundary
  (byte cap holds exactly, no U+FFFD) with `bytesOriginal` kept.

## Consumers

- `parseTrajectoryExport` / `parseTrajectoryExportJSON` — the no-shim
  entry that `kubic replay --diff-against` and `kubic eval` read directly.
- The `eval` slot: `{ suite, caseId, labels }`, null-labelled until the
  eval harness fills it.

## Changelog

The machine-readable mirror is `TRAJECTORY_CHANGELOG` in `src/schema.ts`.

- 1.3 (2026-10-07): run budgets retired. The optional `budget` block is
  no longer written; an older record that carries one still parses and
  the block is ignored. The `--max-turns` stop reports `result.status`
  `turn_limit` with failure category `run_limit`; a wall-clock timeout
  also carries `run_limit`. Records that carry the retired
  `budget_exhausted` status or category, or the retired `spawn_failed`
  status, no longer parse.
- 1.2 (2026-10-05): optional top-level `budget` block — `budget: { limits,
  usage?, exhausted? }`, absent on unbounded runs. 1.1 records still parse
  with no shim.
- 1.1 (2026-10-04): additive fields — identity ancestry
  (`parentSessionId`, `role`), escalation attribution
  (`fromModel`/`toModel`/`thinking`), approval audit (`requested`,
  `justification`), durable-state leaves (`operations[]`, `memos[]`) and
  result evidence (`tests`, `artifacts`). Optional on read: 1.0 records
  still parse with no shim. `toModel` is required on write.
- 1.0 (2026-09-23): initial stable export — every field above, mandatory
  provenance + used-environment (fail-closed), failure categories on
  failures, truncated observations, reserved eval slot.
