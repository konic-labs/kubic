# Trajectory export contract — v1.0 (`stable`)

Every run can emit one versioned JSON record that is sufficient for replay,
benchmarking, SFT/RL datasets and debugging — and that never claims
configuration the run did not use.

## Stability

`stable`: additive-only within major 1. Readers pinned to major 1 (replay
and eval) parse every same-major record with no shim; unknown fields are
preserved; an unknown major is refused with `unknown-major` (exit 3).
Breaking changes mint major 2.

## Fields (all present, every export)

`schema_version`, `task` (`taskId`, `objective`, `role`), `identity`
(`sessionId`, `agentId`), `model` (+`escalations`: `reason`/`at`/`fromModel`/
`toModel`/`thinking`), `prompt` (`text`), `resources` (`skills`), `actions`
(+args), `observations` (truncated), `state` (`phase`), `provenance`
(`sessionId`/`agentId`/`pid`/`worktree`/`model`), `environment` (USED
snapshot, `capturedFrom: 'used'`), `worktree` (+`baseRevision`, `branch`),
`diff`, `approvals` (`approvalId`/`capability`/`verdict`/`by`), `timestamps`,
`usage` (+`byModel`), `result` (`status`/`summary`/`failureCategory`/`error`),
and `eval` (`labels`: the run verifier's `signal:*` gates, empty when no
verifier ran).

Every section and every entry of `model.escalations` and `approvals` carries
all of its keys. A key that has no value is an explicit `null` or an empty
list, never a missing key.

## Non-negotiables (fail-closed, never a silent drop)

- Provenance missing/incomplete → `missing-provenance` /
  `invalid-provenance` (exit 2). `pid` is an explicit `null` for
  process-less (faux) runs — never omitted.
- Used-`ExecutionEnv` snapshot missing → `missing-environment`
  (exit 2). Only the env the run actually used is recorded:
  `environment.capturedFrom` must be `'used'`; the exporter refuses anything
  else (intended/configured) with `untrusted-environment`, and the reader
  refuses it as `malformed`. Every key the run saw is recorded; the value of
  each secret-classified key is replaced with `<redacted>`.
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
  keys (`model.provider`/`model`, `result.status` in `RESULT_STATUSES`,
  `actions`/`observations`/`approvals` arrays, the `usage` numbers, …). A
  null or mistyped section/key is `malformed` (exit 3) naming the JSON path
  (`trajectory.actions must be an array`), never a raw `TypeError`
  downstream. Unknown extra keys are preserved.
- Observations over 8 KiB are truncated on a UTF-8 character boundary
  (byte cap holds exactly, no U+FFFD) with `bytesOriginal` kept.

## Consumers

- `parseTrajectoryExport` / `parseTrajectoryExportJSON` — the no-shim
  entry that `kubic replay --diff-against` and `kubic eval` read directly.
- The `eval` slot: `labels`, filled by the run verifier and read by
  `kubic eval`.

## Changelog

The machine-readable mirror is `TRAJECTORY_CHANGELOG` in `src/schema.ts`.

- 1.0 (2026-10-08): initial export contract.
