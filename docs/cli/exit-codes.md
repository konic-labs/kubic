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
| 3 | `budget_exhausted` | The lane settled with a budget-classified error. |
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

Back to the [docs index](../README.md). See also
[commands](commands.md) and [doctor and debug](doctor-and-debug.md).
