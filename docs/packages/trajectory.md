# `@kubic/trajectory`

> The versioned trajectory export record.
> Source: `packages/trajectory/src`; the field contract is
> [`packages/trajectory/CONTRACT.md`](../../packages/trajectory/CONTRACT.md).

`@kubic/trajectory` publishes the export record: every run may emit one
JSON record sufficient for replay, benchmarking, SFT/RL datasets and
debugging — never claiming configuration the run did not use. The schema
is `stable` at major 1 (currently `1.0`): additive-only within the major,
same-major records parse with no shim, unknown fields are preserved, and
an unknown major is refused with `unknown-major` (exit 3). The field list,
the fail-closed rules and the changelog live in `CONTRACT.md`.

## Public API (`packages/trajectory/src`)

| Module | Exports |
| --- | --- |
| `schema.ts` | `TrajectoryExport` and every section interface, `TRAJECTORY_FIELDS`, `SCHEMA_VERSION/MAJOR`, `TRAJECTORY_FAILURE_CODES`, `isTrajectoryFailureCode`, `RESULT_STATUSES`, `TrajectorySchemaError`, `TrajectorySchemaErrorCode`, `parseTrajectoryExport`, `parseTrajectoryExportJSON` |
| `export.ts` | `BuildTrajectoryInput`, `RawObservation`, `buildTrajectoryExport`, `MAX_OBSERVATION_BYTES`, `TrajectoryExportError`, `TrajectoryExportErrorCode` |
| `index.ts` | Re-exports the surface above; callers import `export.ts` / `schema.ts` directly |

## Producers

The shipped binary writes one record per settled run at
`<sessions-root>/<id>/trajectory.json`. The file holds the session's
latest settled run, and the `trajectory` ref `kubic run` prints is its
absolute path. The producers are `kubic run -p` and each settled
`kubic tui` turn.

The pure assembler is `packages/host/src/run/run-trajectory.ts`
(`assembleRunTrajectory`, `trajectoryResultFor`, `taskIdForPrompt`,
`writeRunTrajectory`). The composition root gathers the I/O evidence in
`apps/kubic/src/run-trajectory.ts` (`persistRunTrajectory`,
`resolveSessionTrajectory`). What each section is built from:

| Section | Source |
| --- | --- |
| `actions` / `observations` | This run's session entries, in `seq` order: assistant `toolCall` parts and their `toolResult` messages. Entries older than the run's start (a resumed session) are left out. |
| `usage` | The per-request `usage` on this run's assistant messages; `byModel` is keyed `provider/model`. |
| `diff` | This session's journal changes since the run started. An omitted after-side keeps its path with no hunks. |
| `approvals` | This session's audit-ledger records since the run started: `ok` becomes approved, a timeout reason becomes timed-out, anything else denied. |
| `identity` | The session and agent ids. |
| `provenance` | Session and agent ids; `pid` = the process; `worktree` = the run's cwd; `model` = `provider/id`, or `none/none` when the run ended before a model was selected. |
| `worktree` | `git rev-parse HEAD` and the branch (null when detached); `no-vcs` outside a git checkout. |
| `environment` | The env the lane spawns tools with, with every secret-classified value redacted. |
| `task` | `taskId` is `prompt:<sha256 prefix>`, stable per prompt text, so two runs of one prompt can be paired. `role` is the role the run ran as (`default` without `--role`). |
| `result` | The run's terminus mapped to a result status and failure category. Lane failures go through `classifyFailure`; a wall-clock timeout is `timeout` and the `--max-turns` stop is `turn_limit`, both with category `run_limit`; a boot failure or interrupt is `process_crashed` (an interrupt is `cancelled`). |

## Contracts

`RESULT_STATUSES` is `completed`, `failed`, `cancelled`, `timeout`,
`turn_limit`. `TRAJECTORY_FAILURE_CODES` snapshots the 16 lane failure
codes owned by `packages/agent/src/lane/failures.ts` (pinned equal by
test): `model_failed`, `model_refused`, `provider_transient`,
`provider_auth`, `tool_failed`, `tool_invalid_args`, `tool_timeout`,
`tool_unavailable`, `process_crashed`, `process_spawn_failed`,
`workspace_failed`, `context_overflow`, `context_polluted`, `run_limit`,
`approval_denied`, `approval_timed_out`.

`buildTrajectoryExport` takes `task`, `identity`, `model`, `prompt`,
`resources`, `actions`, `observations: RawObservation[]`
(`{ seq, actionSeq, output }`), `state`, `provenance`, `environment`,
`worktree`, `diff`, `approvals`, `timestamps: { startedAt, endedAt }`,
`usage`, `result` and `eval?`. `MAX_OBSERVATION_BYTES` is 8 KiB. Build
failures throw `TrajectoryExportError` (exit 2) with
`TrajectoryExportErrorCode`: `missing-provenance`, `invalid-provenance`,
`missing-environment`, `untrusted-environment`,
`missing-failure-category`, `contradictory-result`, `invalid-timestamps`,
`invalid-usage`, `invalid-escalation`. Parse failures throw
`TrajectorySchemaError` (exit 3): `unknown-major` | `malformed`.

The package imports none of the shapes it records: the execution
environment (`exec` `env/`), file-change diffs (`exec`
`journal/diff.ts`), approval verdicts (`host` `approvals/`), usage rows
(`agent` `usage.ts`) and failure codes (`agent` `lane/failures.ts`) are
structural snapshots pinned by the golden fixture test.

## Dep-direction neighbours

- May import: [@kubic/core](core.md) only — never
  exec/agent/host/eval/tui.
- Read by: `kubic replay` and [@kubic/eval](eval.md) via
  `parseTrajectoryExport` — no shim, no adapter.

```text
core ──→ @kubic/trajectory ──→ replay, eval
```

Back to the [docs index](../README.md).
