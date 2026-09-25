# Exit codes

> Design ref: §78 exit codes. The table below covers all six failure
> codes (plus 0) and matches the `kubic doctor` fixture behaviour:
> clean matrix → 0, provider-down → 6, any other fail → 1,
> usage error → 2 (verified in `packages/host/src/doctor.test.ts`).

## The six codes (`kubic run` termini)

`kubic run` derives its exit code from the settled lane outcome
(`mapTerminusToExitCode` in `packages/host/src/run-cli.ts`).
`kubic doctor` exits through the same mapper shape
(`limitsDoctorExit` in `packages/host/src/limits/doctor-limits.ts`).

| Code | Terminus / meaning | When you see it |
| --- | --- | --- |
| 0 | `completed` / ok | Run finished; doctor matrix fully passing (warn-only checks still exit 0). |
| 1 | `failed` | Run failed without a more specific cause; doctor fail on deps (`deps-missing`), policy (`policy-mismatch`), or any op failure; `kubic git` / `sessions` / journal usage and IO errors; unknown top-level command. |
| 2 | `usage` | Bad invocation: `run` without `-p`, missing flag values, invalid `--session` id, unknown flags, `doctor --skip` without a value or with an unknown check id, `undo` with non-reversible skips (see below). |
| 3 | `budget_exhausted` | The lane settled with a budget-classified error, or a headless `kubic run` hit its wall-clock/turn guard (`--timeout`, default 300000 ms; `--max-turns`). |
| 4 | `approval_denied` | Approval denied — or timed out waiting (`approval_timed_out` maps here too; headless runs suspend this way when an approval cannot arrive without a TTY). |
| 5 | `workspace_unavailable` | Session attach/store failures: missing session, `ENOENT`/`EACCES`-class store errors, worktree problems. |
| 6 | `provider_probe_failed` / provider-down | No reachable provider. Doctor exits 6 when any failing check has reason `provider-down`. |

## Per-command notes

- **`kubic doctor`**: 0 clean (warns included — `warn` is informational
  and never exit-flipping), 6 on any provider-down fail, 1 on any other
  fail, 2 on usage errors. `--json` reports the same code in its
  `exitCode` field.
- **`kubic diff/undo/log/status`**: 0 success (including empty diff and
  clean dry-run), 1 usage/IO errors — except `undo`, which exits **2**
  when it restored but skipped non-reversible steps.
- **`kubic git` / `kubic sessions` / `kubic models`**: 0 success, 1
  usage or op failure (`models --resolve` failure exits 1).
- **`kubic --version`**: always 0.
- **`kubic run --json`**: the envelope's `ok` field is `exitCode === 0`.
- **`kubic orchestrate`**: 0 all workers merged; 1 session-creation,
  spawn, worker, merge, or reap failure, or resume with no state
  (`error: … code=<code>` names it: `spawn_failed`, `worker_failed`,
  `spawn_denied`, `merge_failed`, `merge_conflict`,
  `no_orchestrator_state`, `reap_failed`); 2 usage errors and the non-git
  refusal (never silently solo); 4 approval denied (the decider is the
  user — rerun with `--yes` to auto-approve). `--json` reports the same
  code in its `exitCode` field.
- **`kubic clean`**: 0 success — including `--dry-run` (which mutates
  nothing) and a second run over an already-clean repo
  (`clean: nothing to prune`); 1 a hard failure (a dirty worktree without
  `--force`, a failing branch delete, an unknown `--session`), with one
  `error:` line per failure and nothing half-disposed (a worktree that
  survived keeps its branch); 2 usage errors (unknown flag, missing or
  invalid flag value, `--all` with `--session`) and the non-repo refusal
  (`… needs a git repository … nothing was removed`, nothing touched).
  `--json` emits `{ok, exitCode, dryRun, worktrees, branches, journal,
  failures?}` and reports the same code in `exitCode`.
- **`kubic tui`**: 0 clean quit (final document printed), 2 usage
  errors (unknown flags, bad `--session`), 5 missing session, 6 no
  reachable provider, 1 any other lane boot failure.
- **`kubic cost`**: 0 success (including `no cost rows` on an empty
  store), 1 unknown session / store failure, 2 usage errors. `--json`
  emits the `toCostJson` shape field-for-field.
- **`kubic perf`**: 0 pass (prints nothing gated), 1 breach (prints the
  exact filed regression string), 2 usage errors. `--json` emits the
  full evaluation either way.
- **`kubic policy` / `kubic audit`**: 0 query (an offer, never an
  enforcement), 2 usage errors. Audit output is redacted before
  printing (secret shapes and listed values never appear).

Back to the [docs index](../README.md). See also
[commands](commands.md) and [doctor and debug](doctor-and-debug.md).
