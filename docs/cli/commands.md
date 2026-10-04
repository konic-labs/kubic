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
`kubic <command> --help` (or `-h`) with **exit 0**. Every command is
parsed by commander (`apps/kubic/src/commands/*.ts`) and prints its
generated help — `Usage: kubic <command> [options]`, every option with its
description, and examples where useful (the analysis commands share
[these rules](#analysis-commands-shared-rules)). Usage *errors* keep their
own exit codes (a bad flag is still an error; a help request is not): an
unknown option, a missing value, a value the command's rules refuse, or a
stray operand prints one `error: …` line on **stderr** and exits **2**
(no `Did you mean …?` follow-up line). A value option never takes a
following `--flag` or the `--` terminator as its value: `kubic diff
--session --json` or `kubic orchestrate -p --yes` is a missing value
(`option '…' argument missing`, exit 2, nothing runs). A value that really
starts with `--` goes in the attached form (`--session=…`, `-p--…`).

The **root dispatcher** follows the same convention (issue #128):
`kubic --help` / `kubic -h` prints the top-level command listing — the
full `usage` line below — and exits 0. A **bare `kubic`** (no command) on
an interactive terminal (stdin and stdout both a TTY) opens the TUI, exactly
as `kubic tui`. Off a TTY (a pipe, CI, a script) it prints the *identical*
listing and exits 1: usage-on-no-args is the deliberate POSIX posture, so
only the exit code differs between the two paths.
`kubic --orchestrator` (issue #327) is the same bare form with the
orchestrator opt-in: on a TTY it is exactly `kubic tui --orchestrator`.
Off a TTY, like every other bare flag, it prints the usage line and
exits 1.
`scripts/binary-contract.mjs` pins both exits and the line itself, so the
dispatcher and its help cannot drift apart. `kubic --version` exits 0.

Build first (`npm run build`), then invoke `./bin/kubic.js` (or
`npm run kubic -- …`); anything else dispatches below; an unknown command (or
the bare invocation) prints
`usage: kubic <sessions | git | models | diff | undo | log | status | run | orchestrate | clean | tui | doctor | config | trust | workers | eval | benchmark | replay | export | cost | perf | policy | audit>`
and exits 1. Solo mode runs in-process with your user authority: no
isolation, no containment — approvals plus the journal are the controls.
Orchestrator mode (`orchestrate`) is opt-in — `run` never delegates.

## `kubic run -p <prompt> [--session <id>] [--timeout <ms>] [--max-turns <n>] [--role <name>] [--model <provider/id>] [--skill <path>]... [--no-skills] [--debug] [--json] [--dangerously-skip-approvals]`

Non-interactive solo run: no alt-screen, no prompt, consumable output.

| Flag | Meaning |
| --- | --- |
| `-p`, `--prompt <text>` | **Required.** The prompt to run headless. |
| `--session <id>` | Resume into an existing session. Ids accept only `[A-Za-z0-9_-]` — anything else exits 2 before any store is touched. **Model rule** (issue #148): a resumed session runs its own stored lane model unless a model is *pinned* (`--model`, `KUBIC_MODEL` / `[model]`, a role's `[roles.<name>].model`, or `KUBIC_PROVIDER=faux`) — a pin that differs switches the session to it (`model: session model '<a>' switched to '<b>' (explicit selection)` on stderr, compaction reserve re-clamped to the new window); the unpinned default pick never switches it (`model: session keeps its own model '<a>' …`). The prompt metadata, the `--json` `model` field and the usage rows all name the model the lane actually runs. A stored model that is no longer registered fails closed with `provider_probe_failed` (exit 6): `session model '<a>' is unavailable: …` — pin a model to move the session. |
| `--timeout <ms>` | Wall-clock bound for the run's turn — settling the pending work plus the prompt's own run (positive integer ms, max `2147483647`). Default `300000` (5 minutes). A model that never settles is cut off and the run ends `budget_exhausted` (exit 3) with the ref triple intact. When the bound fires mid-tool, the in-flight work is **aborted and killed, not abandoned**: the turn's context is cancelled, the run states a durable `conversation.abort()`, drains the kill registry (detached bash children die with their process groups), and only then runs the end-of-run reconciliation sweep — so a late write from orphaned work cannot land outside the journal. A provider that ignores cancellation cannot hang the run: the abort and the harness close are bounded, and the mapped result is reported either way. |
| `--max-turns <n>` | Optional turn bound (positive integer). A turn is one committed model response, counted from the lane's own usage events; durable provider retries the harness performs inside a turn are not turns. Exceeding the bound ends the run `budget_exhausted` (exit 3) with the same abort-and-drain path as `--timeout`. Unset means no turn bound — the wall clock is the only limit. |
| `--role <name>` | Boot as the role document `.kubic/roles/<name>.md` (prompt text, tool set, model pin). |
| `--model <provider/id>` | Session model override (§38.1): the `cli` config layer, above `KUBIC_MODEL` and every file layer — and never above a frozen enterprise key, which still wins (one stderr note names the ignored flag or `KUBIC_MODEL` pin: `note: --model x ignored: model pinned by enterprise policy (corp/approved)`; stdout and a `--json` envelope are untouched). An unknown provider/model exits 6 with the id and the input that carried the pin named (`--model`, `KUBIC_MODEL`, `[model] in <layer> config`, `role model`); the flag is an input to the one config load, so `kubic config --model` reports the same selection. |
| `--skill <path>` | Add one skill explicitly (repeatable; applies even under `--no-skills`). |
| `--no-skills` | Turn layered skill discovery off. |
| `--debug` | Emit §49.3 lane/tool span lines on **stderr** (`[span]`, `[tool]`, `[lane]` … — one line per span close, the same `DEBUG_CLASSES` vocabulary as the interactive TUI debug channel), plus the run's diagnostics on the same channel (as `[session] …` lines when they carry no class of their own): the extension-load receipt, `reconcile:` notices (including the overlap warning below), `skills:` reports and drain failures. Off by default; stdout stays consumable. |
| `--dangerously-skip-approvals` | Full access for **this run's session only** (§41.4): challenged calls run without an ask. It is recorded in the session's `posture.json` and as one `posture:full-access` row in the audit ledger (session id and command), never in config, and a `warning: full-access approvals skipped for session <id> …` line goes to stderr. A later `kubic run --session <id>` on that session warns again on stderr. |
| `--json` | Emit one JSON envelope (`ok`, `exitCode`, `sessionId`, `status`, `result`, `journal`/`usage`/`trajectory` refs — `usage` also carries the run's `input`, `output`, `cacheRead`, `cacheWrite`, `costUsd` and `toolCalls` once a session exists —, `model` — the `provider/id` the lane actually ran, present once a lane booted —, `approvals.posture` — `approvals` or `full-access` — once the lane is installed, and optional `error`) instead of human lines. The envelope is deliberately **one compact line** (not pretty-printed): `kubic orchestrate` reads a worker's envelope as the last stdout line. |

**Skill paths the `read` tool may open (§29.3, issue #173).** Every skill
advertised in the `<skills>` block names its absolute `<filePath>`. Paths
outside the workspace are normally re-rooted under it, so one narrow,
read-only exception applies to exactly the advertised skills that live
outside the cwd: user skills (`~/.pi/agent/skills`, `~/.agents/skills`),
trusted ancestor project skills, and explicit `--skill` paths. For a
`SKILL.md`, `read` may open anything inside that skill's own directory
(so the skill's relative references resolve); a flat skill file opens
only itself. Nothing else changes: `write`, `edit`, `ls`, `find` and
`grep` still re-root every outside path, any other outside `read` is
still re-rooted, and skills hidden from the model
(`disable-model-invocation`) open nothing. `kubic tui` and orchestrator
workers (child `kubic run` processes) apply the same rule.

**Interrupts.** `SIGINT` (Ctrl-C), `SIGTERM` (e.g. an orchestrator
stopping a worker) and `SIGHUP` during a run are handled like the
wall-clock guard (a signal during boot, before the prompt is admitted,
cancels the boot — the lane never drives): the in-flight tool process groups are killed at once, the
operation is aborted durably, the reconciliation sweep runs, the session is
closed, and the run prints its normal result with `status: failed`,
`run interrupted by <SIGNAL>` (exit 1). A second signal while that cleanup
runs takes the default path and ends the process immediately.

Text output prints `result:`, `session:`, `journal:` (`journal:<id>`),
`usage:` (`usage:<id>`), `trajectory:` (the absolute path of the run's
trajectory file) on stdout (the labels are dimmed and the result coloured
on a colour terminal; plain text under a pipe or `NO_COLOR`); on failure an
`error:` line goes to stderr first. Exit code is the §78 terminus map — see
[exit codes](exit-codes.md).

**Trajectories (§46).** Every run that attached a session writes
`<sessions-root>/<id>/trajectory.json` when it settles, completed or not,
and the `trajectory` ref (text line and `--json` envelope) is that file's
absolute path. The file holds the session's latest settled run; a resumed
`--session` run replaces it. It records:

- the prompt, its tool calls (actions) and their results (observations)
- per-request token and cost usage
- the thinking level the responses ran at (`model.thinking`, from the
  stored assistant responses when the caller named none)
- the journal diff of this run
- this session's approvals from the audit ledger
- provenance: session, agent, pid, worker generation (0 for a solo run),
  worktree, and `provider/id` model
- the git base revision (`no-vcs` outside a git checkout) and branch
- the used tool environment (`toolSpawnEnv`, so no secrets)
- a result with a §52 `failureCategory` on every non-completed status

The file is readable by `kubic replay <file>` (or `--session <id>`),
`kubic export --trajectory <file>` (or `--session <id>`) and
`kubic eval --trajectory "$(cat <file>)"`. A run that fails before any
session exists (an invalid `--session` id, a missing session) writes none,
and its ref stays `trajectory:<id>`. A trajectory that cannot be written is
reported on stderr and never changes the run's exit code.
`kubic tui` writes the same file after each settled turn, and each
`kubic orchestrate` worker writes its own under its worker session.

**Usage errors (exit 2, stderr, no lane).** commander parses the argv
(`apps/kubic/src/commands/solo.ts`): a missing `-p`, a flag without its
value, an unknown option, an invalid `--session` id, a non-positive or
non-integer `--timeout`/`--max-turns` (or a `--timeout` above
`2147483647`), and a stray operand all exit 2 with one `error: …` line.

**Prompt values.** `-p <text>`, `--prompt <text>`, `--prompt=<text>` and
`-p<text>` all work. The typo guard stays: a separate-token value that
starts with `--` is a mistyped flag, not a prompt — `kubic run -p --json`
exits 2 with `argument missing ("--json" looks like a flag …)` and the
exact attached form to use.
A prompt that really begins with `--` is written in the attached form:

```console
$ kubic run --prompt='--help'            # the value is everything after '='
$ kubic run --prompt='--json-experiment'
```

A single-dash value (`-p '- fix the tests'`, a markdown bullet) is a
normal prompt. The old `-p -- <prompt>` escape is gone: after `--` every
token is an operand, and `run` takes none. A positional prompt without
`-p` (`kubic run "fix tests"`) is refused with the exact form to use:
`error: unexpected argument "fix tests" — the prompt is a flag: kubic run -p 'fix tests'`
(single-quoted, so nothing in the suggestion expands when pasted). An
empty prompt (`--prompt=`, `-p ''`) is refused (`the prompt is empty`).
`--help` anywhere after `run` is commander's help (exit 0); a literal
`--help` prompt needs the attached form.

**Installed policy** (issue #86). A run always boots the lane with a
permission policy, whether or not a config names one: the five permission
classes (`[permissions]` when configured, the documented solo defaults
otherwise — `filesystem = workspace-write`, `shell = true`,
`network = none`, `git = workspace`, `credentials = none`), the derived
tool allowlist (a tool outside it is refused at execute time, not merely
omitted), and the `destructive-guard` / `network-guard` / `confine-guard`
interceptors wired to an approval ask. `kubic doctor` prints this same
installed object as `policy:installed` — as a `WARN (unsupported-level)`
naming each level the tool set cannot express (issue #166): network
`allowlist` is enforced as `none` (the network guard blocks and the
network trigger fires), credentials `allowlist` as `none`, filesystem
`full` as `workspace-write`, git `full` as `workspace`.

A destructive or network-raising call needs an approval. `kubic run` has
no TTY, and the TUI approval overlay has not landed, so a challenged call
is **refused rather than executed**, and the run ends `approval_denied`
(exit 4) with the refusal named on the `error:` line. Both labels map to
exit 4 — the `status` string is the honest half: `approval_denied` for a
recorded refusal (no installed approval surface, a policy route, a
decider's no), `approval_timed_out` for a denial whose recorded reason
carries the timeout marker (`timed out`) or a headless suspension on an
approval that cannot arrive without a TTY. To run such an operation
deliberately, pass `--dangerously-skip-approvals` (session-scoped full
access for the session this run creates or resumes), or record it first
with `kubic sessions create --dangerously-skip-approvals` — it is never
implied.

**Attaching a session with a pending operation** (issue #147). A run
that died mid-turn (SIGKILL, OOM, power loss, orphan reaping) leaves its
operation open in the session, and an open operation refuses every new
prompt. `kubic run --session X` therefore settles it first and names the
choice on stderr: when the pending run carries **this same prompt** (an
orchestrator worker re-launched on its reattached session, a retried
script) it is resumed *as* this run — never re-prompted
(`pending work: <kind> <id> (<status>) carries this prompt: resuming it
instead of re-prompting`); otherwise it is resumed to settlement under this
run's `--timeout`/`--max-turns` guards and the new prompt is accepted
afterwards (`… resumed after an interrupted run: <status>`). A resume that
cannot settle — a guard fires, or it waits on an approval that cannot
arrive without a TTY — is durably aborted instead (`… aborted after an
interrupted run (resume could not settle: <why>)`).
A never-replay tool (bash, write, edit, VCS mutations) the dead process
was running is never executed again: the resumed turn sees it as
interrupted. `kubic sessions attach X` prints the same `pending work:
<kind> <id> (<status>)` summary (one line naming every live task and
unsettled submission) — the storage-level probe in
`packages/worker/src/lane/pending.ts` owns the format, so both surfaces
name the same work.

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

### Testing provider: `KUBIC_PROVIDER=faux`

**For testing only.** `KUBIC_PROVIDER=faux` swaps every model call for
Pi's faux provider with a scripted reply, so the shipped binary can be
driven end to end — `run`, `tui`, and `orchestrate` (the switch crosses the
§3.8 worker spawn allowlist) — with no network, no credentials and no paid
tokens. Everything else is real: the lane, the tools, the installed
policy, the session store and the journal.

- **Never implicit.** Only the exact value `faux` turns it on. Unset or
  empty means no override; any other value is refused by name — `run`
  ends `provider_probe_failed` (exit 6) with
  `unsupported KUBIC_PROVIDER "<value>" (the only override is 'faux', the testing provider)`.
- **Always announced.** `run` prints
  `warn: provider: faux/echo (testing provider: scripted replies, no model is called; KUBIC_PROVIDER=faux)`
  on stderr before the first turn (stdout and `--json` stay clean); the
  TUI footer reads `faux/echo: testing provider, no model is called`;
  `kubic models` and `kubic doctor` list the `faux` provider and print the
  same warning.
- **Pinned.** The model is `faux/echo`; a configured `[model]` pin or
  `KUBIC_MODEL` does not apply while the switch is on.
- **Script.** Each model call answers by the transcript: after a tool
  result, `faux: <tool> returned <n> chars` (ending the turn); a prompt
  with a line `faux:tool <name> <json-args>` makes one real call to that
  tool (for example `faux:tool ls {"path":"."}`); anything else is echoed
  as `faux echo: <prompt>`.

```console
$ KUBIC_PROVIDER=faux kubic run -p hello --json
{"ok":true,"exitCode":0,"sessionId":"…","status":"completed","result":{"summary":"faux echo: hello"},…}
$ KUBIC_PROVIDER=faux kubic run -p 'faux:tool ls {"path":"."}'
```

`npm run test:binary-contract` runs `scripts/faux-smoke.mjs` against the
built binary: a faux `run --json` (echo and a tool call), text mode, the
unknown-value refusal, and an `orchestrate --yes` across worker processes.

## `kubic orchestrate -p <prompt> [--agents <a,b>] [--session <id>] [--resume] [--yes] [--budget <dims>] [--dangerously-skip-approvals] [--json]`

`kubic orchestrate --help` prints the generated help (every flag below plus
examples) and exits 0. Unknown flags, a missing flag value, a stray operand,
and a malformed `--agents` / `--session` / `--budget` value are refused
before anything runs: one `error: …` line on stderr naming the flag, exit 2.
A run with neither `-p` nor `--resume`, or `--resume` without `--session`,
exits 2 with `error: missing -p, --prompt <text> …` /
`error: --resume needs --session <id> …`.

Opt-in orchestrator mode: plans N workers, spawns one worker process per
subagent in its own git worktree (`kubic/<session>/<agent>` at
`<root>/.kubic/wt/<session>/<agent>`, where `<session>` is the run's
`--session` id or the generated `orch-<ms>`), settles/merges FIFO through the merge queue
with per-agent attribution, routes merge approvals to the user, and reaps.
The manager authors nothing — workers commit on their own branches, the
manager only merges. Worktrees and branches stay retained after the merge
as evidence (only `kubic clean` disposes) — that claim is asserted by
`packages/host/src/orchestrator/worktree/clean-docs.test.ts`, which fails
if this sentence or the `clean` command goes missing. Requires a git repo:
outside one the command refuses with exit 2 and never silently runs solo.
Worker runs need a configured provider (each worker is a child `kubic run -p`).
Worktree names carry the session, so a later run with the same agents
(e.g. the default `worker-1`/`worker-2`) always starts on fresh worktrees at
the current HEAD — never on an earlier run's retained, possibly dirty or
unmerged tree — and two runs in one repo never share a worktree. Only
`--resume --session <id>` reuses that session's own worktrees; a fresh run
whose session-scoped worktree or branch already exists fails closed with
`code=worktree_exists`, exit 1, naming the `--resume` and
`kubic clean --session <id>` ways out. A fresh run under a `--session <id>`
that already has stored state (`<repo>/.kubic/orchestrator/<id>.json`) is
refused earlier still, with `code=session_exists`, exit 2, before anything is
saved or spawned: the stored run is never overwritten (issue #144), so a
later `--resume --session <id>` continues the run you started. The message
names the ways out — `--resume`, another `--session` id, or `kubic clean
--session <id>` (which retires the state — and the session's
`approvals/<id>/` directory — once nothing of the session is left to dispose,
even when no worker ever got a worktree). A state file that does not parse is
not state and is replaced.
Workers never outlive the manager on a signal: each child runs in its own
process group, so while any worker is live the manager traps
SIGINT/SIGTERM/SIGHUP (and process exit), kills every live worker's group,
then re-delivers the signal. A manager killed with SIGKILL cannot do this.
A manager killed hard (SIGKILL, crash) leaves rows claiming live workers; the
next `kubic orchestrate` start reconciles them: an orphan still running under
its own `--session` is killed (`cancelled`), a dead one is marked `crashed`,
and a reused pid that is not a Kubic worker is never touched. A legacy row
that names no manager is never killed (only marked `crashed` once dead).
`workers.json` updates are atomic and lock-serialized; an unparsable file is
refused, never overwritten. A signal owned by another listener (the TUI) still
stops the run: the in-flight worker fails with `code=cancelled`.
A worker exit code of 0 is not success on its own: the child's final `--json`
report must be `ok`, `completed`, name the worker's own session and carry a
summary, and the §68 AgentResult built from it must validate — otherwise the
run fails with `code=result_invalid`.

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

**Worker provider credentials (issue #200, §36.3, §59).** Each worker's
provider key is delivered as that worker's role grant, never as ambient env:
the manager resolves the provider the role will use, forwards exactly that
provider's key variables as `KUBIC_ROLE_<ROLE>_<ENV_VAR>` through the §3.8
allowlist, and the child reads them back as the provider's `apiKeyEnv` auth
(a `models.json` key is still resolved per request and audited in the child's
run, §36.1 rules 3-4; a built-in key keeps Pi's own env auth).
No sibling role's provider key, no second provider's key, and no unrelated
parent secret (`AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, …) reaches the child
env, and the grant is redacted from `--debug` spawn lines and every export.
When a role's provider key is missing from the orchestrator's environment,
the run exits 6 (`code=credential_unavailable`) naming the provider **before
any worktree is created**; the conflict resolver is held to the same rule,
and `kubic doctor`'s `dep:credentials:roles` line lists the provider each
role gets credentials for (names only). A credential refusal is
provider-bound, not a usage error: fix the key or the model pin.
A built-in that needs more than its API key is handled the same way, by name:
`cloudflare-workers-ai` and `cloudflare-ai-gateway` forward their
`CLOUDFLARE_ACCOUNT_ID` (and `CLOUDFLARE_GATEWAY_ID`) next to the key, and
the run refuses naming the one that is unset. `amazon-bedrock` (`AWS_*`
credentials, profile, region) and `azure-openai-responses`
(`AZURE_OPENAI_BASE_URL` or `AZURE_OPENAI_RESOURCE_NAME`) read process-level
configuration that the §3.8 worker env allowlist does not carry, so a worker
cannot use them; `google-vertex` is refused the same way when it
authenticates from application default credentials (project, location and a
credentials file), but a `GOOGLE_CLOUD_API_KEY` needs none of that and is
forwarded like any single-key provider. Pinning a refused provider exits 6
(`code=credential_unavailable`) naming it before any worktree is created —
pin a provider authenticated by a single API key variable instead.

**Per-worker approvals and opt-in budgets (issue #105, §41.1/§41.2/§71).** A
worker child is a real `kubic run` process, so its dangerous calls are
challenged by the installed policy — and on this path the challenge routes to
**you**, not to the manager. The orchestration constructs one approval router
per run (a durable decision store and the ask mailbox under
`<repo>/.kubic/orchestrator/approvals/<session>/`, decisions memoized, never
re-asked; the append-only audit log stays one file for the repo at
`<repo>/.kubic/orchestrator/approvals/audit.jsonl`, in the main checkout even
when the run starts from a linked worktree). A **fresh** run (no `--resume`)
starts with that session's `approvals/<session>/` directory emptied, so a
reused session id never inherits an earlier run's `--dangerously-skip-approvals`
record or memoized decisions; only `--resume` continues them. The run hands
each child the ask mailbox through the child env (`KUBIC_APPROVALS_DIR`). The mailbox is per
session, so two runs — in one checkout or in different linked worktrees —
never answer each other's asks even though both use `worker-1`. A challenged call — network, destructive shell,
outside-write, install, push — publishes its ask, the manager presents it to
you, and your verdict travels back to the worker:

- **A denial is data, not a crash.** The worker is told `approval_denied`, and
  the run ends exit **4** with the offending worker and trigger named.
- **The wait is bounded on both ends.** An ask that no surface can answer
  (headless, no TTY) denies closed with the reason `approval_timeout` — exit
  **4** — on the run's bound; the child denies on its own bound too, so a run
  never hangs on a question nobody can answer.
- **Budgets are opt-in per spawn and enforced (§71).** With no `--budget` the
  run applies no limit at all. With one configured, each worker's own lane
  enforces `maxToolCalls` on **every** tool call it makes — brokered or not,
  including attempts a policy guard blocks or the approval router denies —
  and `maxTokens` / `maxCostUsd` from its own usage roll-up; the run ends
  `BUDGET_EXHAUSTED` (**exit 3**) naming the `limit=` that tripped, and that
  worker cannot make another tool call. `maxRuntimeMs` is the manager's
  wall-clock watchdog: a worker that outlives it is killed and the run reports
  `limit=wallClock` — distinct from the child's own `--timeout`. A worker
  cannot raise its own budget: the raise is refused and audited. The spec
  persists with the session, so `--resume` re-applies it; a differing
  `--budget` on resume is refused (exit 2) rather than silently mixed.
- **`--dangerously-skip-approvals` is the session-scoped skip (§41.4).** It
  is stored per session, indicated on the surface, recorded for audit/doctor
  (one `posture:full-access` ledger row), warned on stderr, and a fresh
  session starts enforced again. `--full-access` is a deprecated alias that
  still works and prints a `hint:` naming the new flag.
- **The manager can only look.** Its whole view of a pending ask is a read-only
  blocked indicator; a manager approve attempt is refused and audited.

`--yes` is the user's standing answer for **merges only** (issue #323, §41.2).
It never answers a worker's dangerous call: a worker ask still goes to the
interactive seat on a TTY, and a headless run denies it closed on the bound (exit 4).
Unapproved worker execution needs the explicit `--full-access` posture. Every
settled merge decision is appended to the §60 audit ledger
(`.kubic/orchestrator/approvals/audit.jsonl`, read by `kubic audit`) as a
`merge:<branch>` row whose approval is `approved by --yes` for the standing
answer, `approved by user` for an answered prompt, or `denied`.

The interactive merge gate is **bounded like every other ask** (issue #130,
§41.2). A TTY run asks each merge under the run's approval policy
(`approvals.maxPendingMs` — the same snapshot a delegated conflict resolver
runs under, never a second policy), and an answer that does not arrive within
that bound **denies closed**: the seat closes, the prompt line is left clean,
and the denial names the bound and the candidate (`approval timed out after
<ms>ms — denied (merge of '<agent>')`, exit 4) — the same wording convention
the worker-ask bound uses. A walked-away user is reported as what happened:
the run's `status`, `error.kind` and `error.code` all read `approval_timeout`
— a timeout, never `approval_denied`, the label an explicit no keeps. A run
that holds no policy snapshot attaches no seat at all and takes the shipped
deny-closed path, so nothing waits silently for a user who walked away.

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
recreating it, so a killed run keeps one chain per worker; a turn the
killed worker left open is resumed by the re-launched child (its plan-step
prompt is the pending one), never appended as a duplicate prompt, and the
`--debug` reuse line names it.

| Flag | Meaning |
| --- | --- |
| `-p`, `--prompt <text>` | **Required** (unless `--resume`). The objective the manager derives the plan from; each worker receives its own plan step built on this text, never the text verbatim. |
| `--agents <a,b>` | Worker ids (default `worker-1,worker-2` — the two-worker demo, spawned one after another). Ids accept only `[A-Za-z0-9_-]`, must be unique (one worktree per writer). |
| `--session <id>` | Session scope (default `orch-<now>`). Same `[A-Za-z0-9_-]` rule as `run`. A fresh run whose id already has stored state exits 2 (`code=session_exists`) instead of overwriting it — `--resume` or another id. State persists at `<repo>/.kubic/orchestrator/<id>.json` — including the plan, so `--resume` replays each worker's own prompt; each worker's session id is `<id>-<agent>`. |
| `--resume` | Re-attach after a kill: merges only pending workers in the original order, never re-merges, and each retried worker runs the plan step stored for it (a state written before #103 has no plan and re-derives one from the stored objective). The budget the run started with is re-applied from the state; a `--budget` naming a different spec is refused (exit 2). Needs `--session`. No stored state exits 1 (`code=no_orchestrator_state`); a stopped queue re-reports the conflict and merges nothing (`code=merge_conflict`). |
| `--yes` | Auto-approve merges (non-interactive). Worker asks are never auto-approved by it. Without it, a TTY is asked per merge under `approvals.maxPendingMs` (an elapse denies closed, exit 4, naming the bound and the candidate); headless without a decider denies closed with exit 4. |
| `--budget <dims>` | **Opt-in** per-spawn budget for every worker (`maxTokens`, `maxCostUsd`, `maxRuntimeMs`, `maxToolCalls` — positive numbers; `maxRuntimeMs` at most `2147483647`; e.g. `--budget maxToolCalls=20`). Per-spawn overrides: `--budget worker-1:maxToolCalls=5;worker-2:maxCostUsd=0.5`; a clause naming an agent that is not in the run (`--agents`, or the stored session on `--resume`) exits 2. Absent means **no limit is applied**. Each worker's own lane counts every tool attempt — including ones a policy guard blocks — plus its usage roll-up; the manager watches `maxRuntimeMs` and kills a worker that outlives it. Either end is `BUDGET_EXHAUSTED` (exit 3) naming the `limit=` that tripped, and a worker cannot raise its own budget. The spec persists with the session. |
| `--dangerously-skip-approvals` | Session-scoped full-access posture (§41.4): approvals are skipped for **this session only**, indicated, recorded in the audit ledger, and warned on stderr. A fresh session starts enforced again. |
| `--full-access` | Deprecated alias of `--dangerously-skip-approvals`; prints `hint: --full-access is deprecated — use --dangerously-skip-approvals` on stderr. |
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

**Per-worker results (§68, issue #185).** Every worker — including one that
failed, timed out, was cancelled, ran out of budget or never spawned —
yields one validated §68 result, built from the child's own `--json` report.
Text mode prints one line per settled worker, `<agent> (<role>): <summary>`.
Under `--json` each `workers[]` entry carries, next to `agentId`/`branch`/
`hunks`: `role`, `status` (`completed`, `failed`, `timeout`, `cancelled`,
`budget_exhausted`, `spawn_failed`), `summary`, `usage` (`inputTokens`,
`outputTokens`, `cachedTokens`, `toolCalls`, `wallMs`, `costUsd` — the
worker session's own usage rollup, the numbers `kubic cost` reads),
`provenance` (`workerId`, `sessionId`, `pid` — `null` only when no process
ever existed —, `generation`, `worktree`, `model` as `provider/id` or
`unresolved`, `role`, optional `thinking`) and, for a failure, `error`
(`kind` from the §68 vocabulary, `message`, `details.code`). A completed
worker's result also names its change set as a reference
(`diff.diffId` = `<base>...<branch>`), never the diff text; no result ever
carries a transcript or messages (§69). The result is persisted with the run
in `<repo>/.kubic/orchestrator/<session>.json` (`records[].result`) — a
failure's result too: a worker that failed leaves its failure record there
(still `pending`, so `--resume` retries it and the retry replaces the record),
and a worker that never launched (worktree, admission or session-creation
failure) gets a `spawn_failed` result with `pid: null`, `generation: 0`,
`model: unresolved` and the failure's `error.details.code`. The
`kubic run --json` report that feeds it carries `usage.{input, output,
cacheRead, cacheWrite, costUsd, toolCalls}` beside `usage.ref`, and the
`model` that answered. Not yet populated: `approvals` (routed asks) and
parsed `tests` counts.

Failures print `error: <message> code=<code>` **on stderr** and exit 1
(session creation, spawn, worker, merge, reap and manager-toolset failures),
2 (usage, non-git refusal), or 4 (approval denied) — see
[exit codes](exit-codes.md). stdout carries only the report (or, under
`--json`, exactly one two-space-indented envelope — the `error:` line still
goes to stderr, so `kubic orchestrate --json … | jq` always parses). On a
colour terminal the report labels (`session:`, `merged:`, `result:`, …) are
coloured; `NO_COLOR`, a pipe, and `--json` turn colour off.

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

`kubic clean --help` prints the generated help with examples and exits 0.

The explicit-only disposer for retained orchestrator state. `orchestrate`
keeps every spawned worktree (`<root>/.kubic/wt/<session>/<agent>`) and branch
(`kubic/<session>/<agent>`) as evidence (§44.1); `clean` is the only command that
removes them. It also carries the §42.4 journal retention prune.
A worktree whose worker process is still live (per `workers.json`) is never
removed: it is reported (`worker '<agent>' is still live (pid N)`), its branch
is kept, and the command exits 1 — `--force` stops the worker's process group,
then disposes it. A disposal that empties a session directory
(`<root>/.kubic/wt/<session>/`) removes that empty directory too — with a plain
non-recursive `rmdir`, so a worker directory a concurrent `orchestrate
--resume` adds meanwhile is never wiped; a directory that still holds anything
else, and the worktree root itself, stay.

Refusal posture: the planned set is exactly Kubic's own spawned set — a
worktree under `<root>/.kubic/wt/` **on a `kubic/<session>/<agent>` branch**
(or the unscoped `kubic/<agent>` shape runs before session scoping created),
plus any other such branch left behind. The main checkout, hand-made
worktrees (`git worktree add handmade-wt -b handmade`), and namespace-shaped
checkouts sitting on a foreign branch are never planned or touched, and
never appear in `--dry-run`.

| Flag | Meaning |
| --- | --- |
| (none) | Remove every retained worktree+branch for this repo. One `removed worktree <path>` line per worktree, one `deleted branch <branch>` line per branch; `clean: nothing to prune` (exit 0) when there is nothing left. |
| `--all` | Explicit scope-all (the default scope). Mutually exclusive with `--session` — both exit 2. |
| `--session <id>` | Scope to one `orchestrate` run: `kubic/<id>/<agent>` at `<root>/.kubic/wt/<id>/<agent>` for each agent named in `<repo>/.kubic/orchestrator/<id>.json`, so a **failed** run's retained worktrees are disposable too, and another session's same-named agent (its worktree, branch and live worker) is never planned or touched. An unknown session exits 1 (`no retained set for session '<id>'`, naming the file it looked for) and removes nothing. Only what the run actually left behind is planned (a worker that never spawned has no worktree or branch, so it neither appears in `--dry-run` nor fails the disposal). A **full** disposal — no failure (a dirty or live worktree without `--force` is one) and either at least one item removed or nothing of the session left standing (its workers never got a worktree, or a plain `kubic clean` already removed them) — also retires the run's state file `<repo>/.kubic/orchestrator/<id>.json` and that session's `<repo>/.kubic/orchestrator/approvals/<id>/` directory (full-access record, memoized decisions, ask mailbox; the repo-wide `approvals/audit.jsonl` ledger is never deleted) (`retired session state <path>`; `retiredState` under `--json`), so the id can start a fresh run; `--dry-run` prints `would retire session state <path> and its approvals directory <dir>` and changes nothing, and a partial disposal and another session's state are never touched. |
| `--dry-run` | Print `would remove worktree <path>` / `would delete branch <branch>` and exit 0 — mutates nothing (`git worktree list` is byte-identical before and after). |
| `--force` | Pass `git worktree remove --force`, disposing a worktree with uncommitted worker changes. Without it a dirty worktree fails loudly: exit 1, an `error:` line per failure, and the branch is kept (never half-disposed). |
| `--journal` | Also enforce the journal retention policy at `<root>/.kubic/journal`. Alone it prunes to the store's default byte bound; with `--max-age-ms`/`--max-bytes` it prunes to those bounds. Prints `journal: pruned <n> entr(ies), freed <b> byte(s)`. |
| `--max-age-ms <n>` / `--max-bytes <n>` | Positive integers; the journal retention bounds. Either one turns the journal prune on without `--journal`. |
| `--json` | One JSON envelope (`ok`, `exitCode`, `dryRun`, `worktrees`, `branches`, `journal`, optional `failures`) — same exit code as the text view. |

The report (`removed worktree …`, `would delete branch …`, `journal: …`)
is stdout; every `error:` line — a failed removal, an unknown session, the
non-repo refusal — is stderr, so `--json` stdout is always exactly one
two-space-indented document.

Exit codes: 0 success (including a dry run and a second idempotent run),
1 a hard failure (dirty worktree without `--force`, a failing branch delete,
an unknown `--session`), 2 usage errors (unknown flag, stray operand, a
missing value, a non-positive `--max-age-ms`/`--max-bytes`, an invalid
`--session` id, `--all` with `--session` — each refused by the parser before
anything is planned, one `error: …` line naming the flag) **and** the
non-repo refusal — outside a git repo it prints `error: … needs a git
repository … nothing was removed` and exits 2 without touching anything
(§78). See [exit codes](exit-codes.md).

## `kubic tui [--session <id>] [--role <name>] [--model <provider/id>] [--skill <path>]... [--no-skills] [--orchestrator] [--dangerously-skip-approvals]`

Interactive solo TUI: the alt-screen over the solo lane. Tree,
transcript, and status rows render in root order, with the prompt editor
on the bottom row. Below 80 columns the tree hides and transcript plus
status stay. `--session <id>` resumes into an existing session (same
`[A-Za-z0-9_-]` rule as `run` — anything else exits 2 before the lane
boots). Usage errors (unknown option, missing value, any operand) exit 2
on stderr before the screen opens. Lane boot failure exits 5 on a missing
session, 6 with no provider available, 1 otherwise, each with one
`error: …` line on stderr (never stdout) before the screen opens. The
`--session` model rule is the same as `kubic run`'s (issue #148; issue
#227 adds the same pins): `--model <provider/id>`, `KUBIC_MODEL`,
`[model]`, a role's `[roles.<name>].model`, or `KUBIC_PROVIDER=faux` —
the status bar and usage rows name the model the lane actually runs, and a
kept or switched model is named in the first footer. In the loop,
`/model <provider/id>` switches the live lane: the id is resolved against
the catalogue, committed to the session as a config update, and the
header, welcome block and status bar all move to it; `/model` alone
reports the current model, and an unknown or malformed id is refused in
the footer while the lane keeps the model it had. Under an enterprise
`[policy]` (§58) the switch passes the same model/provider gate the boot
does: a model outside `allowed_models`/`allowed_providers` is refused in the
footer with the boot's named refusal and the lane keeps its model. A frozen
enterprise `[model]` binds the switch too (§35.1, §38.1: `/model` is the same
session override as `--model`): a switch to any other model is refused with
`model '<ref>' refused: the model is pinned by enterprise policy (<pin>);
/model cannot change it`, and naming the pin itself passes. `--model`
is the `cli` layer of the one config load (never patched over the projected
pin), so a frozen enterprise `[model]` beats it — announced by one stderr
note at boot — exactly as it does for `kubic run`. A session left with a pending operation
by a crashed run (issue #147) has it durably aborted at boot — its
approvals would need the overlay, which is not on screen yet, and the
operator is present to re-send — and the editor footer names the outcome
(`pending work: <kind> <id> (<status>) aborted after an
interrupted run`) from the first render.

The TUI drives the same solo lane as `kubic run`, so it installs the same
policy (see **Installed policy** under `kubic run` above): the classes,
the derived allowlist, and the destructive/network/confine guards with the
approval ask. Each decision lands in the §60 ledger with the session id
and the model the lane runs **when the ask resolves** (`provider/id`) —
after the stored-model rule of a `--session` resume and after any `/model`
switch, never the pre-boot pick — the same audit identity the headless
runner records. A challenged call surfaces the approval overlay — the
interactive path can actually collect a verdict on it — and an unanswered
ask denies on the same bounded wait.

**Orchestrator mode (`--orchestrator`, issue #327).** `kubic tui
--orchestrator` — and the bare `kubic --orchestrator` on a terminal — opens
this TUI with the session mode set to `orchestrator` from the first frame:
the header and the status-bar indicator both read `orchestrator`, and each
submitted prompt is driven through the manager lane `kubic orchestrate`
runs (one manager, one worker process and one git worktree per subagent)
instead of the solo lane. Solo stays the default architecture — the flag
(or the config key below) is the opt-in: opening a TUI starts no worker by
itself, and a delegation only runs once you submit a prompt.

The mode is session state, not a launch-time constant: **`Ctrl-G`** switches
between `solo` and `orchestrator` between turns, the indicator follows, and
the *next* submitted prompt takes the newly selected lane. The key is
refused — with the reason on the footer — while a turn is running, because
the in-flight turn owns its lane.

Orchestrator mode needs git worktrees: outside a git repository the entry
refuses **before the alt-screen opens**, printing the manager lane's
non-repo message on stderr as one `error: …` line, and exits **5** — it
never falls back to solo. Solo sessions never pay the git probe.

Worker approval asks (a worker's challenged call it cannot answer itself)
route to the same approval overlay as a solo challenge: the dialog names the
worker and the full command, and the decision is written back to the run's
mailbox, which is what unblocks the worker's bounded wait. A denied ask ends
that worker's step (exit 4 on the CLI path) instead of hanging. The run's
own report lines are written to the transcript; the multi-agent worktree
tree is issue #342, not this entry.

Each submitted prompt is its **own orchestrator session**, named
`<tui-session>-o<stamp>` (a base-36 millisecond stamp; the per-worker
`session: created '<id>-<agent>'` lines carry it as a prefix): worktrees and
branches are retained per session until `kubic clean`, and a fresh run refuses
a session id that already has state (`session_exists`, exit 2), so a prompt can
never reuse an earlier prompt's id. List or dispose of them with
`kubic clean` (`--session <tui-session>-o<stamp>` for one). The merge approval
`kubic orchestrate` asks per worker (there is no `--yes` here) reaches the
same approval overlay as a worker ask, naming the worker and its branch —
never a terminal prompt, which would corrupt the alt-screen. A merge with no
seat to answer it is denied closed (exit 4), not asked on stdio, and the refusal message does not point at a `--yes` flag the TUI does not have.

`[modes] orchestrator = true` in `.kubic/config.toml` starts sessions in
orchestrator mode, so a bare `kubic` on a terminal opens the orchestrator
TUI without the flag; `modes.solo = true` (or an unset `[modes]`) keeps the
solo default, and both keys `true` is refused by name at config load. The
`--orchestrator` flag beats the config key.

**Full access (§41.4, issue #308).** `kubic tui --dangerously-skip-approvals`
— and the bare `kubic --dangerously-skip-approvals` on a terminal — enables
full access for the session it opens or resumes, through the same path as
`kubic run`: `posture.json`, one `posture:full-access` audit row, and a
`warning:` line on stderr before the screen opens. The status bar shows
`! warning: approvals OFF (full-access)` from the first frame. Off a
terminal the bare form prints the usage line and exits 1, like bare
`kubic`. The flag is never written to config.

**The posture is decided at boot (§41.4, issue #325).** `kubic run` and
`kubic tui` read the session's full-access posture once, when the lane
boots, from what the flag or `kubic sessions create
--dangerously-skip-approvals` recorded. `posture.json` is never re-read to
decide an ask: a change written during the session (for example by a tool
call) is ignored, the file is restored to the boot posture before the next
ask and at session close, and one `posture:changed-mid-session` row
(`result deny`) is appended to the audit ledger. Every decision row carries
the posture decided at boot.

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
- **Model selection (§38.1):** the same precedence as `run` — an explicit
  pin (`--model <provider/id>`, else `[model]` in config or
  `KUBIC_MODEL`), then the `--role` layer's `[roles.<name>].model`, then
  the first registered model. The header and status bar name the model
  the lane actually runs on. An unknown or unavailable pinned model exits
  6 with the named reason before the alt-screen opens. A bare `kubic
  --model <provider/id>` on a terminal is `kubic tui --model …`.
- **Agent id and role layers (§12.1, §35):** `[agent].name` names the lane
  (journal and reconciliation attribution, so `kubic diff --agent <name>`
  finds TUI changes) and `[roles.<name>].tools` layers under the role
  document on `--role`, exactly as `run`.
- **Audit identity (§60):** every approval the TUI resolves writes its
  ledger record with the session id and the `provider/id` model the lane
  runs at that moment: the model a resumed session kept (the unpinned
  default pick never applies, issue #148) and the one a `/model` switch
  moved it to (issue #227). The policy is installed before the lane boots,
  so the model is read when each record is written, not frozen at install.
- **Runtime exclude rules (§35):** `kubic tui` ships the same `.kubic/`
  exclude rules before creating state, so a session whose config ever
  relocates state in-repo leaves `git status` clean.

The loop is real: type a prompt, press `Enter` to submit, and the solo
lane drives it with events streaming into the views — tool calls appear in
the tree, the transcript grows with the committed conversation, and the
status bar fills with usage rows. While a turn runs the editor disables
submit; `Ctrl-C` cancels the in-flight solo operation and keeps the session
alive, and a second `Ctrl-C` (or `Ctrl-C` while idle) quits. An orchestrator
run cannot be cancelled from the TUI (there is no abort seam into the
manager): `Ctrl-C` during one quits, and the manager's own signal guard
reaps its live workers as the process exits.

**Journal panels and `bash`.** A change made with the file tools reaches
the journal (and both panels) as its tool call ends. A change made with
`bash` is not intercepted, so it is journaled by the reconciliation sweep —
which, in the TUI, runs when a turn that used `bash` **settles** (before the
panels refresh), not only at quit: after such a turn `Ctrl-R` lists the
change as `unattributed, non-reversible` and `Ctrl-O` follows it. The sweep
walks and hashes the workspace, so turns that ran no `bash` do not pay for
it; it is safe to repeat (an unchanged tree appends nothing). The cost is
real: the sweep is a synchronous walk-and-hash of the whole workspace on the
terminal's thread — about 60 ms for ~700 files, linear in workspace size — so
a large workspace pays it (and the screen pauses) after every turn that used
`bash`.

**Screen layout.** Top to bottom: a one-line header (the Konic `■ kubic`
wordmark, mode and model); the agent tree, sized to its content (at most 6
rows — older calls fold into `… N earlier calls`); the transcript, which
follows the end as the turn streams (your prompt is echoed as `› …` the
moment you submit, assistant prose renders as markdown, and each tool call
renders as `● name args` with its output folded underneath `⎿`); the
status bar, whose second row is the always-visible mode indicator
(`solo • approvals:on`, or the warning-styled
`! warning: approvals OFF (full-access)` when the session's installed
policy auto-approves every challenged call — read from that policy, at
boot and after every turn, never assumed); the editor; and a footer row that shows a `working… 3s`
spinner during a turn and the solo notice or the turn's outcome otherwise.
Colour follows the Konic palette on truecolor terminals, falls back to
256/16 colours, and is off for `NO_COLOR`, `TERM=dumb`, or a non-TTY
stdout (`FORCE_COLOR=0..3` overrides).

| Key | Meaning |
| --- | --- |
| `Enter` | **Submit** the prompt (an empty draft submits nothing). |
| `/model <provider/id>` | Switch the live lane's model (the §38.1 session override): resolved against the catalogue, committed to the session, and shown in the header and status bar. `/model` alone reports the current model; an unknown or malformed id is refused in the footer and the lane keeps its model. |
| `Ctrl-J`, `Shift+Enter`, `\` then `Enter` | Insert a newline (multi-line entry). |
| `Ctrl-T` | Toggle the tree (collapsed summary ↔ per-call rows). |
| `Ctrl-G` | Switch the session mode between **solo** and **orchestrator** between turns — the next submitted prompt takes the selected lane. Refused (with the reason on the footer) while a turn runs. |
| `Ctrl-O` | Toggle the **diff panel** — the most recent change, rendered as unified hunks: the last tool call that changed files, or — when a `bash` call changed something the file tools did not journal — that turn's reconciled change. |
| `Ctrl-R` | Toggle the **journal panel** — every change in the session journal, including changes made with `bash` (filter by path or agent on the command line with `kubic diff --path/--agent`). |
| `Ctrl-X` | Expand / collapse every tool output block (collapsed blocks show the first 5 lines and a `… +N lines` count). |
| `a` | Approval overlay: **allow once** — this call only, after the arming delay and the quiet period, and only while the overlay can show the whole command. Nothing is stored: the next identical call asks again. |
| `Ctrl-S` | Approval overlay: **allow for the session** — after the arming delay and the quiet period, and only while the overlay can show the whole command; never a bare letter. Latched in `<session>/approvals.json`; identical calls in this session are not asked again (also after re-attach). |
| `d`, `Esc` | Approval overlay: **deny** the challenged call. `Esc` acts at once (the only immediate action), `d` after the arming delay. A denial latches for the session like `Ctrl-S`, so the same operation is refused without asking again. |
| `v` | Approval overlay: show the next page of a command too tall for the dialog (never decides). |
| `Ctrl-C` | Cancel the in-flight turn; while idle, quit. A second `Ctrl-C` during a turn also quits. During an **orchestrator** run (which cannot be cancelled from the TUI) it quits directly — the manager's signal guard reaps its live workers as the process exits. |
| `Esc` | Quit (while no approval is pending — during an approval it denies). |
| `Ctrl-D` | Quit on an empty draft; while typing it stays delete-forward. |
| EOF (closed stdin) | Quit — a detached tty or `kubic tui < /dev/null` never hangs the alt-screen. |

Both panels read the session's own journal through the same projection
`kubic diff` prints (one change per path, latest attribution): once at boot
— so `kubic tui --session <id>` shows earlier turns the first time `Ctrl-R`
opens — after each tool call (throttled to one read per 100 ms burst) and
when a turn settles. Paths and file content are stripped of terminal
control sequences before they are drawn.

A challenged call opens the **approval overlay** instead of being refused: it
names the tool class and the exact command, so the decision is made on what
was actually asked, not on the tool's name. The command is shown **whole**:
it is the same text the approval key is computed from, wrapped across rows and
never silently cut, with three display-only changes. Control, bidi, zero-width
and other default-ignorable characters (including the Hangul fillers
`\u3164`/`\u115f` and tag characters) are shown as visible escapes such as
`\x1b` or `\u202e`; a literal `[REDACTED]` in the command is shown as
`\x5bREDACTED]`, so the marker only ever means "a value was hidden here"; and
secret **values** are replaced with `[REDACTED]`. That redaction is narrow on
purpose — the dialog exists so you see what runs, and a hidden word can be the
destructive verb:

- It replaces known key shapes (`sk-…`, `AKIA…`, `ghp_…`, `xox…-` with a
  realistic length and a word boundary, so `task-…` or `ghost_database` are
  not keys), the value in `NAME=value` (no whitespace around the `=`), in
  `name: value` (spaces or tabs after the colon), the operand of a
  secret-named flag on the same line (`--token abc`), an `Authorization:`
  header value with its scheme, and a bare `bearer …` followed by a
  credential-looking run (20+ characters mixing letters and digits).
- It never replaces the next command word: `find / -name secret -delete`,
  `echo bearer rm -rf ~/work`, `SECRET_KEY= shred -u x` (an empty value),
  `secret:/etc` (a mount) and `release-token:main` (a refspec) are shown exactly
  as written, and a value never spans a newline.
- It never redacts anything the shell would expand: a value containing
  `$(…)`, a backtick, `${…}` or `$NAME` is shown verbatim, so
  `API_KEY="$(curl … | sh)" npm test` reads as what it runs.

One-line summaries (audit detail, trajectory, the orchestrator's blocked
indicator) are different text: they keep the broader block-reason redaction
(which does swallow the word after `secret`, `token` or `bearer`) and, when they
shorten a command, say so: `… (+N chars)`. The dialog's `command` field is the
only place the narrow redaction applies. Orchestrator worker asks carry the
full command to your seat as well.

Rows wrap by terminal **display columns**, not by character count: wide (CJK)
characters count two columns, and a combining sequence or an emoji cluster is
never split, so every character of the command appears in the rows and none is
cut by the overlay's edge. A command taller than a page (8 rows, fewer when
the terminal is short — the dialog fits the 60 % of the terminal height the
overlay may use) shows one page at a time with an explicit
`… command lines 1–8 of N · [v] next page` marker, and `v` pages through it.
When even that does not fit — the overlay needs the fixed rows, the
justification, the hint row and either the whole command or one page with its
marker (about 10 terminal rows for a long command, 9 for a one-line one) — the
dialog **fails closed**: it shows `Too short to show this command — [d]/[Esc]
deny` (plus the tool and an enlarge hint when there are rows for them) and every
allow key (`a`, `Ctrl-S`) is inert until the terminal is tall enough, so you can
never allow what you cannot see. `d` (after arming) and `Esc` (at once) still
deny, and the dialog re-checks on every frame and key, so enlarging the
terminal restores it. Below 80 columns the overlay falls back to an inline slot
in the transcript (`! approval (inline)`) rather than rendering an unusable
box; the slot has no height cap, so it always shows the whole command. Denying
leaves the session running; the transcript shows the refusal instead of the
call's result. Quitting with an ask still pending denies it, so a shutdown
cannot strand the turn.

An approval is consent to run code with your authority, so keys typed for
the editor can never produce one. Asks arrive while you may be typing the
next prompt, so the overlay is a capturing modal: while it shows, printable
keys are dropped instead of reaching your draft (the global keys `Ctrl-C`,
`Ctrl-D`, `Ctrl-T`, `Ctrl-G`, `Ctrl-O`, `Ctrl-R` and `Ctrl-X` still work —
`Ctrl-G` answers with its usual footer refusal, since an approval only arises
inside a running turn). Three rules keep type-ahead and a held key from answering:

- **Arming delay, 400 ms.** Each request — including the next queued one —
  starts with decision keys ignored and the hint row reading
  `… keys unlock in a moment · [Esc] deny now`. `Esc` (deny) is the only key
  that acts immediately.
- **Quiet period, 1.5 s.** Every other key while the overlay shows — a
  dropped letter, a decision key pressed too early, a `v` page turn, a global
  key, or a key-repeat event — restarts the unlock, and this time it needs 1.5 s
  of quiet since the *last* such key (a thinking pause in prose is about half a
  second, so 400 ms would not be enough). The hint row re-locks while it runs.
  A lone decision key pressed after the overlay has been quiet for the
  period still decides at once.
- **Held keys.** Terminals that report key events flag repeats and they are
  ignored. Terminals that do not (Terminal.app, VTE, tmux) send a held `a` as
  plain repeated bytes; a decision key that arrives within 700 ms of the
  *same* key is therefore treated as a repeat — swallowed, and it restarts the
  quiet period. `Esc` is exempt.

Once armed the hint row shows the live keys:
`a` allows once, `Ctrl-S` allows for the session — a key ordinary typing
cannot produce — and `d` or `Esc` denies. The keys live in the approval key
registry, which refuses a map where two actions share a key, allow-session
is a prose key, or an approval key shadows one of the global keys.

These keys are classified by the terminal library's key decoder, not by
matching raw bytes, so they work on terminals that negotiate the Kitty
keyboard protocol (`Esc` arrives as `\x1b[27u` rather than `\x1b`, `Ctrl-D`
as `\x1b[100;5u`, `Ctrl-C` as `\x1b[27;5;99~`) as well as on terminals that
send the legacy control bytes. On terminals that also report key-release
and key-repeat events (Kitty, Ghostty, WezTerm, foot, recent iTerm2), each
key acts on its press only: a release is ignored, so a toggle never
cancels itself on key-up and a `Ctrl-C` cancel or an `Esc` deny never
becomes a quit. A held key repeats in the editor (held `Backspace` keeps
deleting), but repeats of the global keys and the approval keys are
ignored — a held `Ctrl-O` does not strobe the panel. Every key repaints
the screen at once, including while no turn is running. A refused cancel is reported in the editor
footer (`cancel failed: …`) instead of being swallowed — the turn keeps
running and the key is never a silent no-op.

Quitting leaves the alternate screen first (autowrap, cursor, mouse and
keyboard modes restored) and **then** prints the final document on your
main screen, so it stays in your scrollback: the whole last frame at the
terminal's width — header, tree, the transcript including the last
assistant answer, status bar, editor and footer — on stdout, without the
editor's cursor artifacts (the hardware-cursor marker and the inverse-video
cursor cell are stripped, as Pi's own stop path strips the marker). A crash
restore (see **Signals and crashes** below) prints no document. **Quitting mid-turn aborts the turn** — `Esc`, a second
`Ctrl-C`, `Ctrl-D`, `SIGINT` or stdin EOF while a solo turn runs: the operation
is aborted (recorded in the session, so a resumed session shows no
unfinished operation), every tool process group it started is killed, and
the loop waits for it to settle (footer: `cancelling…`, at most 3 s) before
the end-of-run reconciliation sweep and the session close — so a killed
tool's last write is still journaled and no child keeps running after the
TUI exits. An **orchestrator** run has no abort seam into the manager, so a
quit cannot stop the run itself: the loop waits for it at most the same
bound and closes the session, and the manager's signal guard reaps its live
workers when the process exits. A further `Ctrl-C` (or `SIGINT`) during that
wait exits at once — a real press only: the repeat and release events a
Kitty-class terminal reports for a held `Ctrl-C` are ignored, like every
other repeat of a global key. For a solo turn the 3 s bound covers the whole
drain, the abort request included: an abort that never answers no longer
blocks the quit (the registered kills still run, and a kill registered after
that drain is run once more when the session closes).
Before the screen is restored the quit drains stdin for a moment (the Kitty
keyboard protocol is popped first), so the release of the quitting key —
which can arrive late over SSH — is swallowed instead of printing as
`[27;1:3u` in your shell.

**Signals and crashes.** `SIGINT`, `SIGTERM` (a supervisor `kill`) and
`SIGHUP` (a closed terminal tab) all take the same quit path — mid-turn
drain, terminal restore, sweep, session close — run it once however many
arrive, and exit `128+signo` (130, 143, 129). A second signal during the
drain ends the wait. An exception in input or render, or an unhandled
promise rejection, restores the terminal first (alt screen left, autowrap
back on, cursor shown, mouse tracking and the Kitty protocol off, cooked
mode), then prints `error: kubic tui crashed: …` on stderr and exits 1.
`Ctrl-Z` suspend is not supported. Solo mode runs in-process with your user authority: no
isolation, no containment. The no-isolation statement is on screen from the
first frame: the editor footer carries the one-line form at startup and
returns after every completed turn (a cancelled or failed turn reports that
outcome instead). It is suppressed for orchestrator-managed worker children
(`KUBIC_WORKER_ID` set) and by the opt-out `KUBIC_NO_NOTICE=1`; see
[`kubic run`](#kubic-run--p-prompt---session-id---timeout-ms---max-turns-n---role-name---model-providerid---skill-path---no-skills---debug---json).

Text rendered in the transcript is stripped of terminal control sequences
before it reaches the frame: assistant text and tool output are untrusted
input, so ANSI escapes (`\x1b[2J`, colour codes, cursor moves) and C0
controls such as BEL are removed rather than executed by the operator's
terminal. The renderer's own styling is unaffected.

## `kubic sessions`

Sessions live under `~/.kubic/sessions` by default. Each subcommand has
its own generated help (`kubic sessions prune --help`).

| Subcommand | Meaning |
| --- | --- |
| `create [--cwd <path>] [--dangerously-skip-approvals]` | Create a session, print its id on stdout. `--cwd` sets the session directory (default: current directory). `--dangerously-skip-approvals` records session-scoped full-access in the session dir, appends one `posture:full-access` row to the audit ledger (session id, `kubic sessions create --dangerously-skip-approvals`), and prints a `warn:` line on stderr — fresh sessions start safe, the flag must be passed explicitly every time. |

| `list [--json]` | A `SESSION  CWD` table (plain aligned columns off a terminal, box-drawn on an interactive colour terminal). With no sessions stdout stays empty and an `info:` line on stderr says so. `--json` prints one pretty-printed array of `{id, cwd}` objects — `[]` when there are none. A session written by Kubic on Pi 0.87 is listed with its recorded cwd and marked `(legacy pi 0.87 — cannot attach)`: it is listed so it can be seen, and it can never be attached ([below](#session-storage-and-legacy-pi-087-sessions)). |
| `attach [--] <id> [--tail <n>]` | Print session metadata, the approvals posture (`approvals enforced` or `full-access …`), the `pending work: <kind> <id> (<status>)` summary when a crashed run left unfinished durable work (settled by the next `run`/`tui --session`), then the last `--tail` transcript turns (default 10) — one readable line per turn (`user: …`, `assistant: …`, `tool-result <name>: …`, `system: …`, `[compaction] …`, `[reset] …`), whitespace collapsed and bounded to 300 characters; transcript text and model-authored tool names are untrusted, so terminal control sequences are stripped before a line is printed. `--tail` needs a non-negative integer. |

| `prune [--keep-days <n>] [--keep-session <id>]... [--yes] [--dry-run]` | Retention for session **state dirs** (`<sessions-root>/<id>/`): **lists by default, deletes only with `--yes`** (or a yes at the terminal prompt). See [Session retention](#session-retention-prune) below. |

Usage errors exit 2 on stderr: a missing subcommand (commander prints the
subcommand list), an unknown option, a missing value, `attach` without an
id or with an id outside `[A-Za-z0-9_-]`, a malformed `--tail`,
`--keep-days` or `--keep-session`, and `--yes` with `--dry-run`. An
unknown subcommand exits 1 (`error: unknown command '<name>'`), like an
unknown top-level command. Attaching a missing session exits 1; attaching
a session another process holds live prints the lock refusal (issue #118 —
the holder's pid and start time are named) and exits 1 without reading
the transcript. Attaching a session written by Kubic on Pi 0.87 exits 1
with `session <id> was written by Kubic on Pi 0.87; start a new session`

([below](#session-storage-and-legacy-pi-087-sessions)).

The transcript `attach` prints is the durable one, read through the shared
pi-durable adapter (`packages/worker/src/lane/transcript.ts`, issue #400)
and never by booting a lane: a reader must be able to inspect a session it
may not run.


### Session storage and legacy Pi 0.87 sessions

A session is one directory, `<sessions-root>/<id>/`, holding the
pi-durable JSONL storage (`main.jsonl` and its `doc-*.jsonl` sidecars —
the transcript, documents and durable tasks), Kubic's `session.json`
listing header, the lock, the journal, spans, approvals posture and
trajectory. The session's metadata is the session-scoped `kubic.session`
document, written in the creating commit, so anything holding the session
open reads it from the same durable state as the transcript. Session JSONL
is not fsynced (matching the previous storage); the change journal is the
fsync'd store.

Sessions written by **Kubic on Pi 0.87** used a different format: one
transcript file per session at `<sessions-root>/--<cwd>--/<ts>_<id>.jsonl`,
beside the session's state directory. Kubic does not convert them — the
project is unreleased, so there is nothing to migrate:

- `kubic sessions list` reports them as `legacy` (the store returns
  `format: 'legacy'`; the CLI row lands with #400) and never crashes on one.
- `kubic sessions attach <id>` refuses by name, exit 1:
  `session <id> was written by Kubic on Pi 0.87; start a new session`.
  Nothing is read, moved or rewritten.
- A 0.87 transcript is never counted by the session-overlap warning
  (`kubic doctor`): it cannot be attached, so it cannot be a live sibling.
- `kubic sessions prune` still never touches `--<cwd>--` transcript
  directories — only `<root>/<id>/` state dirs ([below](#session-retention-prune)).

Start a new session (`kubic sessions create`, or just `kubic run`) and the
state directory's own format is the durable one.

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
  removes nothing. On an interactive terminal (stdin and stdout both a
  TTY) and without `--dry-run`, it asks once after the list —
  `Delete N session(s) (NB)?` — and deletes only on yes; no, Ctrl-C or Esc
  keeps everything and prints the dry-run summary. Off a terminal it
  never asks. `--dry-run` is the explicit synonym of that default;
  `--yes` deletes the listed set (`pruned <id> (<bytes>B)` per session,
  then `pruned N session(s), NB reclaimed`; a candidate whose lock goes
  live in between is skipped and never counted — see the lock bullet
  below). `--yes` with `--dry-run` contradicts and is refused by name.
  `nothing to prune` exits 0.
- **The keep window is never invented.** `--keep-days <n>` (a
  non-negative integer of days) wins; without it, `session.retentionDays`
  from config supplies the window; with neither, `prune` exits 1 naming
  both ways to set one (on stderr). `--keep-days 0` — or `retentionDays = 0` — means
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
  `lock.json`, names outside `[A-Za-z0-9_-]`, and the `--<cwd>--`
  transcript directories of 0.87 sessions (which hold the `.jsonl`
  transcripts of every session recorded against that cwd) are never
  touched. A session that
  cannot be inspected is skipped and reported
  (`unreadable: <id> — skipped`), never guessed at. A missing sessions
  root is a fresh machine: `nothing to prune`, exit 0. A root that exists
  but cannot be listed refuses by name, exit 1.
- **Scope.** `prune` deletes `<sessions-root>/<id>/` state dirs only —
  never the workspace journal (`.kubic/journal`), never orchestrator
  worktrees (`kubic clean` owns those), never anything outside the
  sessions root. A durable session's transcript lives INSIDE its state dir
  (`main.jsonl`), so pruning a session deletes its transcript with it. The
  `--<cwd>--` transcript directories of sessions written by Kubic on Pi
  0.87 stay beside the state dirs and are not part of this command today
  ([legacy sessions](#session-storage-and-legacy-pi-087-sessions)).

## `kubic git`

Thin over git ops. Outside a repo every subcommand exits 1 with
`error: not a git repository — kubic diff/undo still work without git` on
stderr — the journal path never needs git. Any other git failure is one
`error: <reason>` line on stderr, exit 1.

```
kubic git status [--json]
kubic git log [--max <n>] [--json]
kubic git stage [--json] [--] <paths...>
kubic git commit -m <message> [--json]
```

`kubic git --help` and `kubic git <subcommand> --help` print generated help
(exit 0). Usage errors exit **2** with one `error:` line on stderr: a bare
`kubic git`, an unknown subcommand, an unknown option, a missing option
value, `--max` that is not a positive integer, `stage` with no path,
`commit` without `-m` or with an empty message.

| Subcommand | Meaning |
| --- | --- |
| `status [--json]` | Branch (plus ahead/behind when non-zero), `staged:`/`modified:`/`untracked:` lines, or `clean`. On a detached HEAD the branch line reads `branch (detached HEAD)`. `--json` prints the status object: `branch` is `null` on a detached HEAD, and `renames` lists one `{path, oldPath, staged}` record per renamed or copied path that git detected (the new path also appears in `staged`/`modified`). |
| `log [--max <n>] [--json]` | A `SHA DATE AUTHOR MESSAGE` table (short sha), or `no commits` — also on a fresh repo with no commits yet (exit 0). `--json` prints the entries array (`[]` when empty). |
| `stage [--] <paths...>` | Stage paths, print `staged <p>` per path. `--json` prints `{staged: [paths]}`. Put `--` before a path that starts with `-`. |
| `commit -m <message>` | Commit, print `committed <sha8> (<n> file(s))`. `--json` prints `{sha, files}` with each path verbatim (never C-quoted, even non-ASCII or newline names). `-m`/`--message` takes the next token verbatim, even one starting with `-` (`-m --amend` commits the message `--amend`). |

On a colour terminal (TTY, no `NO_COLOR`, not `TERM=dumb`) the status
labels are coloured and `log` is a box-drawn table; piped or under
`--json` the output is plain text.

## `kubic diff | undo | log | status`

VCS-independent change journal — works without git. Each command reads
one store, resolved in this order (issues #18, #125, #362):

1. `--session <id>` names the store explicitly: the headless-run session
   journal at `<sessions-root>/<id>/journal` (`~/.kubic/sessions` by
   default). `kubic run` prints the session's ref as `journal:<id>`; pass
   it verbatim (`--session journal:<id>` or `--session <id>`). It works
   from any cwd, and it always operates on **the session's own recorded
   workspace** (the cwd the session was created in): `kubic undo --session
   <id>` run from another project restores files under the session's
   workspace, never under the current directory.
2. Without `--session`, the workspace store `<root>/.kubic/journal` (the
   interactive solo journal for the current directory) when it is
   non-empty.
3. Otherwise the **latest session journal recorded for this workspace**:
   among the sessions whose recorded cwd is the current directory or
   contains it (compared after resolving symlinks), the most recently
   written run journal. Another project's session is never picked, however
   recent.

A session store is named on stderr before any output, together with the
workspace its paths resolve against: `info: session: <id> (latest session
journal for this workspace) — workspace <root>` for the fallback, `info:
session: <id> — workspace <root>` for `--session`. `--json` prints nothing
extra on stderr; every `--json` document carries the resolved store as
`session` (the id, or `null` for the workspace store) and `root` (the
workspace the paths resolve against): `diff --json` is `{session, root,
changes}`, `log --json` is `{session, root, entries}`, and `undo`/`status`
add both fields to their objects.

`undo` and `status` refuse a session store whose workspace cannot be used —
exit 2, nothing read or written, a named reason on stderr: `session <id>:
recorded workspace <root> no longer exists — …` when the recorded directory
is gone, and `session <id>: no recorded workspace — …` for a session
journal the session store has no cwd for. `diff` and `log` read only the
journal, so they still work for such a session.

When no journal exists for the current directory, `diff` prints `no
changes` on stdout plus a note on stderr naming both places that were
looked at — `info: no journal under <dir> and none under the sessions root
(<root>) — start a run or pass --session` — and exits 0. `undo --dry-run`
plans against the same store `diff` reads. Session ids accept only
`[A-Za-z0-9_-]` — anything else (including `../` or absolute paths) is a
usage error (`error: invalid --session id …` on stderr, exit 2) before any
path is touched. With the workspace store, file restores and the `status`
repo line resolve against the current directory. `--session` combined with
a programmatically configured journal dir is refused (one store per
invocation, exit 2).

**Output channels.** The report — the diff, undo verdicts, the log table,
the status lines, or the one `--json` document — goes to stdout.
Diagnostics (the fallback note, the empty-journal note, undo warnings as
`warn: …`) go to stderr, so `kubic diff --json | jq` always sees pure
JSON. On a colour terminal (TTY, no `NO_COLOR`, not `TERM=dumb`) the diff
is coloured — additions green, removals red, `@@` hunk headers amber, file
headers bold, attribution lines grey — undo verdict words are coloured, and
`log` is a box-drawn table; piped, redirected or under `--json` everything
is plain text.

**Usage errors** exit **2** with one `error:` line on stderr and touch
nothing: an unknown option, an option without its value (`--path`,
`--agent`, `--session`, `--max-content-bytes`), a `--max-content-bytes`
that is not a non-negative integer, an extra operand (only `undo` takes
one, the `<path>` scope), a bad or conflicting `--session`. Every command
answers `--help`/`-h` with generated help (exit 0); `diff --help` and
`undo --help` include examples.

**Read-time self-heal (issue #119).** With `session.retentionDays` set in
config, `kubic log` drops entries older than that window from a **session**
journal as it reads it — via `--session <id>` or the latest-session
fallback — the same age bound `kubic sessions prune` applies to whole
session dirs, one entry at a time. The workspace journal is not affected
(its own `[journal] retentionDays` bounds it on append). With retention
unset — or `0` — the log path writes nothing: reads never mutate the store.

```
kubic diff [--path <path>] [--agent <id>] [--max-content-bytes <n>] [--session <id>] [--json]
kubic undo [--step] [--dry-run] [--force] [--session <id>] [--json] [--] [<path>]
kubic log [--session <id>] [--json]
kubic status [--session <id>] [--json]
```

Options also take the `--flag=value` form (`--agent=w1`).

| Subcommand | Meaning |
| --- | --- |
| `diff [--path <p>] [--agent <id>] [--json] [--max-content-bytes <n>] [--session <id>]` | Rendered diff of journaled changes (`no changes` + exit 0 when empty). `--path`/`--agent` filter; `--json` prints `{session, root, changes}` — the change array with each side clipped at 64 KiB per change (`--max-content-bytes <n>` overrides the bound; `0` = unlimited). A `--path`/`--agent`/`--session` without a value, or a `--max-content-bytes` that is missing or not a non-negative integer, is a usage error (exit 2). |
| `undo [--] [<path>] [--step] [--dry-run] [--force] [--json] [--session <id>]` | Restore journaled changes. `--json` prints one object `{session, root, dryRun, restored: [paths], skipped: [{path, kind: stale\|already-undone\|non-reversible, reason}]}` (also when there is nothing to undo) with the same exit codes. Positional `<path>` limits scope; `--step` restores one step; `--dry-run` prints `would restore N step(s)…` and exits 0 without touching anything. Real runs print `restored <p>` per path plus a summary; warnings (a removal whose content had no recoverable copy) go to stderr as `warn: …`. `nothing to undo` exits 0. **Exit 2 when any step was skipped** — three skip classes, each with its own line: `non-reversible (skipped): <p>` (no retrievable pre-image: an unattributed reconciliation find, or a delete-shaped undo whose file was absent pre-undo), `stale (skipped): <p> — <reason>` (the file changed after the entry was journaled — restoring would destroy unjournaled changes), `already undone (skipped): <p>` (a previous undo already unwound it — nothing is rewritten). The summary is `undo: N restored, M non-reversible` when all skips are the non-reversible class, else `undo: N restored, M skipped (K stale, J already undone)` naming the counts present. The `--session` value selects the store, never the path scope. |

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
| exists, hash == recorded after | agent **create** (no before) | restore = **remove the file** (its pre-state was "absent") |
| missing | agent **create** | **already undone: skip** (already absent — also with `--force`) |

An agent-authored create (the write tool made a new file) reverts by removing
the file; the removal is journaled as a `kubic-undo` delete carrying the
removed content, so `kubic undo --step` right after it is the redo.
Unattributed reconciliation creates stay non-reversible.

`--force` overrides the stale refusals per-invocation (nothing persists it;
the next `undo` re-checks by default). `--force` does not override
non-reversible skips — no pre-image exists to write. Already-undone skips are
informational: there is nothing to force.

**The undo record and redo (issue #117).** Every successful restore is
itself journaled: the store appends the inverse entry for the step — the
pre-undo content as `before`, the restored content as `after`, attributed
`agent=kubic-undo toolCall=none` and never marked `reconciled` (it is an
attributed change, not a reconciliation find). `kubic diff` and `kubic log`
therefore describe the world *after* the undo, and `kubic undo --step`
immediately after an undo is the **redo**: it restores the undo record's
`before` — the content the undo replaced. An edit-shaped undo (the file
existed before it) carries that `before`, so undoing it is the redo and can
be repeated; a delete-shaped undo (the file was absent pre-undo) has no
before-content, so `--step` on it reports it non-reversible instead — the
undo of a delete cannot itself be undone. Plain `undo` (no `--step`) never
targets `kubic-undo` records: it restores real agent work once and then
reports `already undone` without appending, so repeating it never re-undoes
the undo. `--dry-run` appends nothing; a skipped step appends nothing. |
| `log [--json] [--session <id>]` | A `TIME AGENT TOOL CALL OP PATH BYTES NOTE` table, one row per journal entry, oldest first — `NOTE` reads `reconciled` for an unattributed sweep find (`journal is empty` + exit 0 when empty); `--json` prints `{session, root, entries}` with the raw entries array. The human output closes with the reconciliation line `unattributed: N of M entr(ies) reconciled at run end` (printed for an empty journal too). |
| `status [--json] [--session <id>]` | `--json` prints the status object (`session`, `root`, `entries`, `reversible`, `nonReversible`, `unattributed`, `corrupt`, `repo`). Otherwise `entries: N (reversible: R, non-reversible: M)`, then `unattributed: U of N (reconciled at run end)`, plus repo line: `repo: non-repo directory (journal works without git)` or `repo: branch <b>, dirty: yes|no|unknown`. Inside a linked worktree the branch is resolved through the `.git` `gitdir:` pointer (below); an unreadable pointer prints `branch (unknown)`. |

**Display truthfulness (issue #126).** Three display-level guarantees on the
read side:

- **Worktree branches resolve.** A linked worktree's `.git` is a pointer
  file (`gitdir: <path>`), not a directory — exactly the trees
  `kubic orchestrate` creates and retains. The `status` repo line follows
  the pointer to the real `HEAD` (pure file reads; no `git` invocation) so
  a live branch is named instead of `(detached)`. A dangling or malformed
  pointer reports `branch (unknown)` — named, never a throw — and a
  genuinely detached `HEAD` still reports `(detached)`. The `dirty` probe
  is unchanged (`git status --porcelain`).
- **Hunk counts are truthful.** Every `@@ -a,b +c,d @@` header in `diff`
  output counts exactly the lines the hunk prints for its side (`-` and
  context for `a`, `+` and context for `b`); the counts accumulate while
  emitting, so a consumer (the TUI view, a future patch applier) can trust
  them.
- **`--json` is bounded.** `diff --json` clips each side of every change at
  **64 KiB** (UTF-8 bytes) by default; a clipped side ends with the marker
  line `[kubic: content truncated at 65536 bytes]` and that change carries
  `contentTruncated: true`. `--max-content-bytes <n>` sets the bound and
  `--max-content-bytes 0` means **unlimited** (the unbounded pre-#126
  behavior, for scripting). The bound applies to `--json` only — the human
  diff renders hunks, never whole files, and is never clipped.

### End-of-run reconciliation (issue #87)

Interception alone has holes (§42.1 mechanism 2): a file moved by `bash`
(`sed -i`, a formatter, `npm install` fallout, a build) never passes through
Kubic's own `write`/`edit` operations, so nothing journals it. The run and TUI
composition paths therefore capture a **baseline** when the lane boots and
**sweep** the workspace when it ends:

- The baseline is a metadata walk — sha256 per file, **no content copied** — of
  the lane's workspace root (`§42.5`), persisted as
  `<sessions-root>/<id>/journal/baseline-<id>.json` beside that run's journal.
- The sweep compares each path against its **expected state**: the last
  entry journaled for it during *this* run (the journal position is recorded
  with the baseline), or the baseline when this run journaled nothing for it.
  It appends one entry per changed, created or deleted path with
  `unattributed: true` and `toolCallId: null`, and the entry's `beforeHash`
  is that expected state (issue #341). A revert behind the tools' back is a
  change too: a tool writes `a.txt` and `git checkout a.txt` restores it, so
  the sweep records the restore and `diff` stops showing an edit that no
  longer exists. Earlier runs of a resumed session never mask a change: a
  file set back to an older run's content, or deleted again after being
  recreated between runs, is journaled. A path only a tool journaled (absent
  from the boot baseline) is never reported deleted while it is still a
  regular file on disk: the sweep walk skips gitignored, `.git/` and `.kubic/`
  paths, so their absence from the walk is not a delete (issue #341). Once such
  a file is really gone — removed, or replaced by a directory or a symlink —
  the delete is journaled.
- Excluded from **both** walks: `.git/`, `.kubic/` (journal state is never
  journaled) and anything the `.gitignore` files match — the root's rules plus
  every nested file's, child rules after the parent's so a nested negation
  overrides a parent ignore (last-match-wins, the ordering git uses, issue
  #116); caller-declared out-of-scope paths are honoured when supplied. The
  matcher is the documented common subset (`*`, `?`, `**` at the edges,
  `dir/`, `!`) — exotic syntax is not covered, a nested anchored pattern is
  matched against the workspace-relative path (write it repo-relative:
  `packages/foo/build/`), and an unreadable nested ignore leaves its parent's
  rules in force. Anything missed only widens the baseline, never narrows the
  journal.
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
  nothing; a file that *did* change is read once to store its after-content,
  because that content is what `diff` and `undo` serve — and that read is
  bounded too (issue #120): above `MAX_SWEEP_CONTENT_BYTES` (4 MiB) the entry is
  recorded **hash-only** (`after: null`, the walk hash intact) and `diff` shows
  `[content not captured — N bytes changed]` instead of paying the file's size
  in memory on the run's exit path. The lossy-decode guard records the same
  hash-only shape for a file whose utf-8 decode is not a faithful round-trip
  (binary content): it is never stored as U+FFFD-mangled text. At or under the
  bound a genuine text file still gets full after-content, exactly as before.
- Chunking bounds *memory*, not *time*: the walk still reads a file's full
  apparent size, so a sparse or genuinely huge file costs its size in I/O at
  boot. A file above 256 MiB is named on the debug channel
  (`reconcile: hashing a very large file: <path> (<bytes>)`) so the cost is
  visible instead of silent; nothing is skipped, because a skipped file's
  changes would be invisible to the journal.
- Fail-open: a baseline or sweep failure is reported on the debug receipt and
  never turns a finished run into a failed one.

`kubic log` answers "did anything bypass the tools?" with the count line above;
`kubic status` names it in the summary. `--json` keeps the raw entries (the
`unattributed` flag is on each entry there).

## `kubic models [--json] [--resolve <provider/id>]`

Catalog readout over Pi's **built-in providers** (the generated catalogue:
`anthropic`, `openai`, `google`, `amazon-bedrock`, `openrouter`, …) plus
`models.json` customs from `~/.kubic/models/models.json` (always) and the
project's `models.json` at the project root — the git top level or nearest
`.kubic/`, so any subdirectory sees the same providers — only once the
project is trusted (`KUBIC_TRUST_PROJECT=1`). Each file found is reported as an
`info: loaded models.json: <path> (global|project, trusted): …` /
`info: models.json ignored: <path> …` line on stderr — untrusted, invalid
or colliding files are named, never fatal (see
[configuration](configuration.md#modelsjson)). A built-in is
**usable** when its auth is configured: its documented env key
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`OPENROUTER_API_KEY`, …), Anthropic's workload identity federation variables
(`ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`,
`ANTHROPIC_IDENTITY_TOKEN_FILE`), or, for Bedrock/Vertex, the ambient
AWS/Google credentials Pi recognises. Only **chat** models are ever listed or
resolved: the catalogue also carries image and classifier entries, and the
unqualified reads `kubic models` and model selection use return chat models
only. A custom provider may not reuse a built-in id
(the file is ignored with a note naming the collision). Under
`KUBIC_PROVIDER=faux` the catalog also lists the `faux` testing provider
and a `warn:` line names it.

| Flag | Meaning |
| --- | --- |
| (none) | A `PROVIDER  MODEL  THINKING  IN $/1M  OUT $/1M` table, one row per model of every **usable** provider (plain aligned columns off a terminal, box-drawn on an interactive colour terminal), then `info: <n> built-in providers not configured (set their env key): …` on stderr for the rest. With nothing usable, stdout stays empty and stderr says `info: no usable providers (set a built-in provider's env key, e.g. ANTHROPIC_API_KEY, or add models.json)`. Exits 0. |
| `--json` | Every registered provider, usable or not, as one pretty-printed JSON document: `id`, `name`, `source` (`built-in`, `testing` or the `models.json` path), `usable`, `auth` (the auth source Pi reported, when configured) and `models` (`id`, `name`, `thinking`, `inputCost`, `outputCost`, `cacheReadCost`, `cacheWriteCost`, `input` modalities). Exits 0. |
| `--resolve <provider/id>` | Print `selected <provider>/<id> (thinking: …)` for any registered model, built-in or custom, configured or not; a resolution failure prints `error: …` on stderr and exits 1. |

**Default model.** `kubic run`/`kubic tui` with no `--model`, `[model]`,
`KUBIC_MODEL` or role pin take the first model of the first usable
provider: `models.json` customs first, then built-ins whose auth is
configured. A built-in with no key is never picked implicitly; with nothing
usable the run exits 6 (`provider_probe_failed`). Pin the model you mean,
e.g. `[model] provider = "anthropic"`, `id = "claude-sonnet-4-6"`.

Usage errors (unknown option, `--resolve` without a value, an operand)
exit 2 on stderr. `--help`/`-h` prints the generated help and exits 0.

## `kubic config [--json] [--model <provider/id>]`

The effective configuration with the layer each value came from — see
[configuration](configuration.md#seeing-the-effective-values). `--json`
prints one pretty-printed JSON document. `--model <provider/id>` reports
the config as if that session override were passed, so the `model.*` rows
and the `selected model:` line carry the `(cli)` source the `run`/`tui`
lane would use. A refused config prints
`error: <reason>` on stderr and exits 1; usage errors exit 2.

## `kubic trust [--revoke] [--list] [path]`

Record, revoke or list the durable project-trust decision that makes a
committed `.kubic/config.toml` usable — see [project trust](trust.md).
`kubic trust` grants trust for the current directory (or the `[path]`
operand — a directory, or a symlink to one: the grant is recorded under the
resolved path), `--revoke` removes the recorded decision so the pre-trust
refusal comes back, and `--list` prints every recorded decision. **One
grant covers the whole project tree**, not only `config.toml`: the
committed `.kubic/config.toml`, the project `models.json` (its provider
URLs are sent the key of any `*_API_KEY` or `KUBIC_*` variable it names,
`KUBIC_API_KEY` when it names none) and the
project skills. The help, the interactive prompt and the grant output all
say so. Exit 0 on success; a corrupt store is named and exits 1; a path that
is not a directory, or `--list` combined with `--revoke`/a path, exits 2.

## `kubic doctor [--skip <id[,id…]>]... [--json]`

Health readout — see [doctor and debug](doctor-and-debug.md).

| Flag | Meaning |
| --- | --- |
| `--skip <id[,id…]>` | Mark checks skipped (comma-separated, repeatable). An id that matches no check exits 2 (`error: unknown check "<id>"` on stderr); `--skip` without a value exits 2. |
| `--json` | Emit `{ok, exitCode, checks}` as one pretty-printed JSON document instead of human lines. Same exit code either way. |

Human lines keep the `STATUS id (reason): detail` shape; on a colour
terminal the status is coloured (pass green, warn amber, fail red, skip
grey). Unknown options exit 2. Full exit-code contract is on the
[exit-codes page](exit-codes.md).

## `kubic workers [--json] [--debug]`

Worker list read from the repo's persisted record
(`<repo>/.kubic/orchestrator/workers.json` — one shared record, never a
fresh empty registry): one line per worker with
the §13 status verbatim, age, owner, pid, startup span ms, and
resources (`skills=… templates=…`, `-` when none). A row that claims a live status
whose worker and manager processes are both gone is shown as `crashed`. A repo that never ran
an orchestrator has no record — nothing on stdout (`--json` prints `[]`), an
`info: no orchestrator workers recorded in this repo` note on stderr, exit 0.

| Flag | Meaning |
| --- | --- |
| (none) | A table with one row per worker: `WORKER  STATUS  GEN  AGE  OWNER  PID  STARTUP  RESOURCES` (`-` for an unknown pid/startup). Plain space-aligned columns off a TTY (pipes, CI, `NO_COLOR`); box-drawn, with the status coloured, on an interactive colour terminal. |
| `--json` | The same rows as JSON (`workerId`, `sessionId`, `generation`, `status`, `ageMs`, `owner`, `resources`, `pid`, `startupMs`) — field-for-field with the text view. |
| `--debug` | `[worker] spawn …` per row plus `[exit] code=0 exited cleanly` on stderr (`KUBIC_DEBUG=1` does the same). Spawn env values are always redacted (`KUBIC_ROLE_*` never prints). |

`kubic workers --help` prints the generated help and exits 0. An unknown
flag, a stray operand, or a value on a boolean flag (`--json=1`) prints one
`error: …` line on stderr and exits 2 (no stack trace).

## Analysis commands: shared rules

`eval`, `benchmark`, `replay`, `export`, `cost`, `perf`, `policy` and
`audit` are parsed by commander
(`apps/kubic/src/commands/analysis.ts`, see
[contributing-cli.md](../contributing-cli.md)). They share these rules:

- **Help.** `kubic <command> --help` (or `-h`) prints generated help on
  stdout and exits 0. The help lists every option with its argument and
  meaning, followed by an `Examples:` block.
- **Argv syntax.** Both `--flag value` and `--flag=value` work, and `--`
  ends the options. An unknown option, an option missing its value, a
  missing required option, or an extra operand prints one
  `error: …` line on **stderr** (for example
  `error: unknown option '--bogus'` or
  `error: required option '--budget <kind>' not specified`) and exits
  **2**. The command itself never runs.
- **stdout is data, stderr is diagnostics.** Reports, tables and JSON go
  to stdout. Refusals and warnings go to stderr, one `<level>: <message>`
  line each. A refusal is `error: <message>`, or
  `error: [<code>] <message>` when it has a code.
- **Tables.** `cost`, `perf`, `audit` and `benchmark` print their rows as
  a table. On a colour terminal the table is box-drawn with coloured
  headers. On a pipe, in CI, or with `NO_COLOR`, it is plain
  space-aligned columns.
- **`--json`.** stdout carries exactly one JSON document and nothing
  else, with no colour and no tables. Every document is indented with
  two spaces (the eval, benchmark, replay and export envelopes were
  single-line before the commander migration). `eval`, `benchmark`, `replay` and
  `export` put runtime failures inside their envelope. A bad invocation,
  which is a usage error, leaves stdout empty and prints its `error:`
  line on stderr.

## `kubic eval --suite <id> (--task <prompt> | --trajectory <json>) [--generation <n>] [--worktree <path>] [--tier <tier>] [--model <id>] [--workspace inline|worktree] [--thinking <level>] [--json]`

Scores one suite against a task prompt or an existing trajectory
export. Every record needs its provenance (`model`, `thinking`,
`worktree`, `generation`) and a `--tier`; a record missing any of them
is refused with exit 2 and is never stored.

- With `--task`, the provenance comes from the flags: `--worktree` and
  `--generation` are mandatory and `--model` defaults to `faux/faux`.
- With `--trajectory`, the provenance comes from the export itself:
  `model` from `provenance.model`, `thinking` from `model.thinking`, and
  `worktree` and `generation` from `provenance`. These flags become
  optional cross-checks. A flag that disagrees with the export is
  refused with exit 2 and `[provenance-mismatch]`, and no record is
  printed. The tier is not part of an export, so `--tier` stays
  mandatory.

Every record carries `success`, `costUsd`, `tokens`,
`latencyMs`, `toolCalls`, `model`, `thinking`, `worktree`,
`generation` and `tier`.

| Flag | Meaning |
| --- | --- |
| `--suite <id>` | **Required.** One of the built-in suites: `swe-bench-mini`, `repo-mod-rename`, `bugfix-repro`, `refactor-extract`, `testgen-cover` or `review-diff`. `terminal-live` and `agentic-live` are stubs and refuse with exit 2. An unknown suite exits 2. |
| `--task <prompt>` | Runs the suite against a task prompt. This needs a live model-backed suite runner, which the binary does not ship, so it exits 1 with a pointer to `--trajectory` instead of scoring fiction. |
| `--trajectory <json>` | Scores an existing trajectory export, given as inline JSON, without re-running anything. Fully live: exits 0 with the record, or 1 when the gates fail it. Text that is not JSON exits 2. |
| `--generation <n>` | The worker generation that ran. Must be an integer; anything else exits 2. **Required with `--task`.** With `--trajectory` it is read from `provenance.generation`; a different value exits 2 (`provenance-mismatch`). |
| `--worktree <path>` | Where the run executed. With `--task`, a record without it is refused with exit 2. With `--trajectory` it is read from `provenance.worktree`; a different value exits 2 (`provenance-mismatch`). |
| `--tier <smoke\|standard\|extended>` | Published on every record. Provenance: a missing or unknown tier exits 2 on both paths. |
| `--model <id>` | `provider/id` of the run. With `--task` it defaults to `faux/faux`. With `--trajectory` it is read from `provenance.model`, and a different value exits 2 (`provenance-mismatch`). |
| `--workspace inline\|worktree` | `worktree` refuses with exit 2 unless `git status --porcelain` in `--worktree` is clean. Any other value exits 2. Default `inline`. |
| `--thinking <level>` | With `--task`, recorded on the record verbatim (default none). With `--trajectory` it is read from `model.thinking`, and a different value exits 2 (`provenance-mismatch`). |
| `--json` | Prints one JSON envelope (`ok`, `exitCode`, and either `record` or `error`) instead of the text line. The exit code is the same either way. |

Text mode prints one `eval ok: suite …` line on stdout. A refusal prints
`error: [<code>] <message>` on stderr.

## `kubic benchmark --generation <n> [--suite <id>] [--worktree <path>] [--tier <tier>] [--model <id>] [--workspace inline|worktree] [--thinking <level>] [--json]`

Runs the reproducible matrix: every suite, or a single one with
`--suite`. The output is a `SUITE / CATEGORY / STATUS` table followed by
the verdict line: `benchmark ok|FAILED: <passed>/<executed> suites passed,
<n> stub(s) skipped`.

Stub suites show as `skipped (stub)` with `success:false`, so they are
never reported as passing work, and they never count toward the verdict.
The exit code is:

- 0 if every executed suite succeeded
- 1 if any executed suite failed
- 2 on usage errors: an unknown suite, missing provenance, a dirty
  `--workspace worktree`, or a suite that needs the live runner the
  binary does not ship

The flags are the same as `kubic eval` without `--task` and
`--trajectory`; each matrix row runs `benchmark:<suite-id>` as its task.
`--json` prints `{ok, exitCode, results}`.

## `kubic replay ([--] <trajectory.json> | --session <id>) [--tier recorded|deterministic|live] [--model <provider/id>] [--lockfile <path>] [--role-config <path>] [--worktree <path>] [--diff-against <other.json>] [--json]`

Replays a versioned trajectory at a declared determinism tier. The tier
is printed, and it is present in `--json` for every result. A tier never
silently downgrades: a tier that needs pins refuses with exit 2 when
they are missing.

`--session <id>` replays that session's own trajectory
(`<sessions-root>/<id>/trajectory.json`, written when a `kubic run` or
TUI turn settles). Giving both a file and `--session`, or a path-unsafe
id, exits 2 with one `error:` line.

| Invocation | Meaning |
| --- | --- |
| `kubic replay traj.json` | Recorded exact: log-only, never re-executes. Exits 0 and prints the tier. |
| `... --tier deterministic --model <provider/id> --lockfile <file>` | Re-executes the recorded objective through the solo lane at the pinned model. Refuses with exit 2 unless both pins are given. A pin that is not registered exits 6 (`provider_probe_failed`). |
| `... --tier live --role-config <file>` | Re-executes at the recorded model under the pinned role config. Refuses with exit 2 without the role config. `--model` and `--lockfile` are refused under live. |
| `... --diff-against other.json` | Recorded compare: names the variables that changed (`model`, `worktree`, `diff`). Any difference exits 1 as the regression signal; identical trajectories exit 0. |

- **Experimental worktree.** `--worktree <path>` is an experimental
  override for the re-execution tiers. In text mode it prints
  `warn: --worktree is experimental` on stderr; in `--json` it adds
  `experimental:["worktree"]`.
- **Recorded takes the trajectory alone.** Recorded with any of
  `--model`, `--lockfile`, `--role-config` or `--worktree` exits 2.
- **Errors.** A missing trajectory or an unknown `--tier` is a refusal:
  - with `--json`, a tiered envelope (`missing-trajectory` or
    `invalid-tier`)
  - without it, an `error: [<code>] …` line on stderr
- **Exit codes** are the §78 subset 0/1/2/5/6 (see
  [exit codes](exit-codes.md)).

The re-execution tiers read the effective config the same way
`kubic run` does (§35.1): the configured permission classes and journal
retention govern the re-executed lane, and so does the §58 enterprise
`[policy]` — a re-execution model outside `allowed_models`/
`allowed_providers` exits 6 with the named policy refusal before any
provider call, and the re-executed lane's tools are the same allow/deny
intersection. A refused config exits 1 with the config's named reason
instead of running on defaults.

The refusal check applies to the whole command, not to individual tiers.
A refused config also blocks the log-only tiers (`recorded` and
`compare`): the command exits 1 before any tier runs, so the config has
to be fixed first.

## `kubic export (--trajectory <file> | --session <id>) [--type sft|dpo|grpo|preference|tooluse|coding] [--against <other.json>] [--json]`

Inspects trajectory export files and exports RL dataset records from
them. `--session <id>` stands for `--trajectory
<sessions-root>/<id>/trajectory.json`, the file a settled `kubic run` or
TUI turn writes. Giving both, or a path-unsafe id, exits 2 with one
`error:` line.

- **Without `--type`**, the file is validated and described: schema,
  task, model, provenance, result and usage.
- **With `--type`**, a dataset record is built and validated:
  - `sft`, `tooluse` and `coding` read `--trajectory` alone
  - `dpo` and `preference` (chosen plus rejected) and `grpo` (a
    two-candidate group) also need `--against`

These invocations exit 2 with an `error:` line on stderr, and no file is
read:

- a missing `--trajectory` (and no `--session`)
- an unknown `--type`
- a pair or group type without `--against`
- `--against` on any other type

A pair ranks two answers to one prompt. A pair is excluded when:

- the two files answer a different prompt text or task id
  (`prompt-mismatch-excluded`, checked first)
- either side is an env failure (`env-failure-excluded`)
- the verifier does not prefer chosen over rejected
  (`no-preference-signal-excluded`)
- the runs cross a worktree or grant boundary (`cross-boundary-excluded`)

An excluded pair prints `excluded: <tag> — <reason>` and exits 0; it
never produces a training record. A DPO record carries both sides'
`taskRef`, and a hand-built record whose task refs differ fails
validation. `grpo` refuses with exit 2 when its candidates answer
different prompts or tasks. Stripped provenance or failure labels also
refuse with exit 2.

Text mode prints the canonical record JSON. `--json` wraps it in
`{ok, exitCode, type, record}`, or `{…, excluded}` for an excluded pair.
Failures are envelopes under `--json` and `error: [<code>] …` lines
otherwise. The exit code is:

- 0 when the record was exported or the file described
- 1 when the record failed to build or validate
- 2 on a usage error or refusal

## `kubic cost [--session <id>] [--json]`

Reads real usage out of the durable session store: one `AGENT / MODEL /
TOKENS / COST` row per usage bucket a session recorded — each
`provider/model`, and each tool that reported its own spend (labelled
`tool:<name>`) — followed by `task total $<sum> (<n> agents)`. The total is
exactly the sum of the rows.

The numbers are the session's `pi.usage` documents, summed per bucket, so
they match what `Harness.usage()` reports for the same run. Reading is
read-only and never boots a lane. A session whose storage a live run owns
is skipped, never opened (pi-durable: one process per storage), and
reported as a zero row with `MODEL` `(locked)`; a session that cannot be
read at all (a Pi 0.87 transcript, a half-written directory) is
`(unreadable)` the same way. A session the operator NAMED with `--session`
is never skipped that way: an unknown id, a live lock and a 0.87 transcript
each print their refusal and exit 1. Skip reporting, the lock-free read and the
session-dir mtime question are [#251](https://github.com/konic-labs/kubic/issues/251)'s.

When the sessions carry prefix-cache counters, the readout adds the
cache line and the transparent-caching note. With no sessions stored it
prints `no cost rows` and exits 0.

| Flag | Meaning |
| --- | --- |
| `--session <id>` | Reads only this session. Ids follow the same `[A-Za-z0-9_-]` rule as `run`: anything else exits 2 before the store is touched, and an unknown session exits 1 (`error: unknown session: <id>`). |
| `--json` | Prints the in-code `toCostJson` shape (`agents`, `taskTotal`) field-for-field. Exits 0. |

## `kubic perf --budget <kind> (--measure | --samples <csv>) [--json]`

Evaluates a perf budget against the §61 constants. Each run uses exactly
one sample source, `--measure` or `--samples`:

- **`--measure`** runs the real thing and times it:
  - `spawn` cycles a real `node -e` child through the worker spawn
    environment
  - `worktree` runs a real `git worktree add` / `remove` cycle in a
    scratch directory
  - `attach` and `teardown` have no live substrate in the solo path yet,
    so `--measure` on those kinds exits 2 with an `error:` line that
    names `--samples`

  This is the default measurement source (issue #98), implemented in
  `packages/host/src/ops/perf/measure.ts`; the composition root needs no
  wiring for it.
- **`--samples <ms,ms,…>`** is the documented fallback: millisecond
  samples you supply, with no clock consulted. The test suite uses it,
  and so does any environment where spawning a child process (or `git`)
  is unavailable or unwanted.

Text mode prints a `BUDGET / LIMIT / SAMPLES / P50 / P95 / STATUS` table.
The status is `within` or `BREACH`. Measured runs print a
`perf: <note>` provenance line before the table.

A breach adds the exact filed regression string
(`perf regression: <kind> p95=<p95>ms exceeds budget=<budget>ms …`)
after the table and exits 1. A pass exits 0. `--measure` and `--samples`
are mutually exclusive: passing both exits 2 instead of silently
picking one.

| Flag | Meaning |
| --- | --- |
| `--budget <worktree\|spawn\|attach\|teardown>` | **Required.** The budget to evaluate. Any other kind exits 2. |
| `--measure` | Measures for real. Only `spawn` and `worktree` have a live source; the other kinds exit 2 and name `--samples`. |
| `--samples <ms,ms,…>` | Fallback: comma-separated, non-negative millisecond samples. At least one is required: an empty or non-numeric list exits 2, so a run never passes vacuously. |
| `--json` | Prints the full evaluation (`kind`, `budgetMs`, `count`, `p50`, `p95`, `within`, `regression`, plus `source` and `note` for measured samples). Exits 0 on a pass, 1 on a breach. |

## `kubic policy --tool <name> [--json]`

Answers a policy query as a routing offer, never as enforcement. It
prints `allow <tool>` or `deny <tool>` for the tool policy that a run
from this directory actually installs: the same permission classes, from
the same config load, that `kubic run` enforces and that `kubic doctor`
reports on its `policy:installed` line.

Policy is deny-by-default: a tool outside the installed allowlist is
denied. Tool names match regardless of case and surrounding whitespace.

Unsupported levels are named, never silent (§40.2, issue #166): for each
installed permission level the tool set cannot express (network or
credentials `allowlist`, filesystem or git `full`) the command writes one
`warn: <class> '<level>' is unsupported — enforced as '<level>': <reason>`
line to stderr. `kubic doctor` names the same set on its
`policy:installed` line, which is then `WARN (unsupported-level)`.

| Flag | Meaning |
| --- | --- |
| `--tool <name>` | **Required.** The tool to query. A missing or whitespace-only name exits 2. |
| `--json` | Prints `{"tool", "decision"}` instead of the text line, plus `unsupported` (`[{class, level, enforcedAs, reason}]`) when any installed level is unsupported. Exits 0. |

## `kubic audit [--mode <m>] [--posture <p>] [--result <r>] [--json]`

Queries the audit trail, matching each supplied filter exactly.

**Output.** Text mode prints a table with the columns `WHEN`, `MODE`,
`POSTURE`, `RESULT`, `WHAT`, `PERMISSION`, `APPROVAL` and `REASON`.
With no matching records it prints `no audit records` and exits 0.
`--json` prints the full 14-field records. A ledger that exists but
cannot be read (permission denied, I/O error) is not an empty trail: the
command prints `error: cannot read the audit ledger <path>: …` on stderr
and exits 1. Only a missing ledger reads as empty.

**Redaction.** Every record is redacted before it is printed:
secret-shaped values and listed-secret inventory values become
`[redacted-secret]`, so credentials only ever appear as sentinels.

**Where records come from.** There is one §60 ledger per repository,
`<repo>/.kubic/orchestrator/approvals/audit.jsonl`, one record per line.
`<repo>` is the main checkout: from a subdirectory or from a linked
worktree, every writer and `kubic audit` resolve the same file (the
parent of git's common dir; outside git, the current directory). The
shipped runtime ignore rules cover this file.

- `kubic orchestrate` appends one record per approval decision:
  approved, denied, timed out, or a refused manager approve. The record
  has `--posture approvals` or `full-access`.
- `kubic run` and `kubic tui` append one `mode: solo` record per
  resolved solo approval ask, approved or denied, with `posture`
  `approvals` or `full-access`. A run from `<repo>/sub` writes the repo
  ledger, never `<repo>/sub/.kubic/`.
- A worker child of `kubic orchestrate` writes no record for an ask the
  manager answered (the manager's record is the one record). A decision
  the child makes on its own (a latched answer, the route,
  `autoApprove`, full access) is recorded once as `mode: orchestrator`
  for that worker in the main repo ledger, never inside its worktree, with
  the identity `kubic orchestrate` gave the child in its environment: the
  worker id (`KUBIC_WORKER_ID`), the orchestrating session as `parent`
  (`KUBIC_ORCHESTRATOR_SESSION`), and the `worker.generation` from
  `KUBIC_WORKER_GENERATION` (`0` for a solo run).
- The model on every solo record is the model the lane runs: `kubic run`
  reads it after the stored-model rule (`--session` without a pin keeps the
  session's own model, and both the record and `trajectory.json` say so).
- Enabling full access (`--dangerously-skip-approvals` on `kubic`, `tui`,
  `run`, `sessions create` or `orchestrate`) appends one
  `posture:full-access` row naming the session and the command. A
  `posture.json` change made during a session is refused and recorded
  once as `posture:changed-mid-session`.
- A failed ledger write never changes the decision.

| Flag | Meaning |
| --- | --- |
| `--mode <solo\|orchestrator>` | Filters on mode. Any other value exits 2. |
| `--posture <name>` | Filters on posture. |
| `--result <ok\|deny\|error>` | Filters on result. Any other value exits 2. |
| `--json` | Prints the matching records as a JSON array, with the same redaction. Exits 0. |

Back to the [docs index](../README.md). See also
[exit codes](exit-codes.md), [configuration](configuration.md), and
[doctor and debug](doctor-and-debug.md).
