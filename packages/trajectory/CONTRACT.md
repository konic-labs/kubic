# Trajectory export contract — v1.1 (`stable`)

Published contract for issue #51 (design §46). Every autonomous run may
emit one versioned JSON record sufficient for replay/bench/SFT/RL/debug —
never claiming unrun config.

## Stability

`stable`: additive-only within major 1. Replay (#52) and eval (#53)
pinned to major 1 keep parsing: same-major records (any minor) parse
with no shim; unknown fields are preserved; unknown majors are refused
with `unknown-major` (exit 3). Breaking changes mint major 2.

## §46 fields (all present, every export)

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

## Non-negotiables (fail-closed, never silent drop)

- Provenance missing/incomplete → `missing-provenance` /
  `invalid-provenance` (exit 2). `pid` is an explicit `null` for
  process-less (faux) runs — never omitted.
- Used-`ExecutionEnv` snapshot missing → `missing-environment`
  (exit 2). Only the USED spawn env is recorded (§46r2/§3.8):
  `environment.capturedFrom` must be `'used'`; anything else
  (intended/configured) is refused with `untrusted-environment`.
  The used env is recorded VERBATIM — never scrubbed or redacted
  (transparency: replays must see what the run saw). Secrecy is
  enforced upstream at the spawn allowlist (#42).
- Every non-`completed` result carries a §52 `failureCategory`
  (the 16 worker codes, pinned equal by test); otherwise
  `missing-failure-category` (exit 2). A `completed` result carrying
  a `failureCategory` or `error` is `contradictory-result` (exit 2).
- `usage.byModel` rows are validated (`requests`/`input`/`output`/
  `costTotal` non-negative numbers); otherwise `invalid-usage` (exit 2).
  A caller that omits the rollup gets `byModel: {}` — the exporter never
  emits a record the parser would refuse.
- An escalation without a non-empty `toModel` → `invalid-escalation`
  (exit 2): an escalation that cannot name its target model cannot be
  attributed in RL pairing or cost analysis (1.1, #329).
- Structural validation (issue #331): every §46 section is type-checked
  with its required nested keys (`model.provider`/`model`, `result.status`
  in `RESULT_STATUSES`, `actions`/`observations`/`approvals` arrays, the
  `usage` numbers, …). A null or mistyped section/key is `malformed`
  (exit 3) naming the JSON path (`trajectory.actions must be an array`),
  never a raw `TypeError` downstream. Unknown extra keys are preserved.
- Observations over 8 KiB are truncated on a UTF-8 character boundary
  (byte cap holds exactly, no U+FFFD) with `bytesOriginal` kept.

## Consumers

- `parseTrajectoryExport` / `parseTrajectoryExportJSON` — the no-shim
  entry replay `--diff-against` (#52) and eval (#53) read directly.
- The `eval` slot is reserved for #53: `{ suite, caseId, labels }`,
  null-labelled until the eval harness fills it.

## Changelog

- 1.1 (2026-10-04): additive §46 fields — identity ancestry
  (`parentSessionId`, `role`), escalation attribution
  (`fromModel`/`toModel`/`thinking`), approval audit (`requested`,
  `justification`), durable-state leaves (`operations[]`, `memos[]`) and
  result evidence (`tests`, `artifacts`). Optional on read: 1.0 records
  still parse with no shim. `toModel` is required on write.
  (Machine-readable mirror: `TRAJECTORY_CHANGELOG` in `src/schema.ts`.)
- 1.0 (2026-09-23): initial stable export — all §46 fields, mandatory
  provenance + used-environment (fail-closed), §52 categories on
  failures, truncated observations, reserved eval slot.
  (Machine-readable mirror: `TRAJECTORY_CHANGELOG` in `src/schema.ts`.)
