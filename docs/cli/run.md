# Running a task: `kubic run`

> One prompt, headless: the lane runs it to the end and the command reports what
> happened. `kubic attach` and `kubic resume` reopen a session. Back to the
> [command index](commands.md).

## `kubic run [-p] <prompt> [--session <id>] [--timeout <ms>] [--max-turns <n>] [--role <name>] [--model <provider/id>] [--thinking <level>] [--skill <path>]... [--invoke-skill <name>] [--no-skills] [--tools <a,b,...>] [--no-tools] [--debug] [--autonomous] [--json] [--dangerously-skip-approvals] [--pre-approvals <file>]`

Non-interactive run: no alt-screen, no prompt, consumable output.

| Flag | Meaning |
| --- | --- |
| `-p`, `--prompt <text>` | The prompt to run. **Or pass it positionally** (`kubic run "fix the tests"`); exactly one of the two — `-p` together with a positional exits 2 naming both. The `-p` typo guard stays: a separate-token value that starts with `--` is a mistyped flag, so a prompt that really starts with `--` goes in the attached form (`--prompt=--text`), and a positional one after `--` (`kubic run -- --weird`). |
| `--session <id>` | Resume into an existing session. Ids accept only `[A-Za-z0-9_-]` — anything else exits 2 before any store is touched. **Model rule**: a resumed session runs its own stored lane model unless a model is *pinned* (`--model`, `KUBIC_MODEL` / `[model]`, a role's `[roles.<name>].model`, or `KUBIC_PROVIDER=faux`) — a pin that differs switches the session to it (`model: session model '<a>' switched to '<b>' (explicit selection)` on stderr, compaction reserve re-clamped to the new window); the unpinned default pick never switches it (`model: session keeps its own model '<a>' …`). The prompt metadata, the `--json` `model` field and the usage rows all name the model the lane actually runs. A stored model that is not registered fails closed with `provider_probe_failed` (exit 6): `session model '<a>' is unavailable: …` — pin a model to move the session. |
| `--timeout <ms>` | Wall-clock bound for the run's turn — settling the pending work plus the prompt's own run (positive integer ms, max `2147483647`). Default `300000` (5 minutes), or the config's `[run] timeoutMs` when it sets one; the flag wins over the config. A model that never settles is cut off and the run ends `timeout` with the ref triple intact — a wall-clock bound never claims the turn-limit status. When the bound fires mid-tool, the in-flight work is **aborted and killed, not abandoned**: the turn's context is cancelled, the run states a durable `conversation.abort()`, drains the kill registry (detached bash children die with their process groups), and only then runs the end-of-run reconciliation sweep — so a late write from orphaned work cannot land outside the journal. A provider that ignores cancellation cannot hang the run: the abort and the harness close are bounded, and the mapped result is reported either way. |
| `--max-turns <n>` | Optional turn bound (positive integer). A turn is one committed model response, counted from the lane's own usage events; durable provider retries the harness performs inside a turn are not turns. Exceeding the bound ends the run `turn_limit` (exit 3) with the same abort-and-drain path as `--timeout`. Unset means the config's `[run] maxTurns`, and with neither there is no turn bound — the wall clock is the only limit. |
| `--role <name>` | Boot as a role: the `.kubic/roles/<name>.md` document when the workspace has one, else `~/.kubic/roles/<name>.md`, else the preset of that name embedded in the binary. The document's prompt text, tool set and model pin apply either way. A project document loads only for a trusted project root (same gate as project skills): untrusted, `--role` naming it refuses with the trust message and `kubic doctor` warns what trust would unlock. The document may declare a `skills: [...]` list: only the named skills reach the role's prompt — merged with each skill's own `roles:` list, so both must admit. Skills outside the role, or needing tools the lane's classes deny, are withheld with reasons (debug log; `kubic doctor` warns each as `skill:<name>`) — never offered, never silently failing. The role's permission classes merge with the config's, most restrictive wins, and the role document (or a `[roles.<name>]` layer) may declare `requires: [...]` — tools that always require approval under the role. `kubic doctor` prints each role's effective classes under the run's config. Roles match by the declared `role:` name, not the filename: `review.md` declaring `role: reviewer` boots `--role reviewer` with review.md's own `## Prompt` body — the prompt is never re-read from `<name>.md`. Robustness: one malformed document never blocks the other roles — `--role` naming it refuses with that file's parse error, `kubic doctor` fails it as `role:<file-stem>`; two documents declaring the same `role:` name are refused by name everywhere (run refusal + doctor fail), both files listed, and neither copy wins. The name `default` is reserved: a run without `--role` records it as its role, so `--role default` is refused and a document declaring it is reported invalid. An unknown `--role` name lists the loaded roles and, on an untrusted root, the withheld document files (their declared names are never read). |
| `--model <provider/id>` | Session model override: the `cli` config layer, above `KUBIC_MODEL` and every file layer — and never above a frozen enterprise key, which still wins (one stderr note names the ignored flag or `KUBIC_MODEL` pin: `note: --model x ignored: model pinned by enterprise policy (corp/approved)`; stdout and a `--json` envelope are untouched). An unknown provider/model exits 6 with the id and the input that carried the pin named (`--model`, `KUBIC_MODEL`, `[model] in <layer> config`, `role model`), plus `; did you mean '<id>'?` when a registered provider or model is close; the flag is an input to the one config load, so `kubic config --model` reports the same selection. |
| `--thinking <level>` | Session thinking-level override: the `cli` config layer — `--thinking` beats `KUBIC_MODEL_THINKING`, which beats `[model].thinking`, and a frozen enterprise `model.thinking` beats the flag (refused by name: `--thinking <level> refused: model.thinking is frozen by the enterprise layer`; the env override is silently not applied). The lane resolves it against the session's stored level and the role default (`--thinking` > env > session > role > config) and clamps it to the effective model — a clamp is one stderr notice naming the model, the request and the level applied, never a silent rewrite. The applied level is committed to the session (a reattach keeps it) and recorded in `trajectory.json`. An unknown level exits 2 naming the levels that exist. |
| `--skill <path>` | Add one skill explicitly (repeatable; applies even under `--no-skills`). A directory, a `SKILL.md` file, or a bare name (discovery roots first — a top-level `<root>/<name>` in any root, then a nested skill directory of that name — then the cwd). Relative values resolve against the invoking cwd on both `run` and `tui` — never against the sessions root — and an unresolvable value warns (`skill skipped (unknown skill '…')`) without needing `--debug`: on stderr for `run`, as a transcript notice for `tui`. |
| `--invoke-skill <name>` | Invoke one booted skill by name (`run` only): its full content runs as the turn prompt — including skills hidden from the model — followed by `-p`/operand text as further instructions. An unknown name fails the run with `unknown skill '<name>'` (exit 1); a withheld skill (role gate, trust gate) resolves as unknown and fails the same way. |
| `--no-skills` | Turn layered skill discovery off. |
| `--autonomous` | Run to completion without stopping for input: the mode is recorded on the run's session (`autonomous`, else `interactive` — off by default, never assumed), a `run:start` row naming the mode lands in the audit ledger, and the result and `--json` envelope carry `mode` (the `status` already names the stop condition that ended the run). Combines freely with `--dangerously-skip-approvals` — the combination is legitimate for a batch run on a throwaway checkout, and the session plus the ledger name it. |
| `--debug` | Emit lane/tool span lines on **stderr** (`[span]`, `[tool]`, `[lane]` … — one line per span close, the same debug-class vocabulary as the interactive TUI debug channel), plus the run's diagnostics on the same channel (as `[session] …` lines when they carry no class of their own): `reconcile:` notices (including the overlap warning below), `skills:` reports and drain failures. A retry backoff and a compaction are named too: `[lane] retry attempt <n> after error: <message>` when the harness schedules a retry of a transient model error and `[lane] retry attempt <n> settled` when it lands, `[lane] compaction started (<reason>)` / `[lane] compaction finished (<reason>)` around an automatic or manual compaction — the wait is never silent. Off by default; stdout stays consumable. |
| `--dangerously-skip-approvals` | Full access for **this run's session only**: challenged calls run without an ask. It is recorded in the session's `posture.json` and as one `posture:full-access` row in the audit ledger (session id and command), never in config, and a `warning: full-access approvals skipped for session <id> …` line goes to stderr. Each challenged call the posture waives is recorded under its own capability (`trigger:<capability>`, posture `full-access`), one record per capability; an untriggered call is neither audited nor marked challenged. A later `kubic run --session <id>` on that session warns again on stderr. |
| `--pre-approvals <file>` | A signed pre-approval file: the capabilities, tools and command patterns this job may run without an ask, checked against `[approvals] preApprovalKey` before the run starts (`KUBIC_PRE_APPROVALS` names the file when the flag is absent). An unsigned, altered, expired or malformed file — or one with no key configured to check it — exits 2 before a session exists. Each call it grants is recorded as approved by `pre-approval:<job>`. See [Headless approvals](enterprise.md#headless-approvals). |
| `--tools <a,b,...>` | Narrow the run's tool set to these tools — comma-separated and repeatable (`--tools read,ls --tools grep`). The selection can only **narrow**: it is intersected with the permission classes, any `--role` set and the enterprise tool gate. An unknown name is refused by name; a tool the classes forbid (`--tools write` under `filesystem = "read"`) is refused with the reason — both exit 2 before any lane boots. |
| `--no-tools` | The empty tool set (a chat-only run). Mutually exclusive with `--tools` — both at once exits 2 naming both. |
| `--json` | Emit one JSON envelope (`ok`, `exitCode`, `sessionId`, `status`, `result`, `journal`/`usage`/`trajectory` refs — `usage` also carries the run's `input`, `output`, `cacheRead`, `cacheWrite`, `costUsd` and `toolCalls` once a session exists —, `model` — the `provider/id` the lane actually ran, present once a lane booted —, `approvals.posture` — `approvals` or `full-access` — once the lane is installed, `mode` — the mode the run resolved (`autonomous` with `--autonomous`, else `interactive`) —, optional `error`, and — on a classified failure — `failure: {code, remedy, strategy}`, the failure code with its retry remedy and strategy) instead of human lines. The envelope is deliberately **one compact line** (not pretty-printed), so a script can read it as the last stdout line. |

**Project instructions.** The trusted `AGENTS.md` files from the repository
root down to the cwd are appended to the prompt; a file that is cut at 32 KiB
or left out because its directory is untrusted is named on stderr
(`project instructions: … not loaded: …`). See
[Project instructions](configuration.md#project-instructions-agentsmd).

**Skill paths the `read` tool may open.** Every skill
advertised in the `<skills>` block names its absolute `<filePath>`. Paths
outside the workspace are normally re-rooted under it, so one narrow,
read-only exception applies to exactly the advertised skills that live
outside the cwd: user skills (`~/.pi/agent/skills`, `~/.agents/skills`),
trusted project skills (the cwd up to the repository top level — the cwd
alone outside a repository, and a user root is never relabelled `project`),
and explicit `--skill` paths. For a
`SKILL.md`, `read` may open anything inside that skill's own directory
(so the skill's relative references resolve); a flat skill file opens
only itself. Nothing else changes: `write`, `edit`, `ls`, `find` and
`grep` still re-root every outside path, any other outside `read` is
still re-rooted, and skills hidden from the model
(`disable-model-invocation`) open nothing. `kubic tui` applies the same
rule.

**Interrupts.** `SIGINT` (Ctrl-C), `SIGTERM` and `SIGHUP` during a run
are handled like the
wall-clock guard (a signal during boot, before the prompt is admitted,
cancels the boot — the lane never drives): the in-flight tool process groups are killed at once, the
turn is aborted durably (`conversation.abort()` plus the conversation-keyed
kill drain), the reconciliation sweep runs, the session is
closed, and the run prints its normal result with `status: cancelled`,
`run interrupted by <SIGNAL>` (exit 128+signo — 129 `SIGHUP`, 130
`SIGINT`, 143 `SIGTERM`; the same convention `kubic tui` uses).
A second signal while that cleanup
runs takes the default path and ends the process immediately.

Text output prints `result:`, `session:`, `journal:` (`journal:<id>`),
`usage:` (`usage:<id>`), `trajectory:` (the absolute path of the run's
trajectory file) on stdout (the labels are dimmed and the result coloured
on a colour terminal; plain text under a pipe or `NO_COLOR`); on failure an
`error:` line goes to stderr first. Exit code is the terminus map — see
[exit codes](exit-codes.md).

**On an interactive terminal** (stdout **and** stderr a colour
TTY, no `--json`) the run shows its progress instead of those lines. On
stderr: a heading (`■ kubic run · <role> · <provider/id> · <cwd>`, where
`<role>` is the `--role` name, cut to 20 columns, or `default`), the
notice as one line (`○ Kubic has no isolation — approvals + journal are the
controls · details: kubic doctor`, same opt-outs as the full block), a
spinner with the elapsed time while the model works, and one settled line
per tool call when it finishes (`✓ read  src/cart.js  0.0s`, `✕ bash  npm
test  exit 1  0.4s`, `✓ edit  src/cart.js  +1 −1  0.0s`). The answer then
lands on stdout, followed on stderr by a receipt (`✓ done 18.4s · 4 tools ·
1 file +1 −1 · ↑ 9.2k ↓ 640 tok · $0.031`, or `✕ failed … · <terminus>`)
and the next steps (`review kubic diff   revert kubic undo   continue kubic
resume <id>`). A redirected stdout (`kubic run … > out.txt`), a pipe, CI or
`--json` keeps the plain lines above byte for byte.

**Trajectories.** Every run that attached a session writes
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
- provenance: session, agent, pid, the workspace, and `provider/id` model
- the git base revision (`no-vcs` outside a git checkout) and branch
- the used tool environment (`toolSpawnEnv`, so no secrets)
- a result with a `failureCategory` on every non-completed status
- with `[verify]` configured, the gate labels (`signal:tests|build|
  lint|typecheck`, plus `signal:regression` against the base revision):
  see [gate verification](configuration.md#gate-verification-verify). The
  gate commands are shell from the config, run outside approvals: each one
  is announced on stderr as it starts and recorded as a `verify:<gate>`
  row in the audit ledger

The file is readable by `kubic replay <file>` (or `--session <id>`),
`kubic export --trajectory <file>` (or `--session <id>`) and
`kubic eval --trajectory "$(cat <file>)"`. A run that fails before any
session exists (an invalid `--session` id, a missing session) writes none,
and its ref stays `trajectory:<id>`. A trajectory that cannot be written is
reported on stderr and never changes the run's exit code.
`kubic tui` writes the same file after each settled turn. A warning about
that write (an unreadable audit ledger or journal) is a transcript notice
there, not a stderr line: the screen owns the terminal.

**Usage errors (exit 2, stderr, no lane).** commander parses the argv
(`apps/kubic/src/commands/session.ts`): a missing `-p`, a flag without its
value, an unknown option, an invalid `--session` id, a non-positive or
non-integer `--timeout`/`--max-turns` (or a `--timeout` above
`2147483647`), and a stray operand all exit 2 with one `error: …` line.

**A refused config** stops `kubic run` before any lane: one
`error: <reason>` line on stderr, exit 1. Under `--json` stdout carries the
same compact failure envelope every run emits (`ok:false`, `exitCode:1`,
`status:"failed"`, the reason in `error.message`) — never plain text — so a
scripted consumer always parses exactly one document; without `--json`
stdout stays empty. The same split holds for `kubic replay` (its own
envelope shape) and for the `loaded models.json: …` receipt, which is a
stderr diagnostic under both modes.

**Prompt values.** `-p <text>`, `--prompt <text>`, `--prompt=<text>`,
`-p<text>` and the positional form `kubic run "<prompt>"` all work; pass
exactly one — `-p` together with a positional exits 2 naming both, and two
positionals exit 2. The `-p` typo guard stays: a separate-token value that
starts with `--` is a mistyped flag, not a prompt — `kubic run -p --json`
exits 2 with `argument missing ("--json" looks like a flag …)` and the
exact attached form to use.
A prompt that really begins with `--` is written in the attached form or
after the `--` terminator:

```console
$ kubic run --prompt='--help'            # the value is everything after '='
$ kubic run --prompt='--json-experiment'
$ kubic run -- --weird prompt            # a positional after '--' is taken verbatim
```

A single-dash value (`-p '- fix the tests'`, a markdown bullet) is a
normal prompt. An empty prompt (`--prompt=`, `-p ''`, `kubic run ''`) is
refused (`the prompt is empty`).
`--help` anywhere after `run` is commander's help (exit 0); a literal
`--help` prompt needs the attached form (or `--`).

**Installed policy**. A run always boots the lane with a
permission policy, whether or not a config names one: the five permission
classes (`[permissions]` when configured, the documented defaults
otherwise — `filesystem = workspace-write`, `shell = true`,
`network = none`, `git = workspace`, `credentials = none`), the derived
tool allowlist (a tool outside it is refused at execute time, not merely
omitted), and the `destructive-guard` / `network-guard` / `confine-guard`
interceptors wired to an approval ask. `kubic doctor` prints this same
installed object as `policy:installed` — as a `WARN (unsupported-level)`
naming each level the tool set cannot express: network
`allowlist` is enforced as `none` (the network guard blocks and the
network trigger fires), credentials `allowlist` as `none` (a listed
credential path raises the credential trigger), filesystem
`full` as `workspace-write`, git `full` as `workspace`.

A destructive or network-raising call needs an approval. `kubic run` has
no TTY to ask on and no approval card (the card is the TUI's): unless an
`[approvals] broker` answers it or a `--pre-approvals` file grants it (see
[Headless approvals](enterprise.md#headless-approvals)), a
challenged call is **refused rather than executed**, and the run ends `approval_denied`
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

**Attaching a session with unfinished durable work**. A run
that died mid-turn (SIGKILL, OOM, power loss, orphan reaping) leaves its
turn placed but unsettled in the session, and an unsettled turn refuses every new
prompt. `kubic run --session X` therefore settles it first and names the
choice on stderr: when the pending run carries **this same prompt** (a
retried script) it is resumed *as* this run — never re-prompted
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
`packages/agent/src/lane/pending.ts` owns the format, so both surfaces
name the same work.

**Concurrent runs in one workspace**. A run drives one
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
**unattributed** journal entries (still `non-reversible` unless a pre-image
resolves — a git pre-image or an earlier attributed entry in the run). When the local session
store shows another session on the workspace, the run's debug channel
emits one `reconcile: another run may be live in this workspace …` line
naming the sibling ids, and `kubic doctor` reports the same overlap as the
`session:overlap` warn note ([doctor and debug](doctor-and-debug.md)).
Locking is local-filesystem only: no network/shared-disk (NFS/SMB) locking
semantics are provided or tested.

### Where the spans go

Lane and tool spans have two destinations:

1. **stderr, behind `--debug`** — each span close writes one
   `<label>: <name> …` line through the shared `DebugSink`. Silence (no
   `--debug`) is the default, which keeps stdout consumable and the run's
   exit contract untouched. (`kubic tui` has no `--debug` flag: its span
   closes go to the artifact below, and lane faults render as transcript
   notices — see the debug page.)
2. **the session artifact** — `run-spans.ts` also serializes the same
   spans to `spans.jsonl` under the session's own directory
   (`<sessions-root>/<session-id>/spans.jsonl`), one JSON object per
   closed span. The artifact is evidence, not a surface: nothing reads it
   back and no CLI command reports it yet (the aggregate is 's telemetry work). Every run surface writes the same file for its own
   session: `kubic run` writes the lane accept/drive steps plus one
   `pi.tool.execute` span per tool call; `kubic tui` appends
   one `kubic.agent.run` span per settled turn plus that turn's tool spans.

Both are additive: a run with no spans still exits exactly as before.

A fresh start announces its trust model before the first turn: three
`warning: Kubic runs in-process with your authority: no isolation …` lines on **stderr** (never stdout —
`--json` stays one parseable envelope). Suppressed by the opt-out
`KUBIC_NO_NOTICE=1`. A `--session` resume still announces it: the rule is
per process start, not per session. On an interactive terminal the three lines become one compact line under the run heading,
under the same suppression rules. `kubic tui` shows the same statement
as the first screen's isolation row (and the full text on `/safety`),
and the re-execution tiers of
`kubic replay` announce it too (they drive this same run path).

### Testing provider: `KUBIC_PROVIDER=faux`

**For testing only.** `KUBIC_PROVIDER=faux` swaps every model call for
Pi's faux provider with a scripted reply, so the shipped binary can be
driven end to end — `run` and `tui` — with no network, no credentials and
no paid tokens. Everything else is real: the lane, the tools, the installed
policy, the session store and the journal.

- **Never implicit.** Only the exact value `faux` turns it on. Unset or
  empty means no override; any other value is refused by name — `run`
  ends `provider_probe_failed` (exit 6) and `tui` exits 6 before the screen
  opens, both with
  `unsupported KUBIC_PROVIDER "<value>" (the only override is 'faux', the testing provider)`.
- **Always announced.** `run` prints
  `warn: provider: faux/echo (testing provider: scripted replies, no model is called; KUBIC_PROVIDER=faux)`
  on stderr before the first turn (stdout and `--json` stay clean); the
  TUI's first screen reads `◆ provider  faux/echo  testing provider, no model is called`;
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

`npm run test:binary` runs `scripts/faux-smoke.mjs` against the
built binary: a faux `run --json` (echo and a tool call), text mode, the
unknown-value refusal, and the built-in benchmark suites.

## `kubic attach <id>` / `kubic resume <id>`

The reattach aliases: both boot the interactive TUI on an
existing session — `kubic attach my-session` and `kubic resume my-session`
are `kubic tui --session my-session` with the same boot, model rule and
exit codes (a missing session or one another process holds live exits **5**
before the alt-screen). The id follows the `[A-Za-z0-9_-]` rule (anything
else exits 2). The full flag surface (`--role`, `--model`,
`--dangerously-skip-approvals`, …) stays on `kubic tui`.
