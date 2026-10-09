# `@kubic/trajectory`

> The versioned trajectory export record.
> Source: `packages/trajectory/src`; the field contract is
> [`packages/trajectory/CONTRACT.md`](../../packages/trajectory/CONTRACT.md).

`@kubic/trajectory` publishes the export record: every run may emit one
JSON record sufficient for replay, benchmarking, SFT/RL datasets and
debugging — never claiming configuration the run did not use. The schema
is `stable` at major 1 (currently `1.0`): additive-only within the major,
same-major records parse with no shim, unknown fields are preserved, and
an unknown major is refused with `unknown-major` (exit 2). The field list,
the fail-closed rules and the changelog live in `CONTRACT.md`.

## Entry points

| Entry point | What it holds |
| --- | --- |
| `@kubic/trajectory/schema` | `TrajectoryExport` and its sections, the version, the result statuses and failure codes, and `parseTrajectoryExport` (`TrajectorySchemaError`: `unknown-major` or `malformed`, exit 2) |
| `@kubic/trajectory/export` | `buildTrajectoryExport`, which assembles and checks one record (`TrajectoryExportError`, exit 2, names the fail-closed rule a record broke) |

## Producers

The shipped binary writes one record per settled run at
`<sessions-root>/<id>/trajectory.json`. The file holds the session's
latest settled run, and the `trajectory` ref `kubic run` prints is its
absolute path. The producers are `kubic run -p` and each settled
`kubic tui` turn.

The pure assembler is `packages/host/src/run/run-trajectory.ts`
(`assembleRunTrajectory`, `trajectoryResultFor`, `taskIdForPrompt`,
`writeRunTrajectory`). The composition root gathers the I/O evidence in
`apps/kubic/src/run/trajectory.ts` (`persistRunTrajectory`,
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

A result status is `completed`, `failed`, `cancelled`, `timeout` or
`turn_limit`, and a failed run carries one of the lane's failure codes
(`packages/agent/src/lane/failures.ts`), which the schema snapshots. An
observation keeps at most 8 KiB. The fail-closed rules a record must pass
are in `CONTRACT.md`.

The package imports none of the shapes it records: the execution
environment (`exec` `env/`), file-change diffs (`exec` `journal/diff.ts`),
approval verdicts (`host` `approvals/`), usage rows (`agent` `usage.ts`) and
failure codes (`agent` `lane/failures.ts`) are structural snapshots pinned by
the golden fixture test.

## Dep-direction neighbours

- May import: [@kubic/core](core.md) only — never
  exec/agent/host/eval/tui.
- Read by: `kubic replay` and [@kubic/eval](eval.md) via
  `parseTrajectoryExport` — no shim, no adapter.

```text
core ──→ @kubic/trajectory ──→ replay, eval
```

Back to the [docs index](../README.md).
