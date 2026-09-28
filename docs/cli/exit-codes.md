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
| 1 | `failed` | Run failed without a more specific cause (including a `kubic run` interrupted by `SIGINT`/`SIGTERM`/`SIGHUP` — `run interrupted by <SIGNAL>`, after its in-flight tools were killed); doctor fail on deps (`deps-missing`), policy (`policy-mismatch`), or any op failure; `kubic git` op failures (including outside a repo); `sessions` usage and IO errors; journal IO failures; unknown top-level command. |
| 2 | `usage` | Bad invocation: `run` without `-p`, missing flag values, invalid `--session` id, unknown flags, `doctor --skip` without a value or with an unknown check id, `undo` with skipped steps — non-reversible, stale, or already-undone (see below). |
| 3 | `budget_exhausted` | The lane settled with a budget-classified error, or a headless `kubic run` hit its wall-clock/turn guard (`--timeout`, default 300000 ms; `--max-turns`). |
| 4 | `approval_denied` / `approval_timed_out` | Approval denied, or a bounded wait elapsed — **both labels map to exit 4**. The `status` string distinguishes: `approval_denied` when the recorded denial reasons name a refusal (no approval surface, a policy route, a decider's no); `approval_timed_out` when the reason carries the timeout marker — or when a headless run suspends on an approval that cannot arrive without a TTY. |
| 5 | `workspace_unavailable` | Session attach/store failures: missing session, `ENOENT`/`EACCES`-class store errors, worktree problems. Matched on the error's code, name and message words — never on a filesystem path the message merely names. |
| 6 | `provider_probe_failed` / provider-down | No reachable provider, or a resumed `--session` whose stored model is no longer registered (named: `session model '<id>' is unavailable: …`). Doctor exits 6 when any failing check has reason `provider-down`. |

## Per-command notes

- **`kubic doctor`**: 0 clean (warns included — `warn` is informational
  and never exit-flipping), 6 on any provider-down fail, 1 on any other
  fail, 2 on usage errors. `--json` reports the same code in its
  `exitCode` field.
- **`kubic diff/undo/log/status`**: 0 success (including empty diff and
  clean dry-run); 2 usage errors — unknown option, missing option value,
  a `--max-content-bytes` that is not a non-negative integer, an extra
  operand, an invalid or conflicting `--session` — with one `error:` line
  on stderr and nothing touched; 1 an unexpected IO failure (root
  catch-all). `undo` also exits **2** when it restored but skipped steps. Three skip classes reach that code:
  `non-reversible (skipped)` — entries an end-of-run reconciliation sweep
  appended (`unattributed`) whose baseline holds hashes, not pre-images
  (the exception is a path whose pre-image an earlier attributed entry in
  the same run already stored — there the sweep entry is reversible, `undo`
  restores it, and the exit code follows the normal rule);
  `stale (skipped)` — the file changed after the entry was journaled, so
  restoring would destroy unjournaled changes (issue #108; `--force`
  overrides per-invocation); and `already undone (skipped)` — a previous
  undo already unwound the step, nothing is rewritten. In every skipped
  class the exit is 2 and nothing is written for that step.
- **`kubic git`**: 0 success (including `log` on a repo with no commits
  yet); 1 an op failure or outside a git repository (one `error:` line on
  stderr); 2 usage errors (bare `kubic git`, unknown subcommand or option,
  missing value, `--max` not a positive integer, `stage` without a path,
  `commit` without a non-empty `-m`).
- **`kubic sessions` / `kubic models` / `kubic config`**: 0 success; 2
  usage errors (unknown option, missing or invalid value, stray operand,
  a missing `sessions` subcommand, `prune --yes --dry-run`); 1 op
  failure (`models --resolve` failure, a refused config, attaching a
  missing or live-locked session). An unknown `sessions` subcommand exits
  1 like an unknown top-level command. `sessions prune`: 0 for a dry run
  (including a declined terminal prompt), `nothing to prune`, and a
  completed prune; 1 for a missing keep window (no `--keep-days`, no
  `session.retentionDays`), a malformed sessions root, or a session that
  could not be removed.
- **`kubic --version`**: always 0.
- **`kubic --help` / `-h`**: always 0 — prints the top-level command
  listing (the same usage line an unknown command gets).
- **Bare `kubic`** (no command) off a TTY: 1, with the identical listing —
  usage-on-no-args is the deliberate POSIX posture, so `--help` and the
  bare invocation differ only in their exit code. On an interactive
  terminal a bare `kubic` opens the TUI and exits as `kubic tui` does.
- **Unexpected top-level failures** (a bug in a command's wiring, an
  unshaped IO error): one `error: <message>` line on stderr, 1 — the full
  stack only with `KUBIC_DEBUG=1` (see
  [doctor and debug](doctor-and-debug.md#when-a-command-dies-unexpectedly-kubic_debug)).
- **Below Node 22.19**: the launcher (`bin/kubic.js`) refuses by name
  before loading anything —
  `kubic: node >= 22.19 required (running <version>) — see the README
  install section`, exit 1.
- **`kubic run`**: 2 for every usage error (missing `-p`, unknown option,
  missing or invalid value, stray operand), before any lane boots.
  `KUBIC_PROVIDER` set to anything but `faux` ends `provider_probe_failed`
  (6). `--json`: the envelope's `ok` field is `exitCode === 0`.
- **`kubic run` approvals (exit 4)**: the code is 4 for the whole approval
  terminus; the `status` string is the honest half — `approval_denied` for a
  recorded refusal (no installed approval surface, a policy route, a
  decider's no) and `approval_timed_out` for a denial whose recorded reason
  carries the timeout marker (`timed out`) or a headless suspension on an
  approval that cannot arrive without a TTY (issue #129). A consumer that
  distinguishes "operator said no" from "nobody answered in time" must read
  `status`, never infer it from the exit code.
- **`kubic orchestrate`**: 0 all workers merged; 1 session-creation,
  spawn, worker, merge, or reap failure, or resume with no state
  (`error: … code=<code>` names it: `spawn_failed`, `worker_failed`,
  `result_invalid` (a worker exited 0 without a valid §68 result report),
  `spawn_denied`, `merge_failed`, `merge_conflict`,
  `no_orchestrator_state`, `reap_failed`); 2 usage errors and the non-git
  refusal (never silently solo); 4 approval denied **or** approval timeout
  — both map to exit 4, and the envelope's `status`, `error.kind` and
  `error.code` all name which: `approval_denied` when the decider is the
  user (a decided no — rerun with `--yes` to auto-approve merges), and
  `approval_timeout` when the interactive merge gate's bound
  (`approvals.maxPendingMs`) elapsed with nobody answering (a walked-away
  user — rerun with `--yes` to auto-approve merges). The exit code alone
  cannot tell them apart; read the label. `--json` reports the same code
  in its `exitCode` field. 3 when a worker exhausts its opt-in `--budget`.
  Parse errors (unknown flag, missing value, malformed `--agents` /
  `--session` / `--budget`) exit 2 before anything runs; every `error:`
  line is on stderr.
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
- **`kubic workers`**: 0 (an empty record included); 2 usage errors
  (unknown flag, stray operand, `--json=1`) with one `error:` line on
  stderr. The old usage-exit remap (1 → 2) is gone: the parser exits 2
  itself, so a 1 is always a real failure.
- **`kubic tui`**: 0 clean quit (final document printed), 2 usage
  errors (unknown options, missing values, operands, bad `--session`), 5
  missing session, 6 no reachable provider, 1 any other lane boot failure.
- **Analysis commands** (`eval`, `benchmark`, `replay`, `export`,
  `cost`, `perf`, `policy`, `audit`): an argv syntax error exits 2 with
  one commander `error: …` line on stderr and nothing on stdout, even
  under `--json`. Syntax errors are an unknown option, a missing value,
  a missing required option, or an extra operand.
- **`kubic cost`**: 0 success, including `no cost rows` on an empty
  store; 1 an unknown session or a store failure; 2 usage errors.
  `--json` emits the `toCostJson` shape field-for-field.
- **`kubic perf`**: 0 pass (the evaluation table, no regression line);
  1 breach (the table plus the exact filed regression string); 2 usage
  errors. `--measure` on a kind with no live source (`attach` and
  `teardown` today) is a usage error: it names `--samples` in one
  `error:` line instead of passing vacuously. `--json` emits the full
  evaluation either way; its `source` field tells callers whether the
  samples were measured or supplied on the command line.
- **`kubic policy` / `kubic audit`**: 0 query (an offer, never an
  enforcement), 2 usage errors. Audit output is redacted before
  printing (secret shapes and listed values never appear).

Back to the [docs index](../README.md). See also
[commands](commands.md) and [doctor and debug](doctor-and-debug.md).
