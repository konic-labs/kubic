# Exit codes

> What each exit code means, and when you see it.

## The codes

`kubic run` exits with the code for how the run ended, and `kubic doctor`
uses the same codes: 0 for a clean report, 6 when no provider is available,
1 for any other failure, and 2 for a usage error.

| Code | Status | When you see it |
| --- | --- | --- |
| 0 | `completed` | The run finished; the doctor report passed (warnings still exit 0). |
| 1 | `failed` | The run failed without a more specific cause (see [code 1](#1-failed)). |
| 2 | `usage` | A bad invocation: an unknown command, subcommand or flag, a missing value, an invalid `--session` id, `run` without a prompt, `doctor --skip` without a value or with an unknown check id, or a stray operand. |
| 3 | `turn_limit` | A headless `kubic run` hit its turn guard (`--max-turns`). The wall-clock `--timeout` is **not** here: it is `timeout`, exit 1. |
| 3 | `spend_limit` | A `[policy]` spend cap stopped `kubic run`: the run reached `max_run_cost_usd`, or the machine's day reached `max_daily_cost_usd` (a run on a day already spent is refused before a session exists). See [spend caps](enterprise.md#spend-caps). |
| 4 | `approval_denied`, `approval_timed_out` | An approval was denied, or its bounded wait ran out (see [code 4](#4-approval-denied-or-timed-out)). |
| 5 | `workspace_unavailable` | The session or its store cannot be used: a missing session, a store error, a worktree problem (see [code 5](#5-workspace-unavailable)). |
| 6 | `provider_probe_failed` | No provider is available before the run starts (see [code 6](#6-no-provider)). |

Two exits sit outside these codes, by the POSIX convention `kubic tui` also
follows: a `kubic run` interrupted by `SIGINT`, `SIGTERM` or `SIGHUP` settles
`status: cancelled` and exits `128 + signo` (129 `SIGHUP`, 130 `SIGINT`, 143
`SIGTERM`).

### 1: failed

The run failed without a more specific cause. That includes a headless `kubic
run` that hit its wall-clock bound (`status: timeout`, with `--timeout`,
default 300000 ms; there is no separate timeout code), a doctor failure on
the dependencies (`deps-missing`), the policy (`policy-mismatch`) or any
operation, `kubic git` failures (outside a repository too), `sessions` and
journal I/O errors, and an `undo` that restored some steps but skipped others:
the partial outcome has its own code, never the usage one.

### 4: approval denied or timed out

Both statuses exit 4, and the `status` string tells them apart:
`approval_denied` when the recorded denial reasons name a refusal (no
approval surface, a policy route, a decider's no), and `approval_timed_out`
when the reason carries the timeout marker, or when a headless run waits on
an approval that cannot arrive without a terminal.

### 5: workspace unavailable

Attaching a session or using its store failed: a missing session,
`ENOENT`- or `EACCES`-class store errors, worktree problems. A keyword that
appears only inside a filesystem path, such as a checkout under
`.claude/worktrees/` or `~/My workspace/`, does not count: a quoted string or
a whitespace-delimited word containing `/` or `\` is ignored, while an
unquoted path with spaces whose final segment is the keyword (`/home/My
workspace`) still counts, so quote it.

### 6: no provider

The check before the run found no reachable provider, or a resumed
`--session` whose stored model is not registered (`session model '<id>' is
unavailable: …`). A provider error **during** the run is not this code: it is
exit 1 with `status: provider_transient` or `provider_auth` and the matching
`failure.code`. Doctor exits 6 when any failing check has the reason
`provider-down`.

## Per-command notes

- **Unknown command / subcommand**: exit 2, stdout empty,
  and on stderr `error: unknown command '<name>'` (`unknown
  option '<flag>'` for an unknown root option) followed by hints: `hint:
  did you mean kubic <command>?` when a command is close (`kubic stauts`
  → `status`), otherwise `hint: to run it as a prompt: kubic run -p
  '<word>'` for a word-shaped token (a multi-word token is the bare prompt and runs like `kubic run -p`), and last `hint: kubic
  --help lists the commands`. A multi-word token that reads exactly as a
  command (`kubic "sessions list"`) is `error: quoted command '<token>'`,
  exit 2, with `hint: run it unquoted: kubic <token>` and the prompt form. `kubic help` and `kubic version` point at
  the real flags instead. On a colour terminal the same information is an
  error block (`✕ unknown command <name>`, indented hints, a faint `exit 2
  · usage`). A registered group's bad subcommand is commander's `error:
  unknown command '<name>'` on stderr. The one exception is the bare
  `kubic` (no command) off a TTY: the root help on stdout, exit 1 — POSIX
  usage-on-no-args, the deliberate scripted posture.
- **Diagnostics vs `--json`**: receipts, warnings and refusals — the
  `loaded models.json: …` note, the config refusal, colour/TTY notices — go
  to stderr, so a `--json` stdout is exactly one document.
- **Refused config**: one `error: <reason>` line on stderr, exit 1, for the
  agent-executing commands (`run`, `tui`, `replay`); the reporting commands
  (`config`, `doctor`, `trust`) still run so the reason can be read. Under
  `--json` (`run`, `replay`) stdout
  carries exactly one failure envelope instead of nothing — `ok:false`, the
  documented exit code, the named reason.
- **`kubic doctor`**: 0 clean (warns included — `warn` is informational
  and never exit-flipping), 6 on any provider-down fail, 1 on any other
  fail, 2 on usage errors. `--json` reports the same code in its
  `exitCode` field.
- **`kubic diff/undo/log/status`**: 0 success (including empty diff and
  clean dry-run); 2 usage errors — unknown option, missing option value,
  a `--max-content-bytes` that is not a non-negative integer, an extra
  operand, an invalid or conflicting `--session` — with one `error:` line
  on stderr and nothing touched; 1 an unknown `--session` (`error: unknown
  session: <id>`, and under `--json` one failure document with `ok: false`,
  `exitCode: 1` and `error: {code: "unknown_session", message}`) or an
  unexpected IO failure (root catch-all). `undo` also exits **1** when it
  restored but skipped steps. Three skip classes reach that code:
  `non-reversible (skipped)` — entries an end-of-run reconciliation sweep
  appended (`unattributed`) with no retrievable pre-image (the exceptions
  are a path clean against the git index at boot — the sweep restores its
  blob-OID pre-image from the object store — and a path whose pre-image an
  earlier attributed entry in the same run already stored — there the sweep
  entry is reversible, `undo` restores it, and the exit code follows the
  normal rule);
  `stale (skipped)` — the file changed after the entry was journaled, so
  restoring would destroy unjournaled changes (`--force` overrides per-invocation); `already undone (skipped)` — a previous
  undo already unwound the step, nothing is rewritten; and
  `head-moved (skipped)` — the entry predates a HEAD move the run observed
  (`--force` overrides per-invocation). In every skipped
  class the exit is 1 and nothing is written for that step. A live session
  lock refuses the whole invocation with exit 1 and one `error:`
  line naming the holder pid — `--force` overrides it, and nothing is
  planned, restored or journaled otherwise. A bare `undo` (no `--session`)
  also exits 1, naming every candidate, while another session recorded for
  the workspace is live; `--session <id>` chooses.
- **`kubic git`**: 0 success (including `log` on a repo with no commits
  yet); 1 an op failure or outside a git repository (one `error:` line on
  stderr), and for a bare `kubic git`, which prints the group's help; 2 usage
  errors (unknown subcommand or option, missing value, `--max` not a positive
  integer, `stage` without a path, `commit` without a non-empty `-m`).
- **`kubic sessions` / `kubic models` / `kubic config`**: 0 success; 2
  usage errors (unknown option, missing or invalid value, stray operand,
  an unknown `sessions` subcommand, `prune --yes --dry-run`); 1 op
  failure (`models --resolve` failure, a refused config, attaching or
  forking a missing or live-locked session, a `sessions fork --at` entry the
  source does not have). An unknown `sessions` subcommand exits
  2 like an unknown top-level command. `sessions prune`: 0 for a dry run
  (including a declined terminal prompt), `nothing to prune`, and a
  completed prune; 1 for a missing keep window (no `--keep-days`, no
  `session.retentionDays`), a malformed sessions root, or a session that
  could not be removed.
- **`kubic journal prune`**: 0 for a dry run, a completed prune and `nothing
  to prune`; 1 for a missing keep window (no `--keep-days`, no
  `journal.retentionDays`), a config the loader refused (for example
  `KUBIC_JOURNAL_RETENTION_DAYS=0.5`), an unknown `--session`, a live-run
  refusal (the session is attached by a live pid), or a pass that removed
  nothing while entries were listed; 2 for usage errors (a `--keep-days` that
  is not a non-negative integer of days, a file value that is not a
  non-negative integer, an unknown option). A bare `kubic journal` prints the
  group's help and exits 1.
- **`kubic trust`**: 0 recorded, revoked or listed; 2 usage errors
  (unknown option, a path that is not a directory, `--list` combined with
  `--revoke` or a path, stray operands); 1 an unreadable or corrupt store
  (the file is named). It runs even when the project config is refused —
  it is the repair path for exactly that refusal.
- **`kubic setup`**: 0 saved (or nothing to save under a
  frozen enterprise model), 2 off a terminal, 6 no provider has a key,
  130 cancelled (nothing written), 1 the config file could not be written.
- **`kubic --version`**: always 0.
- **`kubic --help` / `-h`**: always 0 — prints the top-level command
  listing (the root help). A command's own
  `--help` is also 0 and side-effect free: commander answers it before any
  action runs.
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
- **`kubic run`**: 2 for every usage error (missing `-p`/positional prompt,
  unknown option, missing or invalid value, stray operand, an unknown
  `--tools` name or one the permission classes forbid, `--tools` with
  `--no-tools`), before any session starts.
  `KUBIC_PROVIDER` set to anything but `faux` ends `provider_probe_failed`
  (6). `--json`: the envelope's `ok` field is `exitCode === 0`.
  A wall-clock `--timeout` elapse is `status: timeout`, exit 1;
  a `SIGINT`/`SIGTERM`/`SIGHUP` is `status: cancelled`, exit 128+signo.
- **`kubic run` failure codes**: every classified failure
  carries an additive `failure: {code, remedy, strategy}` in the `--json`
  envelope (a failure code such as `tool_failed`, `model_failed`,
  `provider_transient`, `run_limit`, plus the retry remedy and
  strategy). The run's own detail decides the code — the durable
  `model_error` reason is generic, so a rate-limit or tool-fault detail
  keeps its own code instead of collapsing into `model_failed`. A mid-run
  provider error is `provider_transient`/`provider_auth` (exit 1), never
  the pre-run probe code 6.
- **`kubic run` approvals (exit 4)**: the code is 4 for the whole approval
  terminus; the `status` string is the honest half — `approval_denied` for a
  recorded refusal (no installed approval surface, a policy route, a
  decider's no) and `approval_timed_out` for a denial whose recorded reason
  carries the timeout marker (`timed out`) or a headless suspension on an
  approval that cannot arrive without a TTY. A consumer that
  distinguishes "operator said no" from "nobody answered in time" must read
  `status`, never infer it from the exit code.
- **`kubic tui`**: 0 clean quit (final document printed), 2 usage
  errors (unknown options, missing values, operands, bad `--session`), 5
  missing session, 6 no reachable provider (a `KUBIC_PROVIDER` other than
  `faux` included), 1 any other failure to start.
  A signalled quit exits `128+signo` after the same drain, restore and
  session close as a keyboard quit: 129 `SIGHUP`, 130 `SIGINT`, 143
  `SIGTERM`. An exception in input or render, or an unhandled rejection,
  restores the terminal, prints `error: kubic tui crashed: …` on stderr and
  exits 1.
- **Analysis commands** (`eval`, `benchmark`, `replay`, `export`,
  `cost`, `policy`, `audit`): an argv syntax error exits 2 with
  one commander `error: …` line on stderr and nothing on stdout, even
  under `--json`. Syntax errors are an unknown option, a missing value,
  a missing required option, or an extra operand.
- **`kubic eval`**: 0 a record whose gates pass; 1 a record whose gates
  fail (a red tests/build/lint/typecheck signal, an incomplete run, or an
  unnamed runner failure as `eval-failed`); 2 usage errors and named
  runner refusals (`error: [<code>] …` — a missing or invalid `--size`,
  `--worktree`, a dirty `--workspace worktree`, an
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
- **`kubic policy` / `kubic audit`**: 0 query (an offer, never an
  enforcement), 2 usage errors. Audit output is redacted before
  printing (secret shapes and listed values never appear).

Back to the [docs index](../README.md). See also
[commands](commands.md) and [doctor and debug](doctor-and-debug.md).
