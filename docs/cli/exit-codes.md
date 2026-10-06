# Exit codes

> The table below covers the failure codes
> (plus 0) and matches the `kubic doctor` fixture behaviour:
> clean matrix → 0, provider-down → 6, any other fail → 1,
> usage error → 2 (verified in `packages/host/src/doctor.test.ts`).

## The failure codes

`kubic run` derives its exit code from the settled lane outcome
(`mapTerminusToExitCode` in `packages/host/src/run-cli.ts`); codes 0–6 are
its six §78 termini. `kubic doctor` exits through the same mapper shape
(`limitsDoctorExit` in `packages/host/src/limits/doctor-limits.ts`). Code 7
is the delegated-run partial terminus (issue #169): `kubic run` never exits 7,
because a single lane has no partial outcome to report.

Two signal-driven exits sit outside the six codes, using the POSIX
convention `kubic tui` also pins (issue #313): a `kubic run` interrupted by
`SIGINT`/`SIGTERM`/`SIGHUP` settles `status: cancelled` and exits
`128+signo` — 129 `SIGHUP`, 130 `SIGINT`, 143 `SIGTERM` (issue #280).

| Code | Terminus / meaning | When you see it |
| --- | --- | --- |
| 0 | `completed` / ok | Run finished; doctor matrix fully passing (warn-only checks still exit 0). |
| 1 | `failed` | Run failed without a more specific cause (including a headless `kubic run` that hit its wall-clock bound — `status: timeout` with `--timeout`, default 300000 ms, issue #280; §78 has no timeout code and a bound nobody configured as a budget is not one); doctor fail on deps (`deps-missing`), policy (`policy-mismatch`), or any op failure; `kubic git` op failures (including outside a repo); `sessions` IO errors; journal IO failures; an `undo` that restored but skipped steps (issue #372 — the partial outcome has its own code, never the usage one). |
| 2 | `usage` | Bad invocation: an unknown command or subcommand, unknown flags, missing flag values, an invalid `--session` id, `run` without a prompt (neither `-p` nor a positional), `doctor --skip` without a value or with an unknown check id, a stray operand, `sessions` without a subcommand. |
| 3 | `budget_exhausted` | The lane settled with a budget-classified error, or a headless `kubic run` hit its turn guard (`--max-turns`) or a configured §71 budget (`KUBIC_BUDGET`). The wall-clock `--timeout` is **not** here: it is `timeout`, exit 1 (issue #280). |
| 4 | `approval_denied` / `approval_timed_out` | Approval denied, or a bounded wait elapsed — **both labels map to exit 4**. The `status` string distinguishes: `approval_denied` when the recorded denial reasons name a refusal (no approval surface, a policy route, a decider's no); `approval_timed_out` when the reason carries the timeout marker — or when a headless run suspends on an approval that cannot arrive without a TTY. |
| 5 | `workspace_unavailable` | Orchestrator mode outside a git repository (`kubic orchestrate`, `kubic clean`, `kubic tui --orchestrator` and the bare `kubic --orchestrator` — issue #372), and session attach/store failures: missing session, `ENOENT`/`EACCES`-class store errors, worktree problems. Keywords that appear only inside a filesystem path (e.g. a checkout under `.claude/worktrees/` or `~/My workspace/`) do not count: a quoted string or a whitespace-delimited word containing `/` or `\` is ignored, an unquoted path with spaces whose final segment is the keyword (e.g. `/home/My workspace`) still counts; quote it. |
| 6 | `provider_probe_failed` / provider-down | The **pre-run probe**: no reachable provider, or a resumed `--session` whose stored model is no longer registered (named: `session model '<id>' is unavailable: …`). A provider error **during** the run is not this code: it is exit 1 with `status: provider_transient` or `provider_auth` and the matching `failure.code` (issue #155). Doctor exits 6 when any failing check has reason `provider-down`. |
| 7 | `partial` (`kubic orchestrate` only) | `--on-failure continue` and at least one worker failed while the run continued: whatever succeeded was merged, the failed workers are named with their own codes in the envelope (`status: "partial"`, `error.code: "partial_failure"`, `workers[].error.details.code`), and the failed ones stay pending for `--resume`. Without `--on-failure continue` a worker failure keeps the all-or-nothing exit 1 (or 3/4 for its own budget/approval terminus). |
## Per-command notes

- **Unknown command / subcommand**: exit 2 (issue #372), stdout empty,
  and on stderr (issue #450) `error: unknown command '<name>'` (`unknown
  option '<flag>'` for an unknown root option) followed by hints: `hint:
  did you mean kubic <command>?` when a command is close (`kubic stauts`
  → `status`), otherwise `hint: to run it as a prompt: kubic run -p
  '<word>'` for a word-shaped token (issue #268, L-D7 — a multi-word token
  is the bare prompt and runs like `kubic run -p`), and last `hint: kubic
  --help lists the commands`. `kubic help` and `kubic version` point at
  the real flags instead. On a colour terminal the same information is an
  error block (`✕ unknown command <name>`, indented hints, a faint `exit 2
  · usage`). A registered group's bad subcommand is commander's `error:
  unknown command '<name>'` on stderr. The one exception is the bare
  `kubic` (no command) off a TTY: the root help on stdout, exit 1 — POSIX
  usage-on-no-args, the deliberate scripted posture.
- **Diagnostics vs `--json`**: receipts, warnings and refusals — the
  `loaded models.json: …` note, the config refusal, colour/TTY notices — go
  to stderr, so a `--json` stdout is exactly one document (issue #244).
- **Refused config**: one `error: <reason>` line on stderr, exit 1, for the
  agent-executing commands (`run`, `orchestrate`, `tui`, `replay`); the
  reporting commands (`config`, `doctor`, `trust`) still run so the reason
  can be read. Under `--json` (`run`, `orchestrate`, `replay`) stdout
  carries exactly one failure envelope instead of nothing — `ok:false`, the
  documented exit code, the named reason (issue #244).
- **`kubic doctor`**: 0 clean (warns included — `warn` is informational
  and never exit-flipping), 6 on any provider-down fail, 1 on any other
  fail, 2 on usage errors. `--json` reports the same code in its
  `exitCode` field.
- **`kubic diff/undo/log/status`**: 0 success (including empty diff and
  clean dry-run); 2 usage errors — unknown option, missing option value,
  a `--max-content-bytes` that is not a non-negative integer, an extra
  operand, an invalid or conflicting `--session` — with one `error:` line
  on stderr and nothing touched; 1 an unexpected IO failure (root
  catch-all). `undo` also exits **1** when it restored but skipped steps. Three skip classes reach that code:
  `non-reversible (skipped)` — entries an end-of-run reconciliation sweep
  appended (`unattributed`) with no retrievable pre-image (the exceptions
  are a path clean against the git index at boot — the sweep restores its
  blob-OID pre-image from the object store — and a path whose pre-image an
  earlier attributed entry in the same run already stored — there the sweep
  entry is reversible, `undo` restores it, and the exit code follows the
  normal rule);
  `stale (skipped)` — the file changed after the entry was journaled, so
  restoring would destroy unjournaled changes (issue #108; `--force`
  overrides per-invocation); `already undone (skipped)` — a previous
  undo already unwound the step, nothing is rewritten; and
  `head-moved (skipped)` — the entry predates a HEAD move the run observed
  (issue #378; `--force` overrides per-invocation). In every skipped
  class the exit is 1 and nothing is written for that step. A live session
  lock (issue #337) refuses the whole invocation with exit 1 and one `error:`
  line naming the holder pid — `--force` overrides it, and nothing is
  planned, restored or journaled otherwise.
- **`kubic git`**: 0 success (including `log` on a repo with no commits
  yet); 1 an op failure or outside a git repository (one `error:` line on
  stderr); 2 usage errors (bare `kubic git`, unknown subcommand or option,
  missing value, `--max` not a positive integer, `stage` without a path,
  `commit` without a non-empty `-m`).
- **`kubic sessions` / `kubic models` / `kubic config`**: 0 success; 2
  usage errors (unknown option, missing or invalid value, stray operand,
  a missing `sessions` subcommand, `prune --yes --dry-run`); 1 op
  failure (`models --resolve` failure, a refused config, attaching or
  forking a missing or live-locked session, a `sessions fork --at` entry the
  source does not have). An unknown `sessions` subcommand exits
  2 like an unknown top-level command (issue #372). `sessions prune`: 0 for a dry run
  (including a declined terminal prompt), `nothing to prune`, and a
  completed prune; 1 for a missing keep window (no `--keep-days`, no
  `session.retentionDays`), a malformed sessions root, or a session that
  could not be removed.
- **`kubic trust`**: 0 recorded, revoked or listed; 2 usage errors
  (unknown option, a path that is not a directory, `--list` combined with
  `--revoke` or a path, stray operands); 1 an unreadable or corrupt store
  (the file is named). It runs even when the project config is refused —
  it is the repair path for exactly that refusal.
- **`kubic setup`** (issue #451): 0 saved (or nothing to save under a
  frozen enterprise model), 2 off a terminal, 6 no provider has a key,
  130 cancelled (nothing written), 1 the config file could not be written.
- **`kubic --version`**: always 0.
- **`kubic --help` / `-h`**: always 0 — prints the top-level command
  listing (the root help). A command's own
  `--help` is also 0 and side-effect free: commander answers it before any
  action runs (issue #245).
- **Bare `kubic`** (no command) off a TTY: 1, with the identical listing —
  usage-on-no-args is the deliberate POSIX posture, so `--help` and the
  bare invocation differ only in their exit code. On an interactive
  terminal a bare `kubic` opens the TUI and exits as `kubic tui` does.
  `kubic --orchestrator` (issue #327) is the same bare form with the
  orchestrator opt-in: on a TTY it is exactly `kubic tui --orchestrator`;
  off a TTY it is the root help and exit 1, like every other bare flag.
- **Unexpected top-level failures** (a bug in a command's wiring, an
  unshaped IO error): one `error: <message>` line on stderr, 1 — the full
  stack only with `KUBIC_DEBUG=1` (see
  [doctor and debug](doctor-and-debug.md#when-a-command-dies-unexpectedly-kubic_debug)).
- **Below Node 22.19**: the launcher (`bin/kubic.js`) refuses by name
  before loading anything —
  `kubic: node >= 22.19 required (running <version>) — see the README
  install section`, exit 1.
- **`kubic run`**: 2 for every usage error (missing `-p`/positional prompt,
  unknown option, missing or invalid value, stray operand, an unknown
  `--tools` name or one the permission classes forbid, `--tools` with
  `--no-tools`), before any lane boots.
  `KUBIC_PROVIDER` set to anything but `faux` ends `provider_probe_failed`
  (6). `--json`: the envelope's `ok` field is `exitCode === 0`.
  A wall-clock `--timeout` elapse is `status: timeout`, exit 1 (issue #280);
  a `SIGINT`/`SIGTERM`/`SIGHUP` is `status: cancelled`, exit 128+signo.
- **`kubic run` §52 failure codes (issue #155)**: every classified failure
  carries an additive `failure: {code, remedy, strategy}` in the `--json`
  envelope (a §52 code such as `tool_failed`, `model_failed`,
  `provider_transient`, `budget_exhausted`, plus the retry remedy and
  strategy). The lane's own detail decides the code — the durable
  `model_error` reason is generic, so a rate-limit or tool-fault detail
  keeps its own code instead of collapsing into `model_failed`. A mid-run
  provider error is `provider_transient`/`provider_auth` (exit 1), never
  the pre-run probe code 6.
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
  `no_orchestrator_state`, `reap_failed`, plus the lane codes
  `manager_turn_bound`, `lane_model_unresolved`, `lane_resume_failed`
  and `lane_provider_unreachable` (opt-in `--manager-lane` only, issue
  #431); 2 usage errors; 5 the non-git
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
  `--session` / `--budget` / `--on-failure`) exit 2 before anything runs;
  every `error:` line is on stderr. 7 only under `--on-failure continue`,
  when one or more workers failed and the run merged the rest (see the
  table row above).
- **`kubic clean`**: 0 success — including `--dry-run` (which mutates
  nothing) and a second run over an already-clean repo
  (`clean: nothing to prune`); 1 a hard failure (a dirty worktree without
  `--force`, a failing branch delete, an unknown `--session`), with one
  `error:` line per failure and nothing half-disposed (a worktree that
  survived keeps its branch); 2 usage errors (unknown flag, missing or
  invalid flag value, `--all` with `--session`); 5 the non-repo refusal
  (`… needs a git repository … nothing was removed`, nothing touched —
  under `--json` the refusal is the same envelope with `exitCode: 5` and
  empty `worktrees`/`branches`).
  `--json` emits `{ok, exitCode, dryRun, worktrees, branches, journal,
  failures?}` and reports the same code in `exitCode`.
- **`kubic workers`**: 0 (an empty record included); 2 usage errors
  (unknown flag, unknown subcommand, `--json=1`) with one `error:` line on
  stderr. The old usage-exit remap (1 → 2) is gone: the parser exits 2
  itself, so a 1 is always a real failure. `inspect`/`terminate` on an
  unknown id exit 1 (`code=no_such_worker`); `terminate` on a settled
  worker, a gone pid or a reused pid exits 1 (`code=worker_not_running`)
  without signalling anything; `terminate --generation <n>` on a replaced
  worker exits 2 (`code=stale_generation`).
- **`kubic tui`**: 0 clean quit (final document printed), 2 usage
  errors (unknown options, missing values, operands, bad `--session`), 5
  missing session, 6 no reachable provider, 1 any other lane boot failure.
  A session resolved into orchestrator mode (`--orchestrator`, or
  `[modes] orchestrator = true` with no flag) refuses **before the
  alt-screen** when the working directory is not a git repository: one
  `error: orchestrator mode needs a git repository …` line on stderr and
  exit 5. No prompts were taken and nothing ran; solo sessions never probe
  git.
  A signalled quit exits `128+signo` after the same drain, restore and
  session close as a keyboard quit: 129 `SIGHUP`, 130 `SIGINT`, 143
  `SIGTERM`. An exception in input or render, or an unhandled rejection,
  restores the terminal, prints `error: kubic tui crashed: …` on stderr and
  exits 1.
- **Analysis commands** (`eval`, `benchmark`, `replay`, `export`,
  `cost`, `perf`, `policy`, `audit`): an argv syntax error exits 2 with
  one commander `error: …` line on stderr and nothing on stdout, even
  under `--json`. Syntax errors are an unknown option, a missing value,
  a missing required option, or an extra operand.
- **`kubic eval`**: 0 a record whose gates pass; 1 a record whose gates
  fail (a red tests/build/lint/typecheck signal, an incomplete run, or an
  unnamed runner failure as `eval-failed`); 2 usage errors and named
  runner refusals (`error: [<code>] …` — a missing or invalid `--size`,
  `--generation` or `--worktree`, a dirty `--workspace worktree`, an
  unreadable/malformed `--trajectory` file (`trajectory-unreadable` /
  `trajectory-malformed`), a `--trajectory` provenance mismatch, a
  record-validation failure (`invalid-record`), an unknown suite, or a
  stub suite).
  `--json` reports the same code in its `exitCode` field; `ok` is
  `exitCode === 0`.
- **`kubic benchmark`**: 0 every executed suite succeeded; 1 any executed
  suite failed; 2 usage errors, a runner that threw and a selection with no
  executable suite (`no-executable-suites` — `benchmark: no executable
  suites selected`). In a matrix with at least one executable suite, stub
  suites are reported `skipped (stub)` and never count toward the verdict;
  an all-stub selection refuses before the table is printed. `--json`
  reports the same code in its `exitCode` field.
- **`kubic export`**: 0 the record was exported or the file described;
  1 the record failed to build or validate (`invalid-record`,
  `export-failed`); 2 a usage error or a refusal (a missing or unknown
  flag, an unreadable or malformed trajectory, or stripped provenance —
  `rl-refused`). `--json` reports the same code in its `exitCode` field.
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
