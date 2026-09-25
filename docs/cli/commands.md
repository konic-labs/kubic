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

**`--help` is uniform across the commands.** Every command below answers
`kubic <command> --help` (or `-h`) with exactly its own usage line and **exit 0**
— the convention lives once in `packages/core/src/cli-help.ts` and is applied
before any argv validation. Usage *errors* keep their own exit codes (a bad flag
is still an error; a help request is not); each command's usage line lists
exactly the flags its parser accepts.

One documented exception, above this list: the **bare dispatcher** `kubic --help`
is not a command's help path — it prints the top-level usage line and exits 1,
because the dispatcher treats `--help` as an unknown command. `kubic --version`
exits 0. Folding the dispatcher into the same convention means editing
`apps/kubic/src/main.ts`, which is held by the TUI and prompt-loop work
(issues #88, #93); until then this page describes the dispatcher as it behaves.

Build first (`npm run build`), then invoke `./bin/kubic.js` (or
`npm run kubic -- …`); anything else dispatches below; an unknown command prints
`usage: kubic <sessions | git | models | diff | undo | log | status | run | orchestrate | clean | tui | doctor | config | workers | eval | benchmark | replay | export | cost | perf | policy | audit>`
and exits 1. Solo mode runs in-process with your user authority: no
isolation, no containment — approvals plus the journal are the controls.
Orchestrator mode (`orchestrate`) is opt-in — `run` never delegates.

## `kubic run -p <prompt> [--session <id>] [--timeout <ms>] [--max-turns <n>] [--debug] [--json]`

Non-interactive solo run: no alt-screen, no prompt, consumable output.

| Flag | Meaning |
| --- | --- |
| `-p`, `--prompt <text>` | **Required.** The prompt to run headless. |
| `--session <id>` | Resume into an existing session. Ids accept only `[A-Za-z0-9_-]` — anything else exits 2 before any store is touched. |
| `--timeout <ms>` | Wall-clock bound for the drive loop (positive integer ms, max `2147483647`). Default `300000` (5 minutes). A model that never settles is cut off and the run ends `budget_exhausted` (exit 3) with the ref triple intact. |
| `--max-turns <n>` | Optional turn bound (positive integer). Exceeding it ends the run `budget_exhausted` (exit 3). Unset means the turn bound is the drive loop's own retry budget. |
| `--debug` | Emit §49.3 lane/tool span lines on **stderr** (`[span]`, `[tool]`, `[lane]` … — one line per span close, the same `DEBUG_CLASSES` vocabulary as the interactive TUI debug channel). Off by default; stdout stays consumable. |
| `--json` | Emit one JSON envelope (`ok`, `exitCode`, `sessionId`, `status`, `result`, `journal`/`usage`/`trajectory` refs, optional `error`) instead of human lines. |

Text output prints `result:`, `session:`, `journal:` (`journal:<id>`),
`usage:` (`usage:<id>`), `trajectory:` (`trajectory:<id>`); on failure an
`error:` line comes first. Exit code is the §78 terminus map — see
[exit codes](exit-codes.md). Missing `-p`, a `-p`/`--session` without a
value, an invalid `--session` id, a non-positive or non-integer
`--timeout`/`--max-turns`, or an unknown flag all exit 2.

**Installed policy** (issue #86). A run always boots the lane with a
permission policy, whether or not a config names one: the five permission
classes (`[permissions]` when configured, the documented solo defaults
otherwise — `filesystem = workspace-write`, `shell = true`,
`network = none`, `git = workspace`, `credentials = none`), the derived
tool allowlist (a tool outside it is refused at execute time, not merely
omitted), and the `destructive-guard` / `network-guard` / `confine-guard`
interceptors wired to an approval ask. `kubic doctor` prints this same
installed object as `policy:installed`.

A destructive or network-raising call needs an approval. `kubic run` has
no TTY, and the TUI approval overlay has not landed, so a challenged call
is **refused rather than executed**, and the run ends `approval_timed_out`
(exit 4) with the refusal named on the `error:` line. To run such an
operation deliberately, record session-scoped full access first
(`kubic sessions create --dangerously-skip-approvals`, or a prior
`kubic sessions attach` decision) — it is never implied.

### Where the spans go

Lane and tool spans have two destinations, both documented:

1. **stderr, behind `--debug`** — each span close writes one
   `<label>: <name> …` line through the shared `DebugSink`. This is the
   channel the interactive TUI debug view uses, so the vocabulary is
   identical across modes. Silence (no `--debug`) is the default, which
   keeps stdout consumable and the run's exit contract untouched.
2. **the session artifact** — `run-spans.ts` also serializes the same
   spans to `spans.jsonl` under the session's own directory
   (`<sessions-root>/<session-id>/spans.jsonl`), one JSON object per
   closed span. The artifact is evidence, not a surface: nothing reads it
   back and no CLI command reports it yet (the aggregate is #95/#96's
   telemetry work).

Both are additive: a run with no spans still exits exactly as before.

A fresh solo start announces its trust model before the first turn: three
`warning: solo mode has no isolation …` lines on **stderr** (never stdout —
`--json` stays one parseable envelope). Suppressed when the process is an
orchestrator-managed worker child (`KUBIC_WORKER_ID` set; that mode's own
worktree limit is what `kubic doctor` reports) and by the opt-out
`KUBIC_NO_NOTICE=1`. A `--session` resume still announces it: the rule is
per process start, not per session. `kubic tui` shows the same statement
as its one-line form in the editor footer, and the re-execution tiers of
`kubic replay` announce it too (they drive this same run path).

## `kubic orchestrate -p <prompt> [--agents <a,b>] [--session <id>] [--resume] [--yes] [--json]`

Opt-in orchestrator mode: plans N workers, spawns one worker process per
subagent in its own git worktree (`kubic/<agent>` at
`<root>/.kubic/wt/<agent>`), settles/merges FIFO through the merge queue
with per-agent attribution, routes merge approvals to the user, and reaps.
The manager authors nothing — workers commit on their own branches, the
manager only merges. Worktrees and branches stay retained after the merge
as evidence (only `kubic clean` disposes) — that claim is asserted by
`packages/host/src/orchestrator/worktree/clean-docs.test.ts`, which fails
if this sentence or the `clean` command goes missing. Requires a git repo:
outside one the command refuses with exit 2 and never silently runs solo.
Worker runs need a configured provider (each worker is a child `kubic run -p`).

The manager creates each worker's session before spawning its child. A
child `kubic run --session <id>` only *attaches* — it never creates — so
the manager creates `<orchestrator-session>-<agent>` (e.g.
`orch-1790…-worker-1`) with that agent's worktree as its cwd (worker
sessions under the sessions root, worker journals inside the worktree).
Without the session the child would die at attach (exit 5,
`unknown session`); if creation fails, or a worktree vanished while its
branch survived, the run fails closed as `spawn_failed` before spawning
anything. `--resume` re-attaches an existing worker session instead of
recreating it, so a killed run keeps one chain per worker.

| Flag | Meaning |
| --- | --- |
| `-p`, `--prompt <text>` | **Required** (unless `--resume`). The prompt every worker runs. |
| `--agents <a,b>` | Worker ids (default `worker-1,worker-2` — the two-worker demo). Ids accept only `[A-Za-z0-9_-]`, must be unique (one worktree per writer). |
| `--session <id>` | Session scope (default `orch-<now>`). Same `[A-Za-z0-9_-]` rule as `run`. State persists at `<repo>/.kubic/orchestrator/<id>.json`; each worker's session id is `<id>-<agent>`. |
| `--resume` | Re-attach after a kill: merges only pending workers in the original order, never re-merges. Needs `--session`. No stored state exits 1 (`code=no_orchestrator_state`); a stopped queue re-reports the conflict and merges nothing (`code=merge_conflict`). |
| `--yes` | Auto-approve merges (non-interactive). Without it, a TTY is asked per merge; headless without a decider denies closed with exit 4. |
| `--json` | One JSON envelope (`ok`, `exitCode`, `sessionId`, `status`, `workers`, `mergeOrder`, `attribution`, optional `error` with a machine-readable `code`). |

Text output prints `session:`, one `worker: <id> branch=<b> hunks=<n>` line
per worker, `merge order: a -> b`, `attribution: a=<n> hunk(s), …`, one
`merged:`/`reaped:` line per worker, then `result:`. Failures print
`error: <message> code=<code>` and exit 1 (session creation, spawn, worker,
merge, and reap failures), 2 (usage, non-git refusal), or 4 (approval
denied) — see [exit codes](exit-codes.md). A merge conflict aborts first
(never a half-merged tree), stops the queue, and preserves the remaining
candidates.

## `kubic clean [--all] [--session <id>] [--dry-run] [--force] [--journal] [--max-age-ms <n>] [--max-bytes <n>] [--json]`

The explicit-only disposer for retained orchestrator state. `orchestrate`
keeps every spawned worktree (`<root>/.kubic/wt/<agent>`) and branch
(`kubic/<agent>`) as evidence (§44.1); `clean` is the only command that
removes them. It also carries the §42.4 journal retention prune.

Refusal posture: the planned set is exactly Kubic's own spawned set — a
worktree under `<root>/.kubic/wt/` **on a `kubic/<agent>` branch**, plus
any other `kubic/<agent>` branch left behind. The main checkout, hand-made
worktrees (`git worktree add handmade-wt -b handmade`), and namespace-shaped
checkouts sitting on a foreign branch are never planned or touched, and
never appear in `--dry-run`.

| Flag | Meaning |
| --- | --- |
| (none) | Remove every retained worktree+branch for this repo. One `removed worktree <path>` line per worktree, one `deleted branch <branch>` line per branch; `clean: nothing to prune` (exit 0) when there is nothing left. |
| `--all` | Explicit scope-all (the default scope). Mutually exclusive with `--session` — both exit 2. |
| `--session <id>` | Scope to one `orchestrate` run: the agents named in `<repo>/.kubic/orchestrator/<id>.json`, so a **failed** run's retained worktrees are disposable too. An unknown session exits 1 (`no retained set for session '<id>'`, naming the file it looked for) and removes nothing. |
| `--dry-run` | Print `would remove worktree <path>` / `would delete branch <branch>` and exit 0 — mutates nothing (`git worktree list` is byte-identical before and after). |
| `--force` | Pass `git worktree remove --force`, disposing a worktree with uncommitted worker changes. Without it a dirty worktree fails loudly: exit 1, an `error:` line per failure, and the branch is kept (never half-disposed). |
| `--journal` | Also enforce the journal retention policy at `<root>/.kubic/journal`. Alone it prunes to the store's default byte bound; with `--max-age-ms`/`--max-bytes` it prunes to those bounds. Prints `journal: pruned <n> entr(ies), freed <b> byte(s)`. |
| `--max-age-ms <n>` / `--max-bytes <n>` | Positive integers; the journal retention bounds. Either one turns the journal prune on without `--journal`. |
| `--json` | One JSON envelope (`ok`, `exitCode`, `dryRun`, `worktrees`, `branches`, `journal`, optional `failures`) — same exit code as the text view. |

Exit codes: 0 success (including a dry run and a second idempotent run),
1 a hard failure (dirty worktree without `--force`, a failing branch delete,
an unknown `--session`), 2 usage errors (unknown flag, invalid or missing
flag value, `--all` with `--session`) **and** the non-repo refusal — outside
a git repo it prints `error: … needs a git repository … nothing was removed`
and exits 2 without touching anything (§78). See
[exit codes](exit-codes.md).

## `kubic tui [--session <id>]`

Interactive solo TUI: the alt-screen over the solo lane. Tree,
transcript, and status rows render in root order, with the prompt editor
on the bottom row. Below 80 columns the tree hides and transcript plus
status stay. `--session <id>` resumes into an existing session (same
`[A-Za-z0-9_-]` rule as `run` — anything else exits 2 before the lane
boots). Lane boot failure exits 5 on a missing session, 6 with no
provider available, 1 otherwise.

The TUI drives the same solo lane as `kubic run`, so it installs the same
policy (see **Installed policy** under `kubic run` above): the classes,
the derived allowlist, and the destructive/network/confine guards with the
approval ask. The approval overlay is its own interaction surface and has
not landed yet, so a challenged call is refused the same way it is
headless.

The loop is real: type a prompt, press `Enter` to submit, and the solo
lane drives it with events streaming into the views — tool calls appear in
the tree, the transcript grows with the committed conversation, and the
status bar fills with usage rows. While a turn runs the editor disables
submit; `Ctrl-C` cancels the in-flight operation and keeps the session
alive, and a second `Ctrl-C` (or `Ctrl-C` while idle) quits.

| Key | Meaning |
| --- | --- |
| `Enter` | **Submit** the prompt (an empty draft submits nothing). |
| `Ctrl-J`, `Shift+Enter`, `\` then `Enter` | Insert a newline (multi-line entry). |
| `Ctrl-T` | Toggle the tree (collapsed summary ↔ per-call rows). |
| `Ctrl-C` | Cancel the in-flight turn; while idle, quit. A second `Ctrl-C` during a turn also quits. |
| `Esc` | Quit. |
| `Ctrl-D` | Quit on an empty draft; while typing it stays delete-forward. |
| EOF (closed stdin) | Quit — a detached tty or `kubic tui < /dev/null` never hangs the alt-screen. |

These keys are classified by the terminal library's key decoder, not by
matching raw bytes, so they work on terminals that negotiate the Kitty
keyboard protocol (`Esc` arrives as `\x1b[27u` rather than `\x1b`, `Ctrl-D`
as `\x1b[100;5u`, `Ctrl-C` as `\x1b[27;5;99~`) as well as on terminals that
send the legacy control bytes. A refused cancel is reported in the editor
footer (`cancel failed: …`) instead of being swallowed — the turn keeps
running and the key is never a silent no-op.

Quitting restores the main screen and prints the final document (no cursor
loss on interrupt). Only `SIGINT` (`Ctrl-C`) and stdin EOF are handled —
`SIGTERM`/`SIGHUP` have no handler and exit without restoring the
alt-screen. Solo mode runs in-process with your user authority: no
isolation, no containment. The no-isolation statement is on screen from the
first frame: the editor footer carries the one-line form at startup and
returns after every completed turn (a cancelled or failed turn reports that
outcome instead). It is suppressed for orchestrator-managed worker children
(`KUBIC_WORKER_ID` set) and by the opt-out `KUBIC_NO_NOTICE=1`; see
[`kubic run`](#kubic-run--p-prompt---session-id---timeout-ms---max-turns-n---json).

Text rendered in the transcript is stripped of terminal control sequences
before it reaches the frame: assistant text and tool output are untrusted
input, so ANSI escapes (`\x1b[2J`, colour codes, cursor moves) and C0
controls such as BEL are removed rather than executed by the operator's
terminal. The renderer's own styling is unaffected.

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
File restores and the `status` repo line always resolve against the
caller's cwd, not the session's original cwd — `--session` selects the
journal store, never the working directory. `--session` combined with a
programmatically configured journal dir is refused (one store per
invocation).

```
usage: kubic <diff [--path <p>] [--agent <id>] [--json] [--session <id>] | undo [<path>] [--step] [--dry-run] [--session <id>] | log [--session <id>] | status [--session <id>]>
```

| Subcommand | Meaning |
| --- | --- |
| `diff [--path <p>] [--agent <id>] [--json] [--session <id>]` | Rendered diff of journaled changes (`no changes` + exit 0 when empty). `--path`/`--agent` filter; `--json` prints the raw change array. A `--path`/`--agent`/`--session` without a value exits 1. |
| `undo [<path>] [--step] [--dry-run] [--session <id>]` | Restore journaled changes. Positional `<path>` limits scope; `--step` restores one step; `--dry-run` prints `would restore N step(s)…` and exits 0 without touching anything. Real runs print `restored <p>` per path plus `undo: N restored, M non-reversible`. `nothing to undo` exits 0. **Exit 2 when any step was skipped as non-reversible** (`non-reversible (skipped): <p>`). The `--session` value selects the store, never the path scope. |
| `log [--json] [--session <id>]` | One line per journal entry (`journal is empty` + exit 0 when empty); `--json` prints the raw entries array. The human output closes with the reconciliation line `unattributed: N of M entr(ies) reconciled at run end` (printed for an empty journal too). |
| `status [--session <id>]` | `entries: N (reversible: R, non-reversible: M)`, then `unattributed: U of N (reconciled at run end)`, plus repo line: `repo: non-repo directory (journal works without git)` or `repo: branch <b>, dirty: yes|no|unknown`. |

### End-of-run reconciliation (issue #87)

Interception alone has holes (§42.1 mechanism 2): a file moved by `bash`
(`sed -i`, a formatter, `npm install` fallout, a build) never passes through
Kubic's own `write`/`edit` operations, so nothing journals it. The run and TUI
composition paths therefore capture a **baseline** when the lane boots and
**sweep** the workspace when it ends:

- The baseline is a metadata walk — sha256 per file, **no content copied** — of
  the lane's workspace root (`§42.5`), persisted as
  `<sessions-root>/<id>/journal/baseline-<id>.json` beside that run's journal.
- The sweep compares the tree against it and appends one entry per changed,
  created or deleted path with `unattributed: true` and `toolCallId: null`.
- Excluded from **both** walks: `.git/`, `.kubic/` (journal state is never
  journaled) and anything the root `.gitignore` matches; caller-declared
  out-of-scope paths are honoured when supplied.
- Before-content is unknowable for these finds — the baseline holds hashes,
  not copies — so they are recorded **hashes only**: `kubic diff` badges them
  `[unattributed, non-reversible]` and `kubic undo` skips them naming the path
  (`non-reversible (skipped): <p>`), exiting **2** without writing. The sweep
  never invents a pre-image.
- Cost is bounded: unchanged files cost one hash and no blob; a sweep that
  finds nothing appends nothing.
- Fail-open: a baseline or sweep failure is reported on the debug receipt and
  never turns a finished run into a failed one.

`kubic log` answers "did anything bypass the tools?" with the count line above;
`kubic status` names it in the summary. `--json` keeps the raw entry array (the
`unattributed` flag is on each entry there).

## `kubic models`

Catalog readout over built-ins plus `models.json` customs in the
current directory (absent or invalid `models.json` is reported as a
`loaded models.json: …` / `models.json ignored: …` note, never fatal).

| Flag | Meaning |
| --- | --- |
| (none) | `provider <id> (<name>)` plus one `  <model> — thinking: <levels> — $in/$out per 1M in/out` line per model; `no providers registered (add models.json or set provider env keys)` when empty. Exits 0. |
| `--json` | The same catalog as JSON. Exits 0. |
| `--resolve <provider/id>` | Print `selected <provider>/<id> (thinking: …)` or `error: …`. Needs a value; resolution failure exits 1. |

An unknown flag prints `usage: kubic models [--json] [--resolve <provider/id>]`
and exits 1 (it used to be silently ignored). `--help`/`-h` prints the same line
and exits 0.

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

## `kubic perf --budget <kind> (--measure | --samples <csv>) [--json]`

Perf-budget evaluation over the §61 constants. Exactly one sample
source per run; two sources exist:

- **`--measure`** — `kubic perf` runs the real thing and times it:
  `spawn` cycles a real `node -e` child through the worker spawn
  environment, `worktree` runs a real `git worktree add` / `remove` cycle
  in a scratch dir. Issue #98; the measurement module is
  `packages/host/src/ops/perf/measure.ts`. The default measurement source
  is the live one (no composition-root wiring needed). `attach` and
  `teardown` have no live substrate in the solo path yet, so `--measure`
  on those kinds exits 2 with a message naming `--samples`.
- **`--samples <ms,ms,…>` — the explicit, documented fallback.**
  Operator-supplied ms samples; no clock is consulted. This is the
  faux-only path used by the test suite and by any environment where
  spawning a child (or `git`) is not available or not wanted. It is a
  fallback, not the default.

A breach prints the exact filed regression string
(`perf regression: <kind> p95=<p95>ms exceeds budget=<budget>ms …`)
and exits 1; a pass prints nothing gated and exits 0. `--measure` and
`--samples` are mutually exclusive — both together exit 2 rather than
silently picking one.

| Flag | Meaning |
| --- | --- |
| `--budget <worktree\|spawn\|attach\|teardown>` | **Required.** Which budget to evaluate. Anything else exits 2. |
| `--measure` | Measure for real. Only `spawn` and `worktree` have a live source; the other kinds exit 2 and name `--samples`. |
| `--samples <ms,ms,…>` | Fallback: comma-separated non-negative ms samples (at least one — empty exits 2, never a vacuous pass). |
| `--json` | The full evaluation (`kind`, `budgetMs`, `count`, `p50`, `p95`, `within`, `regression`, plus the measured `source`/`samplesMs`) — exit 0 on pass, 1 on breach. |

A missing flag, an unknown kind, non-numeric samples, or an unknown
flag prints `usage: kubic perf --budget <worktree|spawn|attach|teardown> (--measure | --samples <ms,ms,…>) [--json]`
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
