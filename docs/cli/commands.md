# CLI commands

> Design ref: §84 flows; `apps/kubic/src/main.ts` is the composition root.
> Every command and flag below was verified live against its
> `run*Command` implementation (exit codes included) — nothing here is
> documented from memory. Behaviour operators see only; package
> internals live on the [packages pages](../packages/README.md).

`kubic --version` (or `-V`) prints `kubic <version> (license: MIT)` —
the version comes from the nearest `kubic` package manifest
(`apps/kubic/package.json` for src runs, the repo root for `dist/` runs) —
and exits 0.
Build first (`npm run build`), then invoke `./bin/kubic.js` (or
`npm run kubic -- …`); anything else dispatches below; an unknown command prints
`usage: kubic <sessions | git | models | diff | undo | log | status | run | orchestrate | tui | doctor | workers | eval | benchmark | replay | export | cost | perf | policy | audit>`
and exits 1. Solo mode runs in-process with your user authority: no
isolation, no containment — approvals plus the journal are the controls.
Orchestrator mode (`orchestrate`) is opt-in — `run` never delegates.

## `kubic run -p <prompt> [--session <id>] [--json]`

Non-interactive solo run: no alt-screen, no prompt, consumable output.

| Flag | Meaning |
| --- | --- |
| `-p`, `--prompt <text>` | **Required.** The prompt to run headless. |
| `--session <id>` | Resume into an existing session. Ids accept only `[A-Za-z0-9_-]` — anything else exits 2 before any store is touched. |
| `--json` | Emit one JSON envelope (`ok`, `exitCode`, `sessionId`, `status`, `result`, `journal`/`usage`/`trajectory` refs, optional `error`) instead of human lines. |

Text output prints `result:`, `session:`, `journal:` (`journal:<id>`),
`usage:` (`usage:<id>`), `trajectory:` (`trajectory:<id>`); on failure an
`error:` line comes first. Exit code is the §78 terminus map — see
[exit codes](exit-codes.md). Missing `-p`, a `-p`/`--session` without a
value, an invalid `--session` id, or an unknown flag all exit 2.

## `kubic orchestrate -p <prompt> [--agents <a,b>] [--session <id>] [--resume] [--yes] [--json]`

Opt-in orchestrator mode: plans N workers, spawns one worker process per
subagent in its own git worktree (`kubic/<agent>` at
`<root>/.kubic/wt/<agent>`), settles/merges FIFO through the merge queue
with per-agent attribution, routes merge approvals to the user, and reaps.
The manager authors nothing — workers commit on their own branches, the
manager only merges. Worktrees and branches stay retained after the merge
as evidence (only `kubic clean` disposes). Requires a git repo: outside one
the command refuses with exit 2 and never silently runs solo. Worker runs
need a configured provider (each worker is a child `kubic run -p`).

| Flag | Meaning |
| --- | --- |
| `-p`, `--prompt <text>` | **Required** (unless `--resume`). The prompt every worker runs. |
| `--agents <a,b>` | Worker ids (default `worker-1,worker-2` — the two-worker demo). Ids accept only `[A-Za-z0-9_-]`, must be unique (one worktree per writer). |
| `--session <id>` | Session scope (default `orch-<now>`). Same `[A-Za-z0-9_-]` rule as `run`. State persists at `<repo>/.kubic/orchestrator/<id>.json`. |
| `--resume` | Re-attach after a kill: merges only pending workers in the original order, never re-merges. Needs `--session`. No stored state exits 1 (`code=no_orchestrator_state`); a stopped queue re-reports the conflict and merges nothing (`code=merge_conflict`). |
| `--yes` | Auto-approve merges (non-interactive). Without it, a TTY is asked per merge; headless without a decider denies closed with exit 4. |
| `--json` | One JSON envelope (`ok`, `exitCode`, `sessionId`, `status`, `workers`, `mergeOrder`, `attribution`, optional `error` with a machine-readable `code`). |

Text output prints `session:`, one `worker: <id> branch=<b> hunks=<n>` line
per worker, `merge order: a -> b`, `attribution: a=<n> hunk(s), …`, one
`merged:`/`reaped:` line per worker, then `result:`. Failures print
`error: <message> code=<code>` and exit 1 (spawn/worker/merge/reap
failures), 2 (usage, non-git refusal), or 4 (approval denied) — see
[exit codes](exit-codes.md). A merge conflict aborts first (never a
half-merged tree), stops the queue, and preserves the remaining candidates.

## `kubic tui [--session <id>]`

Interactive solo TUI: the alt-screen over the solo lane. Tree,
transcript, and status rows render in root order; `T`/`t` toggles the
tree, `Ctrl-C` quits — quitting restores the main screen and prints the
final document (no cursor loss on interrupt). Below 80 columns the tree
hides and transcript plus status stay. `--session <id>` resumes into an
existing session (same `[A-Za-z0-9_-]` rule as `run` — anything else
exits 2 before the lane boots). Lane boot failure exits 5 on a missing
session, 6 with no reachable provider, 1 otherwise. Only `SIGINT`
(`Ctrl-C`) is handled — `SIGTERM`/`SIGHUP` have no handler and exit
without restoring the alt-screen. Solo mode runs
in-process with your user authority: no isolation, no containment.

## `kubic sessions`

Sessions live under `~/.kubic/sessions` by default.

```
usage: kubic sessions <create [--cwd <path>] [--dangerously-skip-approvals] | list | attach <id> [--tail <n>]>
```

| Subcommand | Meaning |
| --- | --- |
| `create [--cwd <path>] [--dangerously-skip-approvals]` | Create a session, print its id. `--cwd` sets the session directory (default: current directory). `--dangerously-skip-approvals` records session-scoped full-access in the session dir and prints a warning — fresh sessions start safe, the flag must be passed explicitly every time. |
| `list` | One `<id>  <cwd>` line per session. |
| `attach <id> [--tail <n>]` | Print session metadata, the approvals posture (`approvals enforced` or `full-access …`), then the last `--tail` transcript entries (default 10) truncated to 300 chars each. `--tail` needs a non-negative integer. |

Missing subcommand exits 1 with the usage line; `attach` without an id
or with an id outside `[A-Za-z0-9_-]` exits 1; attaching a missing
session exits 1.

## `kubic git`

Thin over git ops. Outside a repo every subcommand exits 1 with
`not a git repository — kubic diff/undo still work without git` — the
journal path never needs git.

```
usage: kubic git <status [--json] | log [--max <n>] [--json] | stage <path...> | commit -m <message>>
```

| Subcommand | Meaning |
| --- | --- |
| `status [--json]` | Branch (plus ahead/behind when non-zero), `staged:`/`modified:`/`untracked:` lines, or `clean`. |
| `log [--max <n>] [--json]` | `<sha8> <date> <author>: <message>` per commit, or `no commits`. `--max` needs a positive integer. |
| `stage <path...>` | Stage paths, print `staged <p>` per path. Needs at least one path. |
| `commit -m <message>` | Commit, print `committed <sha8> (<n> file(s))`. Needs `-m <message>`. |

## `kubic diff | undo | log | status`

VCS-independent change journal — works without git. Each command reads
one store: `<root>/.kubic/journal` by default (the interactive solo
journal for the current directory), or — with `--session <id>` — the
headless-run session journal at `<sessions-root>/<id>/journal`
(`~/.kubic/sessions` by default). `kubic run` prints the session's ref
as `journal:<id>`; pass it verbatim (`--session journal:<id>` or
`--session <id>`) to diff/undo that run's file effects from any cwd
with no path lookup. `undo --dry-run` plans against the same store
`diff` reads. Session ids accept only `[A-Za-z0-9_-]` — anything else
(including `../` or absolute paths) exits 1 before any path is touched.

```
usage: kubic <diff [--path <p>] [--agent <id>] [--json] [--session <id>] | undo [<path>] [--step] [--dry-run] [--session <id>] | log [--session <id>] | status [--session <id>]>
```

| Subcommand | Meaning |
| --- | --- |
| `diff [--path <p>] [--agent <id>] [--json] [--session <id>]` | Rendered diff of journaled changes (`no changes` + exit 0 when empty). `--path`/`--agent` filter; `--json` prints the raw change array. A `--path`/`--agent`/`--session` without a value exits 1. |
| `undo [<path>] [--step] [--dry-run] [--session <id>]` | Restore journaled changes. Positional `<path>` limits scope; `--step` restores one step; `--dry-run` prints `would restore N step(s)…` and exits 0 without touching anything. Real runs print `restored <p>` per path plus `undo: N restored, M non-reversible`. `nothing to undo` exits 0. **Exit 2 when any step was skipped as non-reversible** (`non-reversible (skipped): <p>`). The `--session` value selects the store, never the path scope. |
| `log [--json] [--session <id>]` | One line per journal entry (`journal is empty` + exit 0 when empty); `--json` prints the raw entries array. |
| `status [--session <id>]` | `entries: N (reversible: R, non-reversible: M)` plus repo line: `repo: non-repo directory (journal works without git)` or `repo: branch <b>, dirty: yes|no|unknown`. |

## `kubic models`

Catalog readout over built-ins plus `models.json` customs in the
current directory (absent or invalid `models.json` is reported as a
`loaded models.json: …` / `models.json ignored: …` note, never fatal).

| Flag | Meaning |
| --- | --- |
| (none) | `provider <id> (<name>)` plus one `  <model> — thinking: <levels> — $in/$out per 1M in/out` line per model; `no providers registered (add models.json or set provider env keys)` when empty. Exits 0. |
| `--json` | The same catalog as JSON. Exits 0. |
| `--resolve <provider/id>` | Print `selected <provider>/<id> (thinking: …)` or `error: …`. Needs a value; resolution failure exits 1. |

## `kubic doctor`

Health readout — see [doctor and debug](doctor-and-debug.md).

| Flag | Meaning |
| --- | --- |
| `--skip <id[,id…]>` | Mark checks skipped (comma-separated). An id that matches no check exits 2; `--skip` without a value exits 2. |
| `--json` | Emit `{ok, exitCode, checks}` instead of human lines. Same exit code either way. |

Unknown flags exit 2. Full exit-code contract is on the
[exit-codes page](exit-codes.md).

## `kubic workers [--json] [--debug]`

Live worker list over the process registry: one line per worker with
the §13 status verbatim, age, owner, pid, startup span ms, and
resources (`skills=… templates=…`, `-` when none). A one-shot CLI
carries no orchestrator, so the registry is empty — no text output (`--json` prints `[]`), exit 0.

| Flag | Meaning |
| --- | --- |
| (none) | `<id>  <status>  gen=<n>  age=<age>  owner=<owner>  pid=<pid>  startup=<ms>  resources=<…>` per worker. |
| `--json` | The same rows as JSON (`workerId`, `sessionId`, `generation`, `status`, `ageMs`, `owner`, `resources`, `pid`, `startupMs`) — field-for-field with the text view. |
| `--debug` | `[worker] spawn …` per row plus `[exit] code=0 exited cleanly` on stderr. Spawn env values are always redacted (`KUBIC_ROLE_*` never prints). |

An unknown flag prints `usage: kubic workers [--json] [--debug]` and
exits 2 (no stack trace).

## `kubic eval (--task <prompt> | --trajectory <json>) --suite <id> --model <id> --worktree <path> --generation <n> --tier <smoke|standard|extended> [--workspace inline|worktree] [--thinking <level>] [--json]`

Score one suite against a task prompt or an existing trajectory
export. `--worktree`, `--generation`, and `--tier` are mandatory
provenance: a record missing any of them is rejected (exit 2), never
stored. Every record carries `success`, `costUsd`, `tokens`,
`latencyMs`, `toolCalls`, `model`, `thinking`, `worktree`,
`generation`, and `tier`.

| Flag | Meaning |
| --- | --- |
| `--task <prompt>` | Execute the suite against a task prompt. Needs a live model-backed suite runner the binary does not ship — exits 1 with a pointer to `--trajectory` instead of scoring fiction. |
| `--trajectory <json>` | Score an existing trajectory export (inline JSON) without re-running anything. Fully live: exit 0 with the record, 1 when the gates fail it. |
| `--suite <id>` | **Required.** One of the built-in suites (`swe-bench-mini`, `repo-mod-rename`, `bugfix-repro`, `refactor-extract`, `testgen-cover`, `review-diff`; `terminal-live` and `agentic-live` are stubs and refuse with exit 2). Unknown suites exit 2. |
| `--model <id>` | `provider/id` of the run (default `faux/faux`). |
| `--worktree <path>` | **Required.** Where the run executed. |
| `--generation <n>` | **Required.** Worker generation that ran. |
| `--tier <smoke\|standard\|extended>` | **Required.** Published on every record. |
| `--workspace inline\|worktree` | `worktree` refuses (exit 2) unless `git status --porcelain` in `--worktree` is clean; anything else exits 2. Default `inline`. |
| `--thinking <level>` | Recorded on the record verbatim. |
| `--json` | One JSON envelope (`ok`, `exitCode`, `record` or `error`) instead of the human line. Same exit code either way. |

## `kubic benchmark [--suite <id>] --model <id> --worktree <path> --generation <n> --tier <smoke|standard|extended> [--workspace inline|worktree] [--thinking <level>] [--json]`

Run the reproducible matrix: every non-stub suite, or one via
`--suite`. Stub suites report `skipped (stub)` with `success:false`
(never as passing work) and never count toward the verdict — exit 0
iff every executed suite succeeded, 1 if any failed, 2 on usage
errors (unknown suite, missing provenance, dirty `--workspace
worktree`, or a suite that needs the live runner the binary does not
ship). Flags match `kubic eval` minus `--task`/`--trajectory` (each
matrix row runs `benchmark:<suite-id>` as its task).

## `kubic replay <trajectory.json> [--tier recorded|deterministic|live] [--model <provider/id>] [--lockfile <path>] [--role-config <path>] [--worktree <path>] [--diff-against <other.json>] [--json]`

Replay a versioned trajectory at a declared determinism tier. The
tier is printed and present in `--json` for every result — tiers
never silently downgrade: a tier that needs pins refuses (exit 2)
without them.

| Invocation | Meaning |
| --- | --- |
| `kubic replay traj.json` | Recorded exact: log-only, never re-executes. Exit 0 with the tier printed. |
| `... --tier deterministic --model <provider/id> --lockfile <file>` | Re-executes the recorded objective through the solo lane at the pinned model. Refuses without both pins (exit 2); an unregistered pin exits 6 (`provider_probe_failed`). |
| `... --tier live --role-config <file>` | Re-executes at the recorded model under the pinned role config. Refuses without it (exit 2); `--model`/`--lockfile` are refused under live. |
| `... --diff-against other.json` | Recorded compare: names the changed vars (`model`, `worktree`, `diff`); any difference exits 1 as the regression signal, identity exits 0. |

`--worktree <path>` is an experimental override for the re-execution
tiers (warned on text, `experimental:["worktree"]` in `--json`).
Recorded with any of `--model`/`--lockfile`/`--role-config`/`--worktree`
exits 2. Exit codes are the §78 subset 0/1/2/5/6 (see
[exit codes](exit-codes.md)).

## `kubic export --trajectory <file> [--type sft|dpo|grpo|preference|tooluse|coding] [--against <other.json>] [--json]`

Trajectory inspection plus RL dataset export over trajectory export
files. Without `--type` the file is validated and described (schema,
task, model, provenance, result, usage). With `--type` a dataset
record is built and validated: `sft`, `tooluse`, and `coding` read
`--trajectory` alone; `dpo`, `preference` (chosen plus rejected), and
`grpo` (two-candidate group) additionally need `--against` — a stray
`--against` on a single-trajectory type exits 2, as does a missing
one on a pair/group type.

Excluded pairs (env-failure or cross-boundary runs carry no
capability signal) print their exclusion tag with exit 0 — never a
training record. Stripped provenance or failure labels refuse with
exit 2. Text mode prints the canonical record JSON; `--json` wraps it
in `{ok, exitCode, type, record}` (or `{…, excluded}`). Exit 0
exported/described, 1 build-or-validation failure, 2 usage/error.

## `kubic cost [--session <id>] [--json]`

Per-agent cost readout over real session stats: one aggregate row per
session (`agent <id> | model aggregate | <tokens> tokens ($<cost>)`),
plus `task total $<sum> (<n> agents)` — the total is exactly Σ(rows).
With `--session <id>` only that session is read (unknown session exits
1); with no sessions stored it prints `no cost rows`, exit 0.

| Flag | Meaning |
| --- | --- |
| `--session <id>` | Read only this session (same `[A-Za-z0-9_-]` rule as `run` — anything else exits 2 before any store is touched). |
| `--json` | The in-code `toCostJson` shape (`agents`, `taskTotal`) field-for-field. Exits 0. |

An unknown flag prints `usage: kubic cost [--session <id>] [--json]`
and exits 2.

## `kubic perf --budget <kind> --samples <csv> [--json]`

Perf-budget evaluation (faux-only: samples arrive as argv, no clock).
A breach prints the exact filed regression string
(`perf regression: <kind> p95=<p95>ms exceeds budget=<budget>ms …`)
and exits 1; a pass prints nothing gated and exits 0.

| Flag | Meaning |
| --- | --- |
| `--budget <worktree\|spawn\|attach\|teardown>` | **Required.** Which budget to evaluate. Anything else exits 2. |
| `--samples <ms,ms,…>` | **Required.** Comma-separated non-negative ms samples (at least one — empty exits 2, never a vacuous pass). |
| `--json` | The full evaluation (`kind`, `budgetMs`, `count`, `p50`, `p95`, `within`, `regression`) — exit 0 on pass, 1 on breach. |

A missing flag, an unknown kind, non-numeric samples, or an unknown
flag prints `usage: kubic perf --budget <worktree|spawn|attach|teardown> --samples <ms,ms,…> [--json]`
and exits 2.

## `kubic policy --tool <name> [--json]`

Policy query as a routing offer (never enforcement): `allow <tool>`
or `deny <tool>` under the enterprise default (deny-by-default — a
tool with no enterprise allow is denied). Tool names match case- and
whitespace-insensitively.

| Flag | Meaning |
| --- | --- |
| `--tool <name>` | **Required.** The tool to query. Missing or empty exits 2. |
| `--json` | `{"tool", "decision"}` instead of the text line. Exits 0. |

An unknown flag prints `usage: kubic policy --tool <name> [--json]`
and exits 2.

## `kubic audit [--mode <m>] [--posture <p>] [--result <r>] [--json]`

Audit-trail query: exact match on each supplied dimension, full
14-field records out (one JSON object per line; `no audit records` +
exit 0 when empty). Every printed record is redacted first —
secret-shaped values and listed-secret inventory values become
`[redacted-secret]` — so credentials stay sentinel-only. No audit
persistence is wired yet, so the one-shot CLI reads zero rows; the
filters and the redaction are live.

| Flag | Meaning |
| --- | --- |
| `--mode <solo\|orchestrator>` | Filter on mode. Anything else exits 2. |
| `--posture <name>` | Filter on posture. Needs a value. |
| `--result <ok\|deny\|error>` | Filter on result. Anything else exits 2. |
| `--json` | The matching records as a JSON array (same redaction). Exits 0. |

A filter without a value or an unknown flag prints
`usage: kubic audit [--mode <solo|orchestrator>] [--posture <name>] [--result <ok|deny|error>] [--json]`
and exits 2.

Back to the [docs index](../README.md). See also
[exit codes](exit-codes.md), [configuration](configuration.md), and
[doctor and debug](doctor-and-debug.md).
