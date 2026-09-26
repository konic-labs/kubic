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
| `--timeout <ms>` | Wall-clock bound for the drive loop (positive integer ms, max `2147483647`). Default `300000` (5 minutes). A model that never settles is cut off and the run ends `budget_exhausted` (exit 3) with the ref triple intact. When the bound fires mid-tool, the in-flight operation is **aborted and killed, not abandoned**: the run requests a durable operation abort, drains the kill registry (detached bash children die with their process groups), and only then runs the end-of-run reconciliation sweep — so a late write from orphaned work cannot land outside the journal. |
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

**Concurrent runs in one workspace** (issue #118). A run drives one
session, and a session takes one live attachment. `kubic run --session X`
while X is held ends `workspace_unavailable` (exit 5) with the holder's pid
named on the `error:` line; `kubic sessions attach X` prints the same
refusal and exits 1 without reading the transcript. The lock lives at
`<sessions-root>/<id>/lock.json`, is acquired on create/attach and released
on close, and only a provably-stale holder is stolen (its process gone, or
the file a day old) — so crash recovery works same-day. **Different**
sessions in one repo stay legal — nothing blocks them — but each run's
end-of-run sweep compares against its own boot baseline, so a run
overlapping another session records that session's in-flight changes as
**unattributed, non-reversible** journal entries. When the local session
store shows another session on the workspace, the run's debug channel
emits one `reconcile: another run may be live in this workspace …` line
naming the sibling ids, and `kubic doctor` reports the same overlap as the
`session:overlap` warn note ([doctor and debug](doctor-and-debug.md)).
Locking is local-filesystem only: no network/shared-disk (NFS/SMB) locking
semantics are provided or tested.

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

**The delegation model, as shipped (issues #95, #103, #104, #106).** The CLI process is the
manager: it registers the manager lane's toolset through the §40 allowlist
before anything spawns, derives a plan from `-p` (one step per worker), creates
one worktree per agent, spawns one child `kubic run` per agent and merges what
they commit. **Each worker runs its own plan step under an assigned role**: the
prompt a child receives cites that worker's step (`Plan step 2 of 2 for agent
'beta': …`), carries the objective, and opens with the `## Prompt` text of the
role that worker was assigned — `-p` is the objective the plan is derived from,
never copied to a worker verbatim. The role also decides the worker's lane: the
child is told `--role <name>` and registers exactly that role's resolved tool
set, so a tool the role does not hold is never registered (absence, not
approval, withholds it), and the role's model default travels through the
existing `KUBIC_MODEL` pin. A contradictory role document (or one with no
`## Prompt` section) refuses the run with the resolver's named reason under
`code=role_refused` before anything spawns — the same refusal `kubic doctor`
prints. The plan persists with the session, so `--resume` replays each
worker's own composed prompt rather than re-deriving one shared text.
Conflict delegation with parallel surfacing and retained-worktree status
(issue #106) runs today — see below; so do per-worker approvals and opt-in
budgets (issue #105, §41/§71).

**Per-worker approvals and opt-in budgets (issue #105, §41.1/§41.2/§71).** A
worker child is a real `kubic run` process, so its dangerous calls are
challenged by the installed policy — and on this path the challenge routes to
**you**, not to the manager. The orchestration constructs one approval router
per run (a durable decision store and an append-only audit log under
`<repo>/.kubic/orchestrator/approvals/`, decisions memoized, never re-asked)
and hands each child the ask mailbox through the child env
(`KUBIC_APPROVALS_DIR`). A challenged call — network, destructive shell,
outside-write, install, push — publishes its ask, the manager presents it to
you, and your verdict travels back to the worker:

- **A denial is data, not a crash.** The worker is told `approval_denied`, and
  the run ends exit **4** with the offending worker and trigger named.
- **The wait is bounded on both ends.** An ask that no surface can answer
  (headless, no TTY) denies closed with the reason `approval_timeout` — exit
  **4** — on the run's bound; the child denies on its own bound too, so a run
  never hangs on a question nobody can answer.
- **Budgets are opt-in per spawn (§71).** With no `--budget` the run applies no
  limit at all. With one configured, a worker that exceeds it is blocked with
  `BUDGET_EXHAUSTED` and the run exits **3**. A worker cannot raise its own
  budget: the raise is refused and audited.
- **`--full-access` is the session-scoped skip (§41.4).** It is stored per
  session, indicated on the surface, recorded for audit/doctor, and a fresh
  session starts enforced again.
- **The manager can only look.** Its whole view of a pending ask is a read-only
  blocked indicator; a manager approve attempt is refused and audited.

`--yes` is the user's standing answer for **merges** (it does not silently
approve a worker's dangerous call — the ask is still presented to the decider
that exists).

The lane registration is a gate, not a label: the run asks for exactly the §40
toolset and a lane carrying anything else — an exec tool above all — refuses to
start, exiting 1 with `code=manager_toolset_refused` and the offending tool
named, before any worktree, session or child exists.

The default agent set is **two** (`worker-1,worker-2`, D12) and the run
spawns them **one after another** — the CLI's loop creates the worktree,
session and child process for each agent in turn, so two workers do not
overlap in wall-clock time. §45's "default concurrency is 4" describes the
admission layer's cap (`ParallelScheduler`, default 4), which is **not** what
bounds a run today: this loop is strictly sequential, so it admits, awaits and
releases one worker at a time and never approaches the cap. The design
reconciliation is recorded in
[design drift](../design-drift.md).

The admission numbers the layer holds are **reported, not hidden** (issue #106):
every run prints one `parallel: running <n> queued <n> cap <n>` line and one
§49.1 `tree: <session> parallel <running>/<cap>` line, and both counters travel
in the `--json` envelope as `parallel: { running, queued, maxConcurrency }`.
The counters are the *high-water* the scheduler actually reached over the run,
and the cap is the scheduler's own resolution of it — so `queued` above zero
means a slot really was occupied when the spawn was requested, never a number
computed for display. A spawn the admission layer queues also emits one §49.1
trajectory record (`{ kind: "parallel", sessionId, running, queued,
maxConcurrency, wakeups }`, appended to
`<root>/.kubic/orchestrator/<session>.trajectory.jsonl`). Because the shipped
loop is sequential, `queued` stays 0 on a default run — the lines exist so the
cap is visible when it *is* reached, not to claim it gates anything.

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
| `-p`, `--prompt <text>` | **Required** (unless `--resume`). The objective the manager derives the plan from; each worker receives its own plan step built on this text, never the text verbatim. |
| `--agents <a,b>` | Worker ids (default `worker-1,worker-2` — the two-worker demo, spawned one after another). Ids accept only `[A-Za-z0-9_-]`, must be unique (one worktree per writer). |
| `--session <id>` | Session scope (default `orch-<now>`). Same `[A-Za-z0-9_-]` rule as `run`. State persists at `<repo>/.kubic/orchestrator/<id>.json` — including the plan, so `--resume` replays each worker's own prompt; each worker's session id is `<id>-<agent>`. |
| `--resume` | Re-attach after a kill: merges only pending workers in the original order, never re-merges, and each retried worker runs the plan step stored for it (a state written before #103 has no plan and re-derives one from the stored objective). Needs `--session`. No stored state exits 1 (`code=no_orchestrator_state`); a stopped queue re-reports the conflict and merges nothing (`code=merge_conflict`). |
| `--yes` | Auto-approve merges (non-interactive). Without it, a TTY is asked per merge; headless without a decider denies closed with exit 4. |
| `--budget <dims>` | **Opt-in** per-spawn budget for every worker (`maxTokens`, `maxCostUsd`, `maxRuntimeMs`, `maxToolCalls`; e.g. `--budget maxToolCalls=20`). Per-spawn overrides: `--budget worker-1:maxToolCalls=5;worker-2:maxCostUsd=0.5`. Absent means **no limit is applied**; a worker exceeding it ends `BUDGET_EXHAUSTED` (exit 3), and a worker cannot raise its own budget. |
| `--full-access` | Session-scoped full-access posture (§41.4): approvals are skipped for **this session only**, indicated and recorded. A fresh session starts enforced again. |
| `--json` | One JSON envelope (`ok`, `exitCode`, `sessionId`, `status`, `workers`, `mergeOrder`, `attribution`, `graph`, `parallel`, `retained`, optional `error` with a machine-readable `code`). `graph` is the delegation DAG as text lines (`node …`/`edge …`), naming the session and one node per worker — on a `--resume` run it describes the resumed session's agents. `parallel` is `{ running, queued, maxConcurrency }` (the same numbers the text lines print); `retained` is one row per retained worktree with its measured dirtiness. |

Text output prints `session:`, one `worker: <id> branch=<b> hunks=<n>` line
per worker, `merge order: a -> b`, `attribution: a=<n> hunk(s), …`, the
`dag:` lines (`node …`/`edge …`) for the delegation graph, one
`merged:`/`reaped:` line per worker, then the admission surface and the
retained evidence, then `result:`. Two lines carry the §49.1/§50 admission
numbers of the run — `parallel: running <n> queued <n> cap <n>` and
`tree: <session> parallel <running>/<cap>` (with ` (queued <n>)` appended when
anything was queued). One `retained: <agent> branch=<b> worktree=<path>
clean=<bool>` line follows per retained worktree, and a dirty one names the
files that made it dirty (`staged=[…] unstaged=[…] untracked=[…]`, each list
omitted when empty); a status that could not be read prints `clean=unknown`
with the reason, never a false `clean=true`. The block closes with
`retain: worktree + branch kept as evidence — only \`kubic clean\` disposes`.

Failures print `error: <message> code=<code>` and exit 1 (session creation,
spawn, worker, merge, reap and manager-toolset failures), 2 (usage, non-git
refusal), or 4 (approval denied) — see [exit codes](exit-codes.md).

**A genuine merge conflict is delegated, never resolved by the manager**
(issue #106, §45.2). The merge aborts first (never a half-merged tree); the
manager then builds the writer-resolver spec — both diffs, the conflicted file
list, the implementer tool set, the settlement constraints — from **its own
live approval snapshot** (the hash is recomputed and the snapshot frozen inside
the spec, so there is no second policy and no bypass) and spawns a resolver
child in that worker's worktree. Only a successful **re-merge** settles the
candidate: a resolver's report is never taken as the settlement. If the
resolver cannot settle it, if the re-merge conflicts again, or if the run had
no snapshot or no resolver seam, the queue stops exactly as before
(`code=merge_conflict`, exit 1) and the remaining candidates are preserved —
the failure line names the resolver outcome so a delegation attempt is never
indistinguishable from no attempt at all.

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
approval ask. A challenged call surfaces the approval overlay — the
interactive path can actually collect a verdict on it — and an unanswered
ask denies on the same bounded wait.

**Parity with `kubic run` (issue #113).** The interactive lane carries the
same context the headless one does:

- **Skills (§29.3):** discovery runs at boot with the same trust gate
  (`KUBIC_TRUST_PROJECT`), so discovered `<skills>` blocks land on the
  interactive system prompt. `--skill <path>` adds an explicit skill
  (repeatable), `--no-skills` turns layered discovery off — and explicit
  `--skill` paths still apply under `--no-skills`, exactly as `run`.
- **Roles (§12.1):** `--role <name>` loads `.kubic/roles/<name>.md` — the
  document's prompt text replaces the solo constant and its tool set
  narrows the lane (absence, not approval). Every refusal is fail-closed
  with the named reason (unknown role, contradictory document, missing
  `## Prompt`, parse failure); the boot exits before the alt-screen.
- **Journal retention (§42.4):** the session journal takes the same
  `[journal] retentionDays` projection `run` threads — a TUI session's
  journal age-prunes under config.
- **Runtime exclude rules (§35):** `kubic tui` ships the same `.kubic/`
  exclude rules before creating state, so a session whose config ever
  relocates state in-repo leaves `git status` clean.

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
| `Ctrl-O` | Toggle the **diff panel** — the current run's changes, rendered as unified hunks. |
| `Ctrl-R` | Toggle the **journal panel** — the session journal, with its path/agent filters. |
| `a` | Approval overlay: **allow once** the challenged call. |
| `s` | Approval overlay: **allow for the session**. |
| `d`, `Esc` | Approval overlay: **deny** the challenged call. |
| `Ctrl-C` | Cancel the in-flight turn; while idle, quit. A second `Ctrl-C` during a turn also quits. |
| `Esc` | Quit (while no approval is pending — during an approval it denies). |
| `Ctrl-D` | Quit on an empty draft; while typing it stays delete-forward. |
| EOF (closed stdin) | Quit — a detached tty or `kubic tui < /dev/null` never hangs the alt-screen. |

A challenged call opens the **approval overlay** instead of being refused: it
names the tool class and the exact command, so the decision is made on what
was actually asked, not on the tool's name. Below 80 columns the overlay
falls back to an inline slot in the transcript (`! approval (inline)`) rather
than rendering an unusable box — a narrow terminal can still answer. Denying
leaves the session running; the transcript shows the refusal instead of the
call's result. Quitting with an ask still pending denies it, so a shutdown
cannot strand the turn.

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
usage: kubic sessions <create [--cwd <path>] [--dangerously-skip-approvals] | list | attach <id> [--tail <n>] | prune [--keep-days <n>] [--keep-session <id>]... [--yes] [--dry-run]>
```

| Subcommand | Meaning |
| --- | --- |
| `create [--cwd <path>] [--dangerously-skip-approvals]` | Create a session, print its id. `--cwd` sets the session directory (default: current directory). `--dangerously-skip-approvals` records session-scoped full-access in the session dir and prints a warning — fresh sessions start safe, the flag must be passed explicitly every time. |
| `list` | One `<id>  <cwd>` line per session. |
| `attach <id> [--tail <n>]` | Print session metadata, the approvals posture (`approvals enforced` or `full-access …`), then the last `--tail` transcript entries (default 10) truncated to 300 chars each. `--tail` needs a non-negative integer. |
| `prune [--keep-days <n>] [--keep-session <id>]... [--yes] [--dry-run]` | Retention for session **state dirs** (`<sessions-root>/<id>/`): **lists by default, deletes only with `--yes`**. See [Session retention](#session-retention-prune) below. |

Missing subcommand exits 1 with the usage line; `attach` without an id
or with an id outside `[A-Za-z0-9_-]` exits 1; attaching a missing
session exits 1; attaching a session another process holds live prints
the lock refusal (issue #118 — the holder's pid and start time are named)
and exits 1 without reading the transcript.

### Session retention (`prune`)

Everything a run persists stays under `~/.kubic/sessions` until you say
otherwise: per-session state dirs (`<root>/<id>/` — the journal store,
`spans.jsonl`, approvals posture, and the session lock) grow for the
lifetime of the machine, so retention is explicit and opt-in. `prune` is
the only thing that deletes whole session state dirs, and it never deletes
what it cannot account for — the same window also self-heals aged session
journal entries at read time (see the read-time self-heal note under
[`kubic log`](#kubic-diff--undo--log--status)):

- **Dry-run is the default.** Without `--yes`, `prune` lists every
  candidate as `would prune <id> (<bytes>B)` plus the summary
  `dry run: N session(s) would be pruned (NB) — pass --yes to delete`, and
  removes nothing. `--dry-run` is the explicit synonym of that default;
  `--yes` deletes the listed set (`pruned <id> (<bytes>B)` per session,
  then `pruned N session(s), NB reclaimed`; a candidate whose lock goes
  live in between is skipped and never counted — see the lock bullet
  below). `--yes` with `--dry-run` contradicts and is refused by name.
  `nothing to prune` exits 0.
- **The keep window is never invented.** `--keep-days <n>` (a
  non-negative integer of days) wins; without it, `session.retentionDays`
  from config supplies the window; with neither, `prune` exits 1 naming
  both ways to set one. `--keep-days 0` — or `retentionDays = 0` — means
  retention is off: nothing is ever pruned.
- **Age is the session dir's own mtime** (create, attach, and close all
  bump it): a session is a candidate when that mtime is at or before
  `now − keepDays`. A session attached recently survives even if the files
  inside it are old.
- **A live lock is a hard stop.** A session holding a `lock.json` whose
  holder pid is alive is never a candidate, even when old and even with
  `--yes`: it is reported `locked: <id> (held by pid <pid> since <iso>) —
  skipped`. The lock is re-checked immediately before each delete, so a
  session locked between planning and the delete pass is skipped and
  reported the same way — never counted as pruned. A **stale** lock (dead
  holder, or a torn file) never protects. Lock liveness is
  **process-local**: it reads this machine's process table, so a session
  held by a run on another machine or in another container is not seen as
  held (the same local-filesystem-only caveat the lock itself carries —
  see [worker](../packages/worker.md#session-locking-issue-118)). The
  probe is `process.kill(pid, 0)`: any result other than success —
  including `EPERM` for a pid this user cannot signal — reads as dead;
  same-user holders always signal, so a per-user sessions root never
  mis-reads one.
- **`--keep-session <id>`** (repeatable, ids `[A-Za-z0-9_-]`) protects a
  session by name even when aged; the name is reported
  `kept: <id> (--keep-session)` when it is what spared an aged session — a
  recent session is never a candidate anyway, and a live-locked one is
  reported `locked:` instead.
- **Only session-shaped entries are touched.** Plain files, a stray
  `lock.json`, names outside `[A-Za-z0-9_-]`, and pi's `--<cwd>--`
  transcript directories (which hold the `.jsonl` transcripts of every
  session recorded against that cwd) are never touched. A session that
  cannot be inspected is skipped and reported
  (`unreadable: <id> — skipped`), never guessed at. A missing sessions
  root is a fresh machine: `nothing to prune`, exit 0. A root that exists
  but cannot be listed refuses by name, exit 1.
- **Scope.** `prune` deletes `<sessions-root>/<id>/` state dirs only —
  never the workspace journal (`.kubic/journal`), never orchestrator
  worktrees (`kubic clean` owns those), never anything outside the
  sessions root. pi's transcript files live beside the state dirs
  (`<root>/--<cwd>--/<ts>_<id>.jsonl`) and are not part of this command
  today.

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
one store, resolved in this order (issues #18, #125):

1. `--session <id>` names the store explicitly: the headless-run session
   journal at `<sessions-root>/<id>/journal` (`~/.kubic/sessions` by
   default). `kubic run` prints the session's ref as `journal:<id>`; pass
   it verbatim (`--session journal:<id>` or `--session <id>`) to
   diff/undo that run's file effects from any cwd with no path lookup.
2. Without `--session`, the workspace store `<root>/.kubic/journal` (the
   interactive solo journal for the current directory) when it is
   non-empty.
3. Otherwise the **latest session journal** under the sessions root — the
   most recently written run journal. The chosen store is named on the
   first output line (`session: <id>`) so the fallback is never silent;
   `--json` output keeps its parseable envelope and gains no extra line.

When no journal exists anywhere, `diff` prints `no changes` plus a hint
naming both places that were looked at —
`hint: no journal under <dir> and none under the sessions root (<root>) —
start a run or pass --session` — and exits 0. `undo --dry-run` plans
against the same store `diff` reads. Session ids accept only
`[A-Za-z0-9_-]` — anything else (including `../` or absolute paths) exits
1 before any path is touched. File restores and the `status` repo line
always resolve against the caller's cwd, not the session's original cwd —
`--session` selects the journal store, never the working directory.
`--session` combined with a programmatically configured journal dir is
refused (one store per invocation).

**Read-time self-heal (issue #119).** With `session.retentionDays` set in
config, `kubic log` drops entries older than that window from a **session**
journal as it reads it — via `--session <id>` or the latest-session
fallback — the same age bound `kubic sessions prune` applies to whole
session dirs, one entry at a time. The workspace journal is not affected
(its own `[journal] retentionDays` bounds it on append). With retention
unset — or `0` — the log path writes nothing: reads never mutate the store.

```
usage: kubic <diff [--path <p>] [--agent <id>] [--json] [--session <id>] | undo [<path>] [--step] [--dry-run] [--force] [--session <id>] | log [--session <id>] | status [--session <id>]>
```

| Subcommand | Meaning |
| --- | --- |
| `diff [--path <p>] [--agent <id>] [--json] [--session <id>]` | Rendered diff of journaled changes (`no changes` + exit 0 when empty). `--path`/`--agent` filter; `--json` prints the raw change array. A `--path`/`--agent`/`--session` without a value exits 1. |
| `undo [<path>] [--step] [--dry-run] [--force] [--session <id>]` | Restore journaled changes. Positional `<path>` limits scope; `--step` restores one step; `--dry-run` prints `would restore N step(s)…` and exits 0 without touching anything. Real runs print `restored <p>` per path plus a summary. `nothing to undo` exits 0. **Exit 2 when any step was skipped** — three skip classes, each with its own line: `non-reversible (skipped): <p>` (unattributed entry, no pre-image), `stale (skipped): <p> — <reason>` (the file changed after the entry was journaled — restoring would destroy unjournaled changes), `already undone (skipped): <p>` (a previous undo already unwound it — nothing is rewritten). The summary is `undo: N restored, M non-reversible` when all skips are the non-reversible class, else `undo: N restored, M skipped (K stale, J already undone)` naming the counts present. The `--session` value selects the store, never the path scope. |

**Undo staleness safety (issue #108).** Before any restore, the file's
current content is verified against the entry's recorded after-hash — undo
must never overwrite a file whose state the journal does not account for.
Verdicts are walk-aware: a whole-run undo judges each step against the state
the previous steps left (and `--dry-run` simulates exactly what a real run
would write), so layered edits unwind in order. The matrix:

| current file | entry after-state | verdict |
| --- | --- | --- |
| exists, hash == recorded after | content present | restore |
| exists, hash != recorded after | content present | **stale: skip** (a change landed after the entry — restoring would discard it) |
| missing | content present | restore (recreates the file; nothing on disk is destroyed) |
| exists | delete entry (after is null) | **stale: skip** (recreated after the recorded delete) |
| missing | delete entry (after is null) | restore (brings pre-delete content back) |
| exists at a journaled *before*-state | any | **already undone: skip** (a prior undo reached this state — re-writing would be a no-op mislabeled as restored) |
| exists but unreadable | any | **stale: skip** (cannot verify — refuse) |

`--force` overrides the stale refusals per-invocation (nothing persists it;
the next `undo` re-checks by default). `--force` does not override
non-reversible skips — no pre-image exists to write. Already-undone skips are
informational: there is nothing to force. |
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
  not copies — so they are recorded **hashes only** and the badge is
  `[unattributed, non-reversible]`: `kubic undo` skips them naming the path
  (`non-reversible (skipped): <p>`), exiting **2** without writing. The sweep
  never invents a pre-image. If an earlier attributed entry in the same run
  already stored that path's pre-image, the entry *is* reversible and `undo`
  restores it — the badge then reads `[unattributed]` alone.
- Cost is bounded: unchanged files cost one hash and no blob, and a file larger
  than 4 MiB is hashed in chunks, so its boot and sweep cost is one chunk of
  memory rather than the file size (a 256MB artifact measured below 1MB of heap
  growth, where it previously cost 256MB). A sweep that finds nothing appends
  nothing; a file that *did* change is read whole to store its after-content,
  because that content is what `diff` and `undo` serve — that read costs twice
  the file size in heap while it runs (measured: 128MB for a 64MiB file).
- Chunking bounds *memory*, not *time*: the walk still reads a file's full
  apparent size, so a sparse or genuinely huge file costs its size in I/O at
  boot. A file above 256 MiB is named on the debug channel
  (`reconcile: hashing a very large file: <path> (<bytes>)`) so the cost is
  visible instead of silent; nothing is skipped, because a skipped file's
  changes would be invisible to the journal.
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

The re-execution tiers consume the effective config like `kubic run`
(§35.1): the configured permission classes and journal retention govern
the re-executed lane, and a refused config exits 1 with the config's
named reason instead of proceeding on defaults. The refusal gate is
command-level: a refused config also blocks the log-only inspection
tiers (`recorded`, `compare`) — the command exits 1 before any tier
runs, so a broken config is fixed first rather than inspected around.

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
