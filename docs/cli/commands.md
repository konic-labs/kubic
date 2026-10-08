# CLI commands

> `apps/kubic/src/main.ts` is the composition root.
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
--session --json` is a missing value
(`option '…' argument missing`, exit 2, nothing runs). A value that really
starts with `--` goes in the attached form (`--session=…`, `-p--…`).

The **root dispatcher** follows the same convention:
`kubic --help` / `kubic -h` prints the grouped root help below and exits 0.
On an interactive colour terminal the same text is coloured (brand, muted
labels, command names); piped, redirected or under `NO_COLOR` it is plain. A **bare `kubic`** (no command) on
an interactive terminal (stdin and stdout both a TTY) opens the TUI, exactly
as `kubic tui`. Off a TTY (a pipe, CI, a script) it prints the *identical*
listing and exits 1: usage-on-no-args is the deliberate POSIX posture, so
only the exit code differs between the two paths.
`scripts/binary-contract.mjs` pins both exits and the plain text itself, so
the dispatcher and its help cannot drift apart. The command groups are also
the dispatcher's routing table (`apps/kubic/src/cli/root-help.ts`), so a
command cannot ship without a place in the help.

```text
■ kubic — terminal coding agent by Konic

USAGE      kubic                       open the TUI (on a terminal)
           kubic "<prompt>"            run one prompt, like kubic run -p
           kubic <command> [options]

SESSION    run · tui · resume · attach · sessions                work with the agent
CHANGES    diff · undo · log · status · commit · git · journal   review and revert what it did
SETUP      setup · models · config · trust · doctor · skills     providers, project, health
ANALYSIS   cost · eval · benchmark · replay · export · policy · audit

EXAMPLES   kubic "fix the failing test"
           kubic run -p "add tests for titleCase" --json
           kubic diff && kubic undo

kubic <command> --help for options · docs/cli/README.md
```

A command's own help keeps commander's layout (`Usage: kubic <command>
[options]`, then `Arguments:` and `Options:`); on a colour terminal the
titles and option terms are styled, and the text is otherwise unchanged. `kubic --version` exits 0.

**Every command's own `--help`/`-h` is side-effect free**:
commander answers it before the action runs, so `kubic run|tui --help`
prints that command's usage and exits 0 without booting a lane or writing
the runtime exclude rules.

Build first (`npm run build`), then invoke `./bin/kubic.js` (or
`npm run kubic -- …`); anything else dispatches below; an unknown command
is a usage error (exit **2**) reported on stderr:
`error: unknown command '<name>'`, then `hint: did you mean kubic
<command>?` for a near miss or `hint: to run it as a prompt: kubic run -p
'<word>'` for any other word, then `hint: kubic --help lists the commands`
(an error block on a colour terminal; see [exit codes](exit-codes.md)),
while the bare invocation keeps the POSIX usage-on-no-args posture: the
root help, exit 1.

**The headline prompt form**: a single argv token that
contains whitespace is a prompt — `kubic "fix the authentication bug"` is
exactly `kubic run -p "fix the authentication bug"`, headless
(no alt-screen). Trailing flags pass
through (`kubic "do x" --json`). A **single-word** token has no whitespace
to tell it from a typo'd command, so it stays an unknown command (exit 2)
with the hint above. Kubic runs in-process with your user authority: no
isolation, no containment — approvals plus the journal are the controls.

## `kubic run [-p] <prompt> [--session <id>] [--timeout <ms>] [--max-turns <n>] [--role <name>] [--model <provider/id>] [--thinking <level>] [--skill <path>]... [--invoke-skill <name>] [--no-skills] [--tools <a,b,...>] [--no-tools] [--debug] [--autonomous] [--json] [--dangerously-skip-approvals]`

Non-interactive solo run: no alt-screen, no prompt, consumable output.

| Flag | Meaning |
| --- | --- |
| `-p`, `--prompt <text>` | The prompt to run. **Or pass it positionally** (`kubic run "fix the tests"`); exactly one of the two — `-p` together with a positional exits 2 naming both. The `-p` typo guard stays: a separate-token value that starts with `--` is a mistyped flag, so a prompt that really starts with `--` goes in the attached form (`--prompt=--text`), and a positional one after `--` (`kubic run -- --weird`). |
| `--session <id>` | Resume into an existing session. Ids accept only `[A-Za-z0-9_-]` — anything else exits 2 before any store is touched. **Model rule**: a resumed session runs its own stored lane model unless a model is *pinned* (`--model`, `KUBIC_MODEL` / `[model]`, a role's `[roles.<name>].model`, or `KUBIC_PROVIDER=faux`) — a pin that differs switches the session to it (`model: session model '<a>' switched to '<b>' (explicit selection)` on stderr, compaction reserve re-clamped to the new window); the unpinned default pick never switches it (`model: session keeps its own model '<a>' …`). The prompt metadata, the `--json` `model` field and the usage rows all name the model the lane actually runs. A stored model that is not registered fails closed with `provider_probe_failed` (exit 6): `session model '<a>' is unavailable: …` — pin a model to move the session. |
| `--timeout <ms>` | Wall-clock bound for the run's turn — settling the pending work plus the prompt's own run (positive integer ms, max `2147483647`). Default `300000` (5 minutes). A model that never settles is cut off and the run ends `timeout` with the ref triple intact — a wall-clock bound never claims the turn-limit status. When the bound fires mid-tool, the in-flight work is **aborted and killed, not abandoned**: the turn's context is cancelled, the run states a durable `conversation.abort()`, drains the kill registry (detached bash children die with their process groups), and only then runs the end-of-run reconciliation sweep — so a late write from orphaned work cannot land outside the journal. A provider that ignores cancellation cannot hang the run: the abort and the harness close are bounded, and the mapped result is reported either way. |
| `--max-turns <n>` | Optional turn bound (positive integer). A turn is one committed model response, counted from the lane's own usage events; durable provider retries the harness performs inside a turn are not turns. Exceeding the bound ends the run `turn_limit` (exit 3) with the same abort-and-drain path as `--timeout`. Unset means no turn bound — the wall clock is the only limit. |
| `--role <name>` | Boot as a role: the `.kubic/roles/<name>.md` document when the workspace has one, else `~/.kubic/roles/<name>.md`, else the preset of that name embedded in the binary. The document's prompt text, tool set and model pin apply either way. A project document loads only for a trusted project root (same gate as project skills): untrusted, `--role` naming it refuses with the trust message and `kubic doctor` warns what trust would unlock. The document may declare a `skills: [...]` list: only the named skills reach the role's prompt — merged with each skill's own `roles:` list, so both must admit. Skills outside the role, or needing tools the lane's classes deny, are withheld with reasons (debug log; `kubic doctor` warns each as `skill:<name>`) — never offered, never silently failing. The role's permission classes merge with the config's, most restrictive wins, and the role document (or a `[roles.<name>]` layer) may declare `requires: [...]` — tools that always require approval under the role. `kubic doctor` prints each role's effective classes under the run's config. Roles match by the declared `role:` name, not the filename: `review.md` declaring `role: reviewer` boots `--role reviewer` with review.md's own `## Prompt` body — the prompt is never re-read from `<name>.md`. Robustness: one malformed document never blocks the other roles — `--role` naming it refuses with that file's parse error, `kubic doctor` fails it as `role:<file-stem>`; two documents declaring the same `role:` name are refused by name everywhere (run refusal + doctor fail), both files listed, and neither copy wins. |
| `--model <provider/id>` | Session model override: the `cli` config layer, above `KUBIC_MODEL` and every file layer — and never above a frozen enterprise key, which still wins (one stderr note names the ignored flag or `KUBIC_MODEL` pin: `note: --model x ignored: model pinned by enterprise policy (corp/approved)`; stdout and a `--json` envelope are untouched). An unknown provider/model exits 6 with the id and the input that carried the pin named (`--model`, `KUBIC_MODEL`, `[model] in <layer> config`, `role model`), plus `; did you mean '<id>'?` when a registered provider or model is close; the flag is an input to the one config load, so `kubic config --model` reports the same selection. |
| `--thinking <level>` | Session thinking-level override: the `cli` config layer — `--thinking` beats `KUBIC_MODEL_THINKING`, which beats `[model].thinking`, and a frozen enterprise `model.thinking` beats the flag (refused by name: `--thinking <level> refused: model.thinking is frozen by the enterprise layer`; the env override is silently not applied). The lane resolves it against the session's stored level and the role default (`--thinking` > env > session > role > config) and clamps it to the effective model — a clamp is one stderr notice naming the model, the request and the level applied, never a silent rewrite. The applied level is committed to the session (a reattach keeps it) and recorded in `trajectory.json`. An unknown level exits 2 naming the levels that exist. |
| `--skill <path>` | Add one skill explicitly (repeatable; applies even under `--no-skills`). A directory, a `SKILL.md` file, or a bare name (discovery roots first, then the cwd). Relative values resolve against the invoking cwd on both `run` and `tui` — never against the sessions root — and an unresolvable value warns (`skill skipped (unknown skill '…')`) without needing `--debug`: on stderr for `run`, as a transcript notice for `tui`. |
| `--invoke-skill <name>` | Invoke one booted skill by name (`run` only): its full content runs as the turn prompt — including skills hidden from the model — followed by `-p`/operand text as further instructions. An unknown name fails the run with `unknown skill '<name>'` (exit 1); a withheld skill (role gate, trust gate) resolves as unknown and fails the same way. |
| `--no-skills` | Turn layered skill discovery off. |
| `--autonomous` | Run to completion without stopping for input: the mode is recorded on the run's session (`autonomous`, else `interactive` — off by default, never assumed), a `run:start` row naming the mode lands in the audit ledger, and the result and `--json` envelope carry `mode` (the `status` already names the stop condition that ended the run). Combines freely with `--dangerously-skip-approvals` — the combination is legitimate for a batch run on a throwaway checkout, and the session plus the ledger name it. |
| `--debug` | Emit lane/tool span lines on **stderr** (`[span]`, `[tool]`, `[lane]` … — one line per span close, the same debug-class vocabulary as the interactive TUI debug channel), plus the run's diagnostics on the same channel (as `[session] …` lines when they carry no class of their own): `reconcile:` notices (including the overlap warning below), `skills:` reports and drain failures. A retry backoff and a compaction are named too: `[lane] retry attempt <n> after error: <message>` when the harness schedules a retry of a transient model error and `[lane] retry attempt <n> settled` when it lands, `[lane] compaction started (<reason>)` / `[lane] compaction finished (<reason>)` around an automatic or manual compaction — the wait is never silent. Off by default; stdout stays consumable. |
| `--dangerously-skip-approvals` | Full access for **this run's session only**: challenged calls run without an ask. It is recorded in the session's `posture.json` and as one `posture:full-access` row in the audit ledger (session id and command), never in config, and a `warning: full-access approvals skipped for session <id> …` line goes to stderr. Each challenged call the posture waives is recorded under its own capability (`trigger:<capability>`, posture `full-access`), one record per capability; an untriggered call is neither audited nor marked challenged. A later `kubic run --session <id>` on that session warns again on stderr. |
| `--tools <a,b,...>` | Narrow the run's tool set to these tools — comma-separated and repeatable (`--tools read,ls --tools grep`). The selection can only **narrow**: it is intersected with the permission classes, any `--role` set and the enterprise tool gate. An unknown name is refused by name; a tool the classes forbid (`--tools write` under `filesystem = "read"`) is refused with the reason — both exit 2 before any lane boots. |
| `--no-tools` | The empty tool set (a chat-only run). Mutually exclusive with `--tools` — both at once exits 2 naming both. |
| `--json` | Emit one JSON envelope (`ok`, `exitCode`, `sessionId`, `status`, `result`, `journal`/`usage`/`trajectory` refs — `usage` also carries the run's `input`, `output`, `cacheRead`, `cacheWrite`, `costUsd` and `toolCalls` once a session exists —, `model` — the `provider/id` the lane actually ran, present once a lane booted —, `approvals.posture` — `approvals` or `full-access` — once the lane is installed, `mode` — the mode the run resolved (`autonomous` with `--autonomous`, else `interactive`) —, optional `error`, and — on a classified failure — `failure: {code, remedy, strategy}`, the failure code with its retry remedy and strategy) instead of human lines. The envelope is deliberately **one compact line** (not pretty-printed), so a script can read it as the last stdout line. |

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
stderr: a heading (`■ kubic run · solo · <provider/id> · <cwd>`), the solo
notice as one line (`○ solo has no isolation — approvals + journal are the
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
  see [gate verification](configuration.md#gate-verification-verify)

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
(`apps/kubic/src/commands/solo.ts`): a missing `-p`, a flag without its
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
classes (`[permissions]` when configured, the documented solo defaults
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
no TTY to ask on and no approval card (the card is the TUI's), so a
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
`packages/worker/src/lane/pending.ts` owns the format, so both surfaces
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

A fresh solo start announces its trust model before the first turn: three
`warning: solo mode has no isolation …` lines on **stderr** (never stdout —
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
  ends `provider_probe_failed` (exit 6) with
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

`npm run test:binary-contract` runs `scripts/faux-smoke.mjs` against the
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

## `kubic tui [--session <id>] [--role <name>] [--model <provider/id>] [--thinking <level>] [--skill <path>]... [--no-skills] [--tools <a,b,...>] [--no-tools] [--dangerously-skip-approvals]`

Interactive TUI: the alt-screen over the agent lane. Tree,
transcript, and status rows render in root order, with the prompt editor
on the bottom row. Below 80 columns the tree hides and transcript plus
status stay. `--session <id>` resumes into an existing session (same
`[A-Za-z0-9_-]` rule as `run` — anything else exits 2 before the lane
boots). Usage errors (unknown option, missing value, any operand) exit 2
on stderr before the screen opens. A `--tools`/`--no-tools` selection follows the same rule: an unknown name or one the
permission classes forbid is refused with the reason before the
alt-screen (exit 2), `--no-tools` is the empty set, and the two are
mutually exclusive. Lane boot failure exits 5 on a missing
session, 6 with no provider available, 1 otherwise, each with one
`error: …` line on stderr (never stdout) before the screen opens. The
`--session` model rule is the same as `kubic run`'s, and it adds the same pins:
`--model <provider/id>`, `KUBIC_MODEL`,
`[model]`, a role's `[roles.<name>].model`, or `KUBIC_PROVIDER=faux` —
the status bar and usage rows name the model the lane actually runs, and a
kept or switched model is named in the first footer. `--thinking <level>` boots the lane at that level under the same rule as `kubic run` (resolved against the session record and the role default, clamped to the model with a named notice); the status bar seeds from the committed level. In the loop,
`/model <provider/id>` switches the live lane: the id is resolved against
the catalogue, committed to the session as a config update, and the
first screen's provider row and the status line both move to it; `/model`
alone opens the model picker, and an unknown or malformed id is refused in
the footer while the lane keeps the model it had. `/scoped-models`
reports the role's resolved allowed set — the entries
the boot selected against, with any per-entry thinking — or that the role
(or a roleless lane) is unconstrained. `/escalate <provider/id> [reason]`
climbs the configured escalation ladder one rung with
the reason recorded — `/model <provider/id>` climbs the same ladder
silently; off-ladder targets, down-steps and exhausted budgets are refused
in the footer with the live model untouched. Three consecutive tool-failure
turns climb one rung automatically, once per run. Every climb appends an
`escalation: <from> → <to> (<reason>)` transcript row and lands on the
trajectory's `model.escalations`. Under an enterprise
`[policy]` the switch passes the same model/provider gate the boot
does: a model outside `allowed_models`/`allowed_providers` is refused in the
footer with the boot's named refusal and the lane keeps its model. A frozen
enterprise `[model]` binds the switch too (`/model` is the same
session override as `--model`): a switch to any other model is refused with
`model '<ref>' refused: the model is pinned by enterprise policy (<pin>);
/model cannot change it`, and naming the pin itself passes. `--model`
is the `cli` layer of the one config load (never patched over the projected
pin), so a frozen enterprise `[model]` beats it — announced by one stderr
note at boot — exactly as it does for `kubic run`. A session left with pending work
by a crashed run has it durably aborted at boot — its
approvals would need the approval card, which is not on screen yet, and the
operator is present to re-send — and the notice row names the outcome
(`pending work: <kind> <id> (<status>) aborted after an
interrupted run`) from the first render, together with the prompt the dead
process had already admitted (`— interrupted prompt: <text>`) when there
was one.

**Explicit skill invocation.** `/skill:<name> [instructions]` expands the booted skill of that name into the submitted turn — its full content followed by the instructions — including skills hidden from the model (`disableModelInvocation`); the hidden skill stays out of the system prompt either way. An unknown name (including a withheld one: role gate, trust gate) is refused in the footer (`skill: unknown skill '<name>'`) and nothing is sent. The colon form only: a bare `/skill` reports the usage (`usage: /skill:<name> [instructions]`). Per-skill rows complete in the editor but never join `/help` or the palette.

**Prompt images.** `/image <path>` attaches one image
to the next submitted prompt — `png`, `jpeg`, `webp` or `gif`, up to 5 MB,
checked by magic bytes rather than the file name, and the footer names the
file and its size (`image attached: screenshot.png 120 KB — Enter sends it`).
Enter with no text sends the attachment on its own (the image is the
prompt), and a non-regular file (a FIFO, a device node) is refused unopened
rather than read.
A terminal that pastes an image inline (iTerm2's `OSC 1337 File=` sequence,
reassembled when the pty splits a large payload across reads; other
terminals have no inline-image paste, so `/image <path>` is the way in)
attaches it the same way. The attachment is refused — with the reason in the
footer and nothing sent — when the file is missing, is not one of those four
formats, is over the cap, or when the live model's own input modalities do
not include images (a `/model` switch to a text-only model drops the
pending attachments and says so). An attached image travels as Pi's own
user-message image content part, so the session stores it and a resumed
session replays it; on a terminal with a kitty or iTerm2 image protocol the
transcript draws the image itself, and everywhere else it renders one
placeholder row. The row names the file and its size while the prompt is
pending (`[image: screenshot.png 120 KB]`); the committed entry stores the
MIME type and the bytes, not the name, so a resumed session shows
`[image: image/png 120 KB]`.

The TUI drives the same lane as `kubic run`, so it installs the same
policy (see **Installed policy** under `kubic run` above): the classes,
the derived allowlist, and the destructive/network/confine guards with the
approval ask. Each decision lands in the ledger with the session id
and the model the lane runs **when the ask resolves** (`provider/id`) —
after the stored-model rule of a `--session` resume and after any `/model`
switch, never the pre-boot pick — the same audit identity the headless
runner records. A challenged call surfaces the approval card — the
interactive path can actually collect a verdict on it — and an unanswered
ask denies on the same bounded wait. That bound also **withdraws the
question**: when it elapses the card for exactly that ask
closes, the next queued ask takes the screen, and a decision pressed later
settles the next ask — never the one nobody is waiting for.

**Full access.** `kubic tui --dangerously-skip-approvals`
— and the bare `kubic --dangerously-skip-approvals` on a terminal — enables
full access for the session it opens or resumes, through the same path as
`kubic run`: `posture.json`, one `posture:full-access` audit row, and a
`warning:` line on stderr before the screen opens. A lane that `/new` or
`/resume` boots in full access names its notice as a transcript row, since the
screen is already up. In the session itself the
same posture can be toggled with `Alt+A` or `/approvals on|off`:
`Alt+A` flips whichever way the session is currently in, while `on`/`off`
name a direction and only report when it is already in force; enabling asks
for confirmation first, disabling is immediate, and both write
the same posture file and audit rows — the installed policy reads the change
live, so the very next challenged call follows it, and the indicator moves in
the same frame. The header shows `approvals OFF (full-access)` from the
first frame. Off a
terminal the bare form prints the root help and exits 1, like bare
`kubic`. The flag is never written to config.

**The posture is decided at boot.** `kubic run` and
`kubic tui` read the session's full-access posture once, when the lane
boots, from what the flag or `kubic sessions create
--dangerously-skip-approvals` recorded. `posture.json` is never re-read to
decide an ask: a change written during the session (for example by a tool
call) is ignored, the file is restored to the boot posture before the next
ask and at session close, and one `posture:changed-mid-session` row
(`result deny`) is appended to the audit ledger. Every decision row carries
the posture decided at boot.

**Parity with `kubic run`.** The interactive lane carries the
same context the headless one does:

- **Skills:** discovery runs at boot with the same trust gate
  (`KUBIC_TRUST_PROJECT`), so discovered `<skills>` blocks land on the
  interactive system prompt. `--skill <path>` adds an explicit skill
  (repeatable), `--no-skills` turns layered discovery off — and explicit
  `--skill` paths still apply under `--no-skills`, exactly as `run`.
  Relative paths resolve against the invoking cwd, and an
  unresolvable value is a `warning:` line in the transcript: the screen owns
  stderr.
- **Roles:** `--role <name>` loads `.kubic/roles/<name>.md` — else `~/.kubic/roles/<name>.md` — or the
  matching preset embedded in the binary when neither has such a
  document (the five presets ship with `kubic`, and a repo document of the same name replaces its preset) — the document's prompt text replaces the solo
  constant and its tool set narrows the lane (absence, not approval). Every refusal is fail-closed
  with the named reason (unknown role, contradictory document, missing `## Prompt`, parse failure, untrusted project root); the boot exits before the alt-screen.
- **Journal retention:** the session journal takes the same
  `[journal] retentionDays` projection `run` threads — a TUI session's
  journal age-prunes under config.
- **Model selection:** the same precedence as `run` — an explicit
  pin (`--model <provider/id>`, else `[model]` in config or
  `KUBIC_MODEL`), then the `--role` layer's `[roles.<name>].model`, then
  the first registered model. The first screen and the status line name the
  model the lane actually runs on. An unknown or unavailable pinned model exits
  6 with the named reason before the alt-screen opens. With no pin and no
  provider key at all, the first screen's no-key block is printed to stderr
  instead — `✕ provider  no model provider has a key`, the `export …` lines to
  set one, the local-model and `KUBIC_PROVIDER=faux` alternatives — and the
  exit is 6 (`provider_probe_failed`); no alt screen is entered, so the lines
  stay in the scrollback. A bare `kubic
  --model <provider/id>` on a terminal is `kubic tui --model …`.
- **Agent id and role layers:** `[agent].name` names the lane
  (journal and reconciliation attribution, the id `kubic diff` reports
  for TUI changes) and `[roles.<name>].tools` layers under the role
  document on `--role`, exactly as `run`.
- **Audit identity:** every approval the TUI resolves writes its
  ledger record with the session id and the `provider/id` model the lane
  runs at that moment: the model a resumed session kept (the unpinned default pick never applies) and the one a `/model` switch
  moved it to. The policy is installed before the lane boots,
  so the model is read when each record is written, not frozen at install.
- **Runtime exclude rules:** `kubic tui` ships the same `.kubic/`
  exclude rules before creating state, so a session whose config ever
  relocates state in-repo leaves `git status` clean.

The loop is real: type a prompt, press `Enter` to submit, and the lane
drives it with events streaming into the views — the assistant's
answer appears as it is generated (a plain draft, replaced by the
markdown-rendered committed entry when the message lands), tool calls appear
in the tree, the transcript grows with the committed conversation, and the
status bar fills with usage rows. A resumed session (`--session <id>`)
starts from its committed spend: the status bar is seeded from the
session's `pi.usage` ledger before the first frame, and the tree's root row
picks the same ledger up when the lane attaches on the first turn — so
`$0.00` means an unspent session, never a lost one. While a turn runs the editor disables
submit; `Ctrl-C` cancels the in-flight turn and keeps the session alive,
and a second `Ctrl-C` (or `Ctrl-C` while idle) quits.

**Journal panels and `bash`.** A change made with the file tools reaches
the journal (and both panels) as its tool call ends. A change made with
`bash` is not intercepted, so it is journaled by the reconciliation sweep —
which, in the TUI, runs when a turn that used `bash` **settles** (before the
panels refresh), not only at quit: after such a turn `Ctrl-R` lists the
change as `unattributed` (plus `non-reversible` when no pre-image exists —
a bash edit of a committed file carries its git pre-image and undoes) and
`Ctrl-O` follows it. The sweep
walks and hashes the workspace, so turns that ran no `bash` do not pay for
it; it is safe to repeat (an unchanged tree appends nothing). The cost is
real: the sweep is a synchronous walk-and-hash of the whole workspace on the
terminal's thread — about 60 ms for ~700 files, linear in workspace size — so
a large workspace pays it (and the screen pauses) after every turn that used
`bash`.

**Screen layout.** Three one-row surfaces frame the transcript (``). Top to bottom:

- **The header** (one row): `■ KUBIC │ <project>  ⎇ <branch> ●<changed files>`
  on the left and `session <title> │ approvals on │ HH:MM` on the right.
  The project is the repository's top-level directory (or the working
  directory outside a repository, where the branch part is left out); the
  branch and the changed-file count are read with
  `git --no-optional-locks status` when the screen opens and after every
  settled turn, so the read never takes the index lock a tool's own git may
  need. The session title is the session's first prompt cut to 24 cells, or
  the short session id (`01a1…b6b8`) until there is one. The posture reads
  `approvals on`, or
  `approvals OFF (full-access)` in the error colour when the session's
  installed policy auto-approves every challenged call — read from that
  policy, at boot and after every turn, never assumed. As the terminal
  narrows the parts drop right to left — clock, session, approvals, branch —
  and the project name is cut last; the brand never drops, and neither does
  `approvals OFF`. The clock checks its minute every 30 s
  and repaints only when it changed.
- **The agent tree**, sized to its content (at most 6 rows). It starts
  hidden — `Ctrl-T` opens and closes it. Below 80 columns it is hidden
  either way. The tree's root row carries the run glyph plus the
  session's `$cost in/out` tokens (`● solo $0.02 2.0k/1.0k`) — seeded from
  the session's usage ledger when the TUI attaches, then summed from each
  response; each tool row shows the glyph, the tool name, a one-line summary
  of its key argument (the `bash` command, the `read`/`edit` path), the
  duration and a short outcome (a detected test summary like `17 passed`, or
  a non-zero exit code) — a failed call renders `✗` in the error colour,
  never `✓`. Calls are grouped per turn: a new turn starts a new group, and
  earlier turns fold into one `… N earlier calls in M turns` line above the
  live turn (calls beyond the row cap fold into `… N earlier calls`).
- **The transcript**, which follows the end as the turn streams, as blocks
  (``). Your prompt is a full-width block
  with a red `▌` edge and `you · HH:MM:SS` on the right (it shows the moment
  you submit, before the lane commits it); assistant prose renders as
  markdown behind a `◆` mark: bold headings, inline code on a
  raised surface, `•` bullets, quotes behind a `│`, and fenced code in a
  `┌ ts` / `└` frame with syntax highlighting (highlight.js grammars via
  `lowlight`, loaded when the TUI starts; a block over 2,000 lines or
  200 KB, or in an unknown language, stays plain). A path to a file in the
  project — `src/cart.js:10`, in prose or inline code — becomes a clickable
  `file://` link on terminals that support OSC 8 hyperlinks (elsewhere it
  stays text). Each tool call is one card: a header with its
  state (`●` green done, red failed; the accent spinner and
  `running · 3.00s` while it runs; `◆ … waiting for approval` while an
  approval holds it), the tool name, its target (the command or path) and,
  on the right, the outcome (`✓ exit 0` / `✕ exit 1`, `truncated` when the
  output was clipped) and the duration; then up to five body lines behind a
  `│` gutter — for a failure the error lines first, for a test run its tally
  (`tests 4 · pass 3 · fail 1`) — and a `└ +35 lines   ^X expand` footer.
  The shell record's `[bash exit …]` head, its `--- stdout ---` /
  `--- stderr ---` markers and the exec layer's
  `[kubic: N leading chars dropped …]` notice never show: stderr lines follow
  stdout, and an expanded card's footer names the full-output file. A
  successful workspace read (`read`, `ls`, `find`, `grep`, `git_status`,
  `git_log`, `git_show`, `git_diff`) folds to one line
  (`○ read  src/cart.js … 32 lines · 3ms`); a failed one is a full card.
  An `edit` card shows `+A −R` and the change inline: line
  numbers, removed lines on a red surface with `−`, added lines on a green
  one with `+`, the changed words highlighted, `⋮` for skipped lines —
  twelve rows collapsed (`└ +N more lines   ^X expand`). A `write` that
  creates a file shows `new file +N` and its first eight lines; one that
  replaces a text file shows the diff. The diff rides the tool result's
  details, so the model never pays for it; a session recorded before it
  shows the op's own count instead (`✓ 2 replacements`).
  The model's reasoning shows as one line, `⋯ thought for 4.1s — <its first
  sentence>` (the time is the response's generation time, measured for turns that arrive while the TUI watches — a resumed session's older reasoning reads `⋯ thinking — …`); `Ctrl-X` shows all of
  it. Every settled solo turn ends with a receipt:
  `✓ turn 18.4s · 4 tools · 1 file +1 −1 · $0.031` with
  `^O review diff   /undo revert` when it changed files (counted from the
  journal rows the turn recorded), or `✕ turn failed · 2.1s · <reason>` /
  `○ turn cancelled · 0.8s`. Receipts are drawn by this TUI process only —
  they are not written to the session.
  `Ctrl-X` expands every card and wraps its lines in full. A context
  compaction is a `─── compacted · auto ───` rule with the summary under it,
  collapsed the same way.
- **Block mode**: `Esc` on an idle, empty
  editor walks the transcript by blocks — each prompt, answer, thinking,
  tool card and turn receipt. The last block is selected first and shows an
  accent `▌` edge on every row; the transcript scrolls to keep it in view.
  `↑`/`↓` or `k`/`j` move a block, `g`/`G` jump to the first/last; `y`
  copies the block (a tool card's full output, an answer's markdown, a
  prompt's text) and `Y` its command (a tool's name and arguments) to the
  system clipboard via OSC 52 — through tmux's passthrough when `TMUX` is
  set; up to 100 KB (`copied 1.2 KB`, else `too large to copy — ⏎ view and
  select`), and never claimed on a terminal known to drop it (Apple's
  Terminal.app says so instead). `⏎` opens the block whole in a viewer
  (`↑↓`/`j k` scroll, `PgUp/PgDn` a page, `g`/`G` the ends, `y` copy, `esc`
  close); `x` expands or collapses just that block. `i`, `Esc` or any other
  key returns to typing — a printable key is typed into the editor. The
  hint row reads `↑↓ move  ⏎ view  y copy  Y copy command  x expand … esc
  back`.
- **The first screen**: an empty session opens on
  a preflight instead of a wall of keys — the wordmark with the version
  (`■ kubic <version>` below 70 columns); PREFLIGHT rows `✓ provider` (the
  model and where its key comes from, or `◆ … testing provider` for faux),
  `✓ project` (the path, `git <branch> · clean | N changed`, or `not a git
  repository`), `✓ trust` (`.kubic/config.toml loaded`, only when the
  project has a layer), `✓ journal` and `○ isolation` (what running with
  no isolation means, with `/safety`); START (`⏎ describe a task below`,
  then `/ commands  @ attach a file  ^P palette  ? all keys` from the key
  bindings); and
  RECENT IN THIS PROJECT — up to three sessions with their age, first prompt
  and `turns · cost`, then `/resume to open one`. It is not a transcript
  entry: the first prompt (not a command) clears it, a resumed session with
  history never shows it, and `/new` brings it back. `?` on an idle, empty
  editor lists every key binding, grouped (editor, session, transcript,
  panels, approvals), with the key each has now.
- **The notice row** above the editor — the "footer" the rest of this page
  refers to: a command's reply, a refusal, a turn's outcome
  (`cancelled`, `error: …`), the lane's retry or compaction activity, and,
  while a turn runs, the working line `⠹ Working · 0:12 · ↑ 9.2k ↓ 640 tok ·
  3 tools … esc interrupt   ⏎ queue a message` (tokens once a usage row
  reported them). It takes no row when it has nothing to say, and wraps to at
  most two rows.
- **The editor**, framed: `┌─…─┐`, `│ › <draft>   @ file  / cmd │`,
  `└─…─┘`. The caret is the only red on screen while you type; the box grows
  with a multi-line draft (Pi's `↑ 3 more` scroll markers stay in its rules)
  and the `/`-command and `@`-file completions open below it. Mid-turn it is
  a queue box: `› type to queue — sent when this turn ends`.
- **The status line** (one row): `● <model> · <thinking>  │  ctx ━━━━──────
  31% of 200k  │  $0.031  │  journal 2 changes` with the turn's
  state word on the right — `ready`, `working` (the mark becomes the
  spinner), `needs approval`, `cancelling…` or `error` (the last turn
  failed; the next one clears it). The context gauge appears once the lane
  has reported a committed request and the model's window is known; it turns
  to the warning colour at or above the auto-compaction threshold (window
  minus the reserve; roughly 87% of a 128k window, higher on larger ones), so
  the warning is the signal that the next turn will compact. The journal
  count is the session journal's changes (hidden at zero). As the terminal
  narrows the window size drops first, then the journal count, the gauge
  cells, the thinking level and the context segment; the model name is cut
  last, and
  the cost and the state word never drop.
- **The key-hint row**: the keys that act right now, read from the key
  bindings (a rebound action shows its real key; an unbound one is not
  hinted). Idle: `⏎ send  ^J newline  / commands  @ file  ^P palette  ^O
  diff  ^R journal … ^C ^C quit` (`⇧⏎ newline` on terminals that report
  Shift+Enter, `@ file` when file mentions are available). While a turn
  runs: `esc interrupt  ⏎ queue  alt+⏎ steer  ^X expand output  ^P palette
  … ^C ^C quit`. With an
  approval pending: its allow and deny keys. With the palette open: `↑↓ move
  ⏎ run  tab next group  → details … esc close`. With the model picker
  open: `↑↓ move  ⏎ switch  → expand provider … esc keep current`. With
  another picker or a dialog open: `↑↓ move  ⏎ select  esc cancel`.
- **The palette** (`Ctrl-P`): one fuzzy search over four groups,
  in this order — **COMMANDS** (the slash-command registry: name, summary,
  and the key the bindings give it now), **MODELS** (the usable catalogue,
  `provider/id` with its context window and whether it thinks, the live one
  marked `● … current`), **SESSIONS** (this project's other sessions, by
  their first prompt, with their age and turns — the rows `/resume` lists)
  and **FILES** (the project's files, at most 2,000). A group with
  nothing matching is hidden, and each shows at most six rows until `tab`
  focuses it. Every word of the query must match a row's name in order, or
  appear in a command's summary (ranked below a name match); the matched
  letters are drawn in the accent colour, and the best match of any group is
  selected. With nothing typed it shows the commands this session ran (the
  first six commands before any) and the live model. `⏎` runs the row: a
  command runs exactly as if it were typed (one that needs its argument —
  `/image <path>` — is put in the editor to finish), a model switches
  like `/model`, a session resumes like `/resume`, a file inserts
  `@<path> ` at the cursor. `→` shows the selected row in full in a footer
  line, `esc` closes. The palette floats over the screen, which dims (no
  colour, every row in the faint text colour) while it or a picker is open;
  the key-hint row stays lit with the palette's own keys. Models and
  sessions arrive after the first frame, so a slow catalogue never holds the
  palette up. It needs 60 columns; it is 80 cells wide, or 70% of a narrower
  terminal, and at most 70% of the rows tall.

Colour follows the Konic palette on truecolor terminals, falls back to
256/16 colours, and is off for `NO_COLOR`, `TERM=dumb`, or a non-TTY
stdout (`FORCE_COLOR=0..3` overrides). The palette is selectable: `[ui]
theme` takes a built-in name (`default`/`dark`, the shipped brand palette,
`light`, or `terminal` for the terminal's own colours) or a path to a JSON
theme file (design-token roles, `/README.md`), resolved and
validated before the screen opens — a missing or invalid file is one
`error: theme '<ref>': …` line on stderr and exit 2. A custom theme's
truecolor values are downgraded to the terminal's colour level exactly like
the built-in palette; see `[ui] theme` under
[configuration](configuration.md).

| Key | Meaning |
| --- | --- |
| `Enter` | **Submit** the prompt (an empty draft submits nothing); typing `/` opens the editor's autocomplete over the registry's commands, and `Tab`/`Enter` completes the name. A submit while a turn runs is **queued as a follow-up** in the conversation's own inbox (pi-durable `whenBusy: followUp`): a dim `queued: …` row appears under the transcript the moment the harness admits it, and the harness delivers it — its own user entry, answer, usage row and journal effects — when the running turn settles. A refused submit never eats the draft — it goes back into the editor, and the footer says why. |
| `Alt+Enter` | **Steer** the running turn with the draft: the text joins the work already in flight (the harness places it after the current tool round), and the editor is cleared like `Enter`. With no turn running it submits the draft exactly like `Enter`. An empty draft steers nothing. |
| `/model <provider/id>` | Switch the live lane's model (the session override): resolved against the catalogue, committed to the session's agent document (a resume restores it), and shown in the welcome block and status line. `/model` alone opens the **model picker** (the same as `Alt+M`); an unknown or malformed id is refused in the footer and the lane keeps its model. |
| `/thinking <level>` | Set the live lane's thinking level (thinking.cycle): one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` — clamped to what the current model supports, and the footer reports the effective level (`thinking: high`, or `thinking: off (clamped from xhigh)` when they differ). `/thinking` alone opens a picker of the levels the live model supports, the live one marked `● … current` (`Esc` keeps it); an unknown level is refused by name with the vocabulary. Committed through the conversation's agent document, so a resume restores it. Refused while a turn runs. |
| `Alt+M` | **Model picker** (model.select): one group per provider — the live model's first — headed by where its key comes from (`ANTHROPIC  ● key from ANTHROPIC_API_KEY`); each model shows `● … current` for the live one and its context window and whether it thinks (`200k ctx · thinking`). A provider with more than eight models folds behind `▸ expand (→)`. Providers without a key are listed greyed with the variable to set (`OPENAI  ○ no key  set OPENAI_API_KEY`, named by Pi's own auth check) and their models are never offered. The **thinking row** at the bottom steps, with `←`/`→`, through the levels the selected model supports (the live level marked, a level the model lacks clamped down): `Enter` switches the model through the same resolution and refusals as `/model <provider/id>` and then sets the chosen level, so model and effort are one decision. Typing filters (by `provider/id`), and `Esc`/`Ctrl-C` cancels, leaving the model unchanged. Refused while a turn runs. **macOS:** Option sends `µ` for Alt+M unless the terminal sends Esc+ for Option (iTerm2: Profiles → Keys → Left Option key: Esc+; Terminal.app: "Use Option as Meta key") — `/model` or `Ctrl-P` reach the same picker either way. The overlay needs a terminal at least 60 columns wide (Pi refuses to composite it below that); on such a terminal the picker does not open and the footer says `model picker unavailable on this terminal — use /model <provider/id>` — a terminal resized below the minimum while it shows closes it the same way. |
| `Alt+T` | **Cycle the thinking level** over the levels the live model supports (thinking.cycle), committing each step exactly like `/thinking <level>`. Refused while a turn runs. |
| `/compact [instructions]` | Compact the session's context now: the harness summarizes the older history into one `pi.compaction` entry while the most recent turns stay verbatim, and optional `instructions` focus the summary verbatim (`/compact keep the failing test names`). The command text never reaches the model. The footer reports `compacted: <tokensBefore> tokens → summary`, `nothing to compact: no history older than the most recent turn (<tokens> tokens of context)` when the session holds no history older than its latest turn (nothing is admitted), `nothing to compact: no cut point before the most recent turn (<tokens> tokens)` when the harness finds no cut point, or the harness' own failure message. In both `nothing` cases nothing is placed, and the footer never claims a cut. The user's `/compact` keeps about 2000 tokens verbatim, cut at a message boundary, whatever the model window; Ctrl-C cancels a running compaction (`compaction cancelled`). Refused while a turn runs. |
| `/help [command]` | List the registered slash commands — and the keys that reach the same actions — generated from the registry, or one command's usage line. The list lands in the transcript. |
| `/session` | Report the live session: id, workspace, model, thinking level, tokens (in/out/cached) and cost, from the rows the status line already carries. |
| `/safety` | Print the honest limits into the transcript, in full and verbatim from the limits module: that the session runs in-process with your authority (files, network, credentials), with no containment and no prompt-injection prevention, and that the controls are approvals plus the change journal. Answered even where the startup notice is suppressed (`KUBIC_NO_NOTICE=1`), because you asked. A local read: nothing reaches the model. |
| `/new` | Close the current session and boot a fresh one **without leaving the alt-screen**: the transcript, tree, usage rows and panels clear, and the next prompt runs on the new lane. The old session stays on disk (`kubic sessions list`). Refused while a turn runs (`session: finish the current turn before switching`) — the lane swap is the quit path's race, not a mid-turn one. |
| `/resume` | Pick one of this project's other sessions (newest first, at most 30): each row is its first prompt, with its age, turns and cost (`2m ago · 4 turns · $0.03`), read without a lock the way `kubic cost` reads. A session another `kubic` holds is greyed `in use by another kubic` and cannot be chosen. Choosing one attaches to it and loads its transcript, in the same alt-screen. Needs a terminal wide enough for the picker — otherwise the footer says so. Refused while a turn runs, like `/new`. |
| `/theme [name]` | **Theme picker**: the built-ins `dark`, `light` and `terminal`, and the configured `[ui] theme` file if there is one. Moving the selection previews each theme live; `Enter` keeps it for this session and prints `to keep it: [ui] theme = "<name>" in ~/.kubic/config.toml` (the config is never written); `Esc` restores the theme from before. `/theme <name>` switches directly; an unknown name is refused with the choices. |
| `/tree` | Pick an earlier prompt and **retry from there in a fork** (`session.fork`): a picker lists this session's prompts newest first (`#<entry>  <prompt>`); choosing one forks the session into a **new** session just *before* that prompt (the same fork as `kubic sessions fork --at`), switches the TUI to it in the same alt-screen, and puts the prompt back in the editor to edit and resend. The original session is untouched and keeps the abandoned path (`kubic tui --session <old id>` / `/resume` returns to it). Needs a terminal wide enough for the picker; refused while a turn runs. |
| `/fork <entry>` | Fork this session **at** `<entry>` (inclusive; `kubic sessions attach <id> --ids` prints the ids) into a new session and switch to it, the editor left as it was. `/fork` without an integer entry is refused with the usage line. A fork that fails (an entry the session does not have) re-attaches the session you were in and names the reason on the footer. Refused while a turn runs. |
| `/diff` | Open the diff panel — the same panel `Ctrl-O` toggles. |
| `/undo` | Restore the session journal's changes (the same plan/apply path as `kubic undo`, without `--step`): the footer reports `undo: N restored, M skipped` and warnings land in the transcript. Refused while a turn runs (`undo: finish the current turn before switching`) — it rewrites the workspace the turn is working in. |
| `/image <path>` | Attach one image (`png`, `jpeg`, `webp`, `gif`, ≤ 5 MB — verified by magic bytes) to the next submitted prompt. The footer names the file and its size, and the prompt renders it (the real image on kitty/iTerm2 terminals, a `[image: <name> <size>]` row otherwise; a resumed session's committed entry has no file name and shows the MIME type instead). Enter on an empty draft sends the attachment alone. Refused in the footer when the path is not a regular file, the file is missing or unsupported, it is over the cap, or the live model takes no image input — nothing is sent. A pasted inline image (iTerm2 `OSC 1337`, reassembled across reads) attaches the same way. |
| `/quit` | Leave the TUI (same as `Ctrl-D` on an empty draft). |
| `/foo` (unknown) | **Refused locally** — `unknown command '/foo' — /help lists the commands` on the footer, with the draft kept in the editor. A slash command is never sent to the model; `//text` is the escape hatch for a prompt that starts with a slash. |
| `Ctrl-P` | Open the **palette**: fuzzy search over commands, models, sessions and files — `↑↓` move, `⏎` runs the row, `tab`/`Shift+Tab` focus the next/previous group, `→` details, `Esc`/`Ctrl-C` close. See *The palette* above. |
| `Alt+A` | **Toggle full access** for this session: enabling opens a confirmation dialog naming the consequence (`Ctrl-S` confirms, `Esc` cancels — a bare printable letter never does); disabling takes effect immediately. Either way `posture.json` is written, one `posture:full-access` / `posture:approvals` row is appended, and the status-bar indicator moves in the same frame. While an **approval is pending** the toggle refuses (`approvals: answer the pending request first`): the confirmation is a modal of its own and the approval owns the keys until it is answered. `kubic tui --dangerously-skip-approvals` is the boot-time equivalent. |
| `/approvals [on\|off]` | The same posture, by direction: `/approvals` alone reports the live posture. `on` opens the confirmation — and in a session that is **already** on it only reports (`approvals: full access already ON for this session`), never flipping the other way or opening a dialog. `off` disables immediately; in a session that is already off it only reports (`approvals: enforced — nothing to change`) and writes no second row for a change that did not happen. Any other argument is refused by name. |
| `Ctrl-J`, `Shift+Enter`, `\` then `Enter` | Insert a newline (multi-line entry). |
| `@` | **Mention a file**: typing `@` and part of a path opens a completion popup of matching workspace files — fuzzy, file-name and path-prefix matches first, at most 50 — and `Tab` (or `Enter` on the popup) inserts the workspace-relative path as `@path ` (`@"path with spaces" ` when it needs quoting). The list is the walk the `find` / `grep` tools use: `.gitignore` rules (nested ones included) are honoured and `node_modules` / `.git` are skipped, so an ignored file is never offered; it is refreshed at most every 2 s. **Only the path is sent** with the prompt — no file content is attached; the model reads the file with its own tools when it needs it. `/` commands complete through the same popup. |
| `Up` / `Down` | Recall earlier prompts on an empty draft (Pi's editor history; consecutive duplicates collapse to one). `kubic tui --session <id>` seeds it from the resumed session's committed prompts, so `Up` recalls what the previous process sent — the newest 100, the same bound the editor keeps for live prompts. |
| `Ctrl-T` | Show / hide the tree row (hidden by default). |
| `Ctrl-O` | Toggle the **diff panel** — the last tool call that changed files (or, when a `bash` call changed something the file tools did not journal, that turn's reconciled change), rendered as unified hunks. Every file of the call is rendered under its own `path — op (file k/N)` header; the panel scrolls, and `Alt-↓` / `Alt-↑` cycle its files. |
| `Ctrl-R` | Toggle the **journal panel** — every change in the session journal, including changes made with `bash` (filter by path on the command line with `kubic diff --path`). `Alt-↓` / `Alt-↑` page through it. |
| `Ctrl-X` | Expand / collapse every tool output block. Collapsed, a block shows the first 5 lines, each cut at the terminal width, with a `… +N lines · lines clipped (ctrl+x to expand)` hint whenever anything is hidden or cut. Expanded, every output line **wraps** (hanging indent under the `⎿`) and the tool call's args summary wraps too, so a long diagnostic, stack frame or path is readable in full. |
| `alt+down` | With a panel open: the diff panel's next file (wrapping), or the journal panel's next page. Ignored while both panels are closed. |
| `alt+up` | With a panel open: the diff panel's previous file (wrapping), or the journal panel's previous page. Ignored while both panels are closed. |
| `a` | Approval card: **allow once** — this call only, after the arming delay and the quiet period, and only while the card can show the whole command. Nothing is stored: the next identical call asks again. |
| `Ctrl-S` | Approval card: **allow for the session** — after the arming delay and the quiet period, and only while the card can show the whole command; never a bare letter. Latched in `<session>/approvals.json`; identical calls in this session are not asked again (also after re-attach). |
| `d`, `Esc` | Approval card: **deny** the challenged call. `Esc` acts at once (the only immediate action), `d` after the arming delay. A denial latches for the session like `Ctrl-S`, so the same operation is refused without asking again. |
| `v` | Approval card: show the next page of a command too tall for the card, or an edit's whole diff (never decides). |
| `?` | Approval card: open (and close) the model's explanation for the ask (never decides). |
| `c` | Approval card: **deny with a comment** — opens a one-line input on the card; `Enter` denies with `denied by the user: <comment>` as the reason the model reads (an empty comment is a plain deny), `Esc` goes back to the card. At most 500 characters; recorded in the ledger as the denial's reason. Like `d`, the denial latches for the session. |
| `e` | Approval card: **edit the command, then allow it** (shell asks only) — opens the proposed command in a one-line input; `Enter` runs what you typed instead. The edited command is judged again from the start, so an edit that is itself destructive asks again; an unchanged command is a plain allow once, an emptied one is not accepted. The call's result opens with `[edited by the user — ran: <yours> (proposed: <the model's>)]`, so neither the model nor the transcript takes it for the proposed command's output. Nothing is latched; the ledger records both commands. |
| `A` | Approval card: **allow all edits this turn** (an edit or write ask a role's `requires` raised inside the workspace) — this call and every such ask until the turn ends. Never another capability: a write outside the workspace, into `.kubic/` or onto credentials still asks. The status line says `edits auto-approved this turn` while it applies; nothing is latched. |
| `Ctrl-C` | **Interrupt** the in-flight turn and keep the session; a second press while the interrupt drains quits. Idle, **a composed draft is never discarded**: the first press clears it (`^C: draft cleared`); on an empty editor a press shows `press ^C again to quit` on the notice row for 2 s, and a second press inside that window quits. **Cancelling clears the queue**: the abort withdraws every queued follow-up, and the footer names the count (`cancelled · dropped 2 queued prompts`). A prompt queued after a *failed* run stays in the inbox and is placed by the next submit (pi-durable's own rule). |
| `Esc` | **Never quits**. It closes the editor's dropdown or an open picker or dialog; during a turn it **interrupts** it like the first `Ctrl-C` — the session and the draft stay, and a second `Esc` while the interrupt drains does nothing. Idle on an empty editor it enters **block mode** (see *Block mode* above). While an approval is pending it denies. For a one-press quit key, bind `app.exit` in `~/.kubic/keybindings.json`. |
| `Ctrl-D` | Quit on an empty draft; while typing it stays delete-forward. |
| `PageUp` / `PageDown` | Scroll the transcript one page (pi-tui's alt-screen binding; the editor does not see these keys). |
| `Home` / `End` | Scroll the transcript to its top / bottom — which is why they do not move the editor's cursor: `Ctrl-A` / `Ctrl-E` move to the line start / end instead. |
| `Ctrl-Up` / `Ctrl-Down` (`Ctrl-Shift-Up` / `Ctrl-Shift-Down`) | Jump to the previous / next prompt in the transcript. |
| `Ctrl-Shift-F` | Search the transcript: `Enter` (or `Ctrl-G`) selects the next match, `Shift-Enter` (`Ctrl-Shift-G`) the previous one, `Esc` closes the search and returns the keys to the editor. |
| EOF (closed stdin) | Quit — a detached tty or `kubic tui < /dev/null` never hangs the alt-screen. |

**Retries and compaction on the footer**: while
the harness waits to retry a transient model error the footer under the
editor reads `⟳ retrying · attempt <n> — <error>`, and while it compacts the
context `⟳ compacting context…`. The line outranks every other footer line
while it lasts (it is why the turn looks idle) and clears the moment the
retry lands or the compaction finishes. The harness reports the attempt and
the error only — no retry budget or countdown is shown because none is
reported.

### Keybindings file (`~/.kubic/keybindings.json`)

Every key in the table above that Kubic claims ahead of the editor is an
**action** in one keybinding registry, and
`~/.kubic/keybindings.json` rebinds actions: a JSON object of
`"action": "key"` or `"action": ["key", ...]` (a list replaces the defaults;
`[]` unbinds the action). Key ids are pi-tui's — `ctrl+g`, `alt+enter`,
`ctrl+shift+f`, `escape`, a single character — case-insensitive, modifiers in
any order. A rebound action works under its new key everywhere at once: the
dispatch, the idle key hints and the welcome block; the old key falls through
to the editor. The editor's own keys (`Enter`, `Ctrl-J`, `Ctrl-A`/`Ctrl-E`,
…) and pi-tui's alt-screen keys (`PageUp`/`PageDown`, `Home`/`End`, …) are
Pi's and are not in the registry.

```json
{ "panel.diff": "ctrl+g", "panel.journal": "alt+g" }
```

**Conflicts are reported at boot** (a `warning:` line on stderr before the
alt-screen opens; the TUI still starts). A user binding beats a default: the
default action loses that key (`keybinding: ctrl+r now runs panel.diff
(override), so panel.journal no longer has it`, plus `panel.journal is
unbound` when nothing is left). Two user bindings on one key are a conflict —
the first action in the table below keeps it and both are named. Approval
keys conflict only with each other (the approval owns the keys while it
shows, which is why `Esc` can be both the global cancel and the approval deny).
**A broken file refuses the boot** (`error: keybindings '<file>': …`, exit 2,
nothing opens): invalid JSON, an unknown action, a malformed key id, or a
file that is not a regular file or is over 64 KB. A missing file means the
shipped bindings.

| Action | Default keys | What it does |
|---|---|---|
| `app.interrupt` | `ctrl+c` | interrupt the running turn; idle: clear the draft, then press twice to quit |
| `app.cancel` | `escape` | close the open dropdown or overlay; else interrupt the running turn — never quits |
| `app.exit` | unbound | quit on an empty draft (clears a draft first); bind a key to get a one-press quit |
| `app.eof` | `ctrl+d` | quit on an empty draft; delete-forward while typing |
| `app.palette` | `ctrl+p` | open the command palette |
| `help.keys` | `?` | list every key (on an idle, empty editor; elsewhere `?` is typed) |
| `view.tree` | `ctrl+t` | toggle the tree |
| `panel.diff` | `ctrl+o` | toggle the diff panel |
| `panel.journal` | `ctrl+r` | toggle the journal panel |
| `transcript.expand` | `ctrl+x` | expand / collapse tool output |
| `prompt.steer` | `alt+enter` | steer the running turn (submit when idle) |
| `model.pick` | `alt+m` | open the model picker |
| `model.thinking` | `alt+t` | cycle the thinking level |
| `approvals.fullAccess` | `alt+a` | toggle full access for this session |
| `panel.next` | `alt+down` | open panel: next file (diff) / next page (journal) |
| `panel.previous` | `alt+up` | open panel: previous file (diff) / previous page (journal) |
| `approval.allowOnce` | `a` | approval: allow once |
| `approval.allowSession` | `ctrl+s` | approval: allow for the session |
| `approval.deny` | `d`, `escape` | approval: deny |
| `approval.comment` | `c` | approval: deny with a comment for the model |
| `approval.edit` | `e` | approval: edit the command, then allow it |
| `approval.allowEdits` | `shift+a` | approval: allow all edits this turn |
| `approval.explain` | `?` | approval: show why the model asked (the card's explanation row) |
| `approval.page` | `v` | approval: next page of a long command |

Both panels read the session's own journal through the same projection
`kubic diff` prints (one change per path, latest attribution): once at boot
— so `kubic tui --session <id>` shows earlier turns the first time `Ctrl-R`
opens — after each tool call (throttled to one read per 100 ms burst) and
when a turn settles. Paths and file content are stripped of terminal
control sequences before they are drawn: whole SGR/OSC sequences (so
`FORCE_COLOR` output reads as plain text, not `[31m` noise), carriage-return
overwrites collapsed to what the terminal would show, and tabs expanded by
column.

Both panel rows scroll: the mouse wheel over the panel moves it (it does not
chain to the transcript while the panel can still scroll), and
`Alt-↓` / `Alt-↑` move through the open panel — the diff panel's files, or a
page of the journal panel. A freshly opened panel starts at its first file,
and a repaint (new journal rows arriving) never yanks the viewport.

A challenged call turns the editor into an **approval card** instead of being
refused (``): an amber frame with the
`APPROVAL` badge, the tool and `1 of N`; the exact command (`$ …`, its
destructive words bold) — or, for an `edit` or `write`, the diff it would make
against the file on disk (`+A −R` in the frame); one plain-language row for the
reason (`▲ destructive   it can delete or overwrite files`), the working
directory (and, for a file change, that the journal keeps the old file), the
next waiting ask (`next: …`), and the keys. `?` opens the model's own
explanation. The transcript above stays readable — `PgUp` scrolls it — while
the header shows `1 WAITING`, the call's card `◆ waiting for you` and the
status line `needs approval`. Each capability a call trips is asked on its
own, so a command that is both destructive and networked is `1 of 2`, then
`2 of 2`. The card names the tool class and the exact command, so the decision
is made on what was actually asked, not on the tool's name. The command is shown **whole**:
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

One-line summaries (audit detail, trajectory) are different text: they keep the broader block-reason redaction —
the same secret-shape table the audit backstop uses (`sk-…`, `AKIA…`,
`ghp_…`, `xox…-`, PEM headers), the full credential after an `Authorization:`
header or a bare `bearer`/`basic` scheme, a `-u`/`--user`/`--proxy-user`
`user:password` operand, and URL userinfo (`https://user:pw@host`) — and, when
they shorten a command, say so: `… (+N chars)`. The narrow redaction is what
the approval card's command shows — it carries the full command to the seat
that decides, with the operator still seeing the host and the flag. The summary's broad
redaction is the safe over-redacting one.

Rows wrap by terminal **display columns**, not by character count: wide (CJK)
characters count two columns, and a combining sequence or an emoji cluster is
never split, so every character of the command appears in the rows and none is
cut by the card's edge. A command taller than a page (8 rows) shows one page at
a time with an explicit `… lines 1–8 of N` marker, and `v` pages through it;
on an edit, `v` opens the whole diff (twelve rows show by default). When the
card does not fit — it needs its own rows plus six more for the header, the
status line, the key hints and three rows of transcript — it **fails closed**:
it says `the terminal is too short to show this command — enlarge it` and
every allow key (`a`, `Ctrl-S`) is inert until the terminal is tall enough, so
you can never allow what you cannot see. `d` (after arming) and `Esc` (at
once) still deny, and the card re-checks on every frame and key, so enlarging
the terminal restores it. The card is the same at every width; below 60
columns its reason rows keep only their labels and the keys wrap. Denying
leaves the session running; the transcript shows the refusal instead of the
call's result. Quitting with an ask still pending denies it, so a shutdown
cannot strand the turn.

An approval is consent to run code with your authority, so keys typed for
the editor can never produce one. Asks arrive while you may be typing the
next prompt, so the card is a capturing modal: while it shows, printable
keys are dropped instead of reaching your draft (the global keys `Ctrl-C`,
`Ctrl-D`, `Ctrl-T`, `Ctrl-O`, `Ctrl-R` and `Ctrl-X` still work). Three rules keep type-ahead and a held key from answering:

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
assistant answer, notice row, editor, status line and key hints — on stdout,
without the
editor's cursor artifacts (the hardware-cursor marker and the inverse-video
cursor cell are stripped, as Pi's own stop path strips the marker). A crash
restore (see **Signals and crashes** below) prints no document. **Quitting mid-turn aborts the turn** — `Ctrl-D`, `SIGINT` or stdin EOF while a turn runs (and `Esc`/`Ctrl-C` from their *second* press: the first one cancels the turn and keeps the session): the turn
is aborted (durably recorded in the session, so a resumed session shows no
unfinished work), every tool process group it started is killed, and
the loop waits for it to settle (footer: `cancelling…`, at most 3 s) before
the end-of-run reconciliation sweep and the session close — so a killed
tool's last write is still journaled and no child keeps running after the
TUI exits. A further `Ctrl-C` (or `SIGINT`) during that wait exits at once — a real press only: the repeat and release events a
Kitty-class terminal reports for a held `Ctrl-C` are ignored, like every
other repeat of a global key. The 3 s bound covers the whole drain, the abort request included: an abort that never answers does not block the quit (the registered kills still run, and a kill registered after
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
`Ctrl-Z` suspend is not supported. Kubic runs in-process with your user
authority: no isolation, no containment. The no-isolation statement is on
screen from the first frame: the first screen's isolation row carries it
(with `/safety` beside it), and `/safety` prints the full text from the
limits module on demand. The startup line is suppressed by the opt-out
`KUBIC_NO_NOTICE=1`; see
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
| `create [--cwd <path>] [--dangerously-skip-approvals]` | Create a session, print its id on stdout. `--cwd` sets the session directory (default: current directory): a relative path resolves against the invoking directory (never the sessions root) and must name an existing directory, otherwise create refuses with `kubic sessions create: --cwd <path>: no such directory` (exit 1) and creates nothing. `--dangerously-skip-approvals` records session-scoped full-access in the session dir, appends one `posture:full-access` row to the audit ledger (session id, `kubic sessions create --dangerously-skip-approvals`), and prints a `warn:` line on stderr — fresh sessions start safe, the flag must be passed explicitly every time. |

| `list [--json]` | A `SESSION  CWD` table (plain aligned columns off a terminal, the kit table on an interactive colour terminal). With no sessions stdout stays empty and an `info:` line on stderr says so. `--json` prints one pretty-printed array of `{id, cwd}` objects — `[]` when there are none. **`kubic sessions --json` with no subcommand is the same array**; `kubic sessions` without `--json` stays the usage error naming the subcommands. |
| `attach [--] <id> [--tail <n>] [--ids] [--json]` | Print session metadata, the approvals posture (`approvals enforced` or `full-access …`), the `pending work: <kind> <id> (<status>)` summary when a crashed run left unfinished durable work (settled by the next `run`/`tui --session`), then the last `--tail` transcript turns (default 10) — one readable line per turn (`user: …`, `assistant: …`, `tool-result <name>: …`, `system: …`, `[compaction] …`, `[reset] …`), whitespace collapsed and bounded to 300 characters; transcript text and model-authored tool names are untrusted, so terminal control sequences are stripped before a line is printed. `--tail` needs a non-negative integer. `--ids` prefixes each transcript line with its entry id (` user: …`) — the id `kubic sessions fork --at` takes. `--json` prints the raw tail entries instead — one full untruncated entry JSON per line, for scripting. |

| `fork [--] <id> [--at <entry>] [--tree] [--json]` | Fork a session into a **new** one and print the new id — `--json` prints one `{id, source, at}` document (`at` is `null` for `--tree`). The id works at once with `kubic run --session` / `kubic tui --session`. A **branch fork** (the default) cuts *at* an entry, inclusive — `--at <entry>` names it (`kubic sessions attach <id> --ids` prints them), default the source's newest — and the new session's lane is a pi-durable fork of the source's: it sees the history through that entry and the agent (model, thinking level) as of it, and nothing after it. **`--tree`** copies the whole session instead: every conversation and branch tip, the lane unchanged. Either way the new session has its **own** directory, lock and an empty journal, starts with **no usage** (the copied `pi.usage` documents are emptied, so `kubic cost` never counts the source's spend twice), and starts with **approvals enforced** — the source's posture, approvals and journal are not copied. The source is only read, under its own lock: forking a session another process holds live is **refused** (the lock refusal naming the holder, exit 1, nothing written), as is a missing session (exit 1) and an `--at` entry the source does not have (exit 1). `--at` with `--tree` is a usage error (exit 2). |

| `prune [--keep-days <n>] [--keep-session <id>]... [--yes] [--dry-run]` | Retention for session **state dirs** (`<sessions-root>/<id>/`): **lists by default, deletes only with `--yes`** (or a yes at the terminal prompt). See [Session retention](#session-retention-prune) below. |

Usage errors exit 2 on stderr: a missing subcommand (the group action prints
`error: sessions needs a subcommand (create | list | attach | fork | prune)`;
`--json` alone lists), an unknown option, a missing value, `attach` without an
id or with an id outside `[A-Za-z0-9_-]`, a malformed `--tail`,
`--keep-days` or `--keep-session`, and `--yes` with `--dry-run`. An
unknown subcommand exits 2 (`error: unknown command '<name>'`), like an
unknown top-level command. Attaching a missing session exits 1; attaching
a session another process holds live prints the lock refusal (the holder's pid and start time are named) and exits 1 without reading
the transcript. An id with no session storage, including a folder that holds
only a transcript file, is an unknown session and exits 1 the same way.

The transcript `attach` prints is the durable one, read through the shared
pi-durable adapter (`packages/worker/src/lane/transcript.ts`)
and never by booting a lane: a reader must be able to inspect a session it
may not run.

### Session storage

A session is one directory, `<sessions-root>/<id>/`, holding the
pi-durable JSONL storage (`main.jsonl` and its `doc-*.jsonl` sidecars —
the transcript, documents and durable tasks), Kubic's `session.json`
listing header, the lock, the journal, spans, approvals posture and
trajectory. The session's metadata is the session-scoped `kubic.session`
document, written in the creating commit, so anything holding the session
open reads it from the same durable state as the transcript. Session JSONL
is not fsynced; the change journal is the fsync'd store.

This release starts a clean session format. Session folders written by
earlier builds are ignored: they are never listed, the overlap warning
(`kubic doctor`) never counts them, and attaching one exits 1 as an unknown
session. Nothing is converted, moved or rewritten, and `kubic sessions prune`
only ever considers `<root>/<id>/` directories that hold a session
([below](#session-retention-prune)).

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
  see [worker](../packages/worker.md#session-locking)). The
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
  `lock.json`, names outside `[A-Za-z0-9_-]`, and any folder that holds no
  session file (`main.jsonl`, `session.json` or `lock.json`), such as a
  folder with only transcript files, are never touched. A session that
  cannot be inspected is skipped and reported
  (`unreadable: <id> — skipped`), never guessed at. A missing sessions
  root is a fresh machine: `nothing to prune`, exit 0. A root that exists
  but cannot be listed refuses by name, exit 1.
- **Scope.** `prune` deletes `<sessions-root>/<id>/` state dirs only —
  never the workspace journal (`.kubic/journal`), never anything outside
  the sessions root. A durable session's transcript lives INSIDE its state dir
  (`main.jsonl`), so pruning a session deletes its transcript with it.
  Folders that hold no session file are not part of this command.

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
| `status [--json]` | Branch (plus ahead/behind when non-zero), `staged:`/`modified:`/`untracked:` lines, a `conflicts:` line when merges are unresolved, or `clean`. On a detached HEAD the branch line reads `branch (detached HEAD)`. `--json` prints the status object: `branch` is `null` on a detached HEAD, `conflicts` lists the unresolved paths (never duplicated into `staged`/`modified`), and `renames` lists one `{path, oldPath, staged}` record per renamed or copied path that git detected (the new path also appears in `staged`/`modified`). |
| `log [--max <n>] [--json]` | A `SHA DATE AUTHOR MESSAGE` table (short sha), or `no commits` — also on a fresh repo with no commits yet (exit 0). `--json` prints the entries array (`[]` when empty). |
| `stage [--] <paths...>` | Stage paths, print `staged <p>` per path. `--json` prints `{staged: [paths]}`. Put `--` before a path that starts with `-`. |
| `commit -m <message>` | Commit, print `committed <sha8> (<n> file(s))`. `--json` prints `{sha, files}` with each path verbatim (never C-quoted, even non-ASCII or newline names). `-m`/`--message` takes the next token verbatim, even one starting with `-` (`-m --amend` commits the message `--amend`). |

On a colour terminal (TTY, no `NO_COLOR`, not `TERM=dumb`) the status
labels are coloured and `log` is the kit table (muted header, faint rule); piped or under
`--json` the output is plain text.

## `kubic commit -m <message> [--json]`

The alias for `kubic git commit`: same runner, same
message rule (`-m`/`--message` takes the next token verbatim, even one
starting with `-`; a message that really starts with `--` goes in the
attached form `--message=--amend`), same output and same exit codes —
`committed <sha8> (<n> file(s))` on stdout, `{sha, files}` under `--json`,
exit 2 for a missing or empty message, exit 1 outside a git repository.

## `kubic diff | undo | log | status`

VCS-independent change journal — works without git. Each command reads
one store, resolved in this order:

1. `--session <id>` names the store explicitly: the headless-run session
   journal at `<sessions-root>/<id>/journal` (`~/.kubic/sessions` by
   default). `kubic run` prints the session's ref as `journal:<id>`; pass
   it verbatim (`--session journal:<id>` or `--session <id>`). It works
   from any cwd, and it always operates on **the session's own recorded
   workspace** (the cwd the session was created in): `kubic undo --session
   <id>` run from another project restores files under the session's
   workspace, never under the current directory.
2. Without `--session`, the workspace store `<root>/.kubic/journal` (the
   legacy per-directory store, which no run writes to) when it is
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

Every journal entry, and every change `diff --json` reports, carries
`source`: `tool` for a tool call, `sweep` for the end-of-run reconciliation
(the entries flagged `unattributed`), and `undo` for an undo's own record.
A journal written before entries carried `source` is read with one derived on
read: a line recorded under the `kubic-undo` agent id is `undo`, a line flagged
`unattributed` is `sweep`, and every other line is `tool`. Reading derives it
and writes nothing back. A prune that rewrites the index persists the derived
`source` on each line it keeps. Undo and `diff` see those sources, so an
earlier session undoes, previews and prunes exactly as it did before.

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
`log` is the kit table (muted header, faint rule); piped, redirected or under `--json` everything
is plain text.

**Usage errors** exit **2** with one `error:` line on stderr and touch
nothing: an unknown option, an option without its value (`--path`,
`--session`, `--max-content-bytes`), a `--max-content-bytes`
that is not a non-negative integer, an extra operand (only `undo` takes
one, the `<path>` scope), a bad or conflicting `--session`. Every command
answers `--help`/`-h` with generated help (exit 0); `diff --help` and
`undo --help` include examples.

**Read-time self-heal.** With `session.retentionDays` set in
config, `kubic log` drops entries older than that window from a **session**
journal as it reads it — via `--session <id>` or the latest-session
fallback — the same age bound `kubic sessions prune` applies to whole
session dirs, one entry at a time. The workspace journal is not affected
(its own `[journal] retentionDays` bounds it on append). With retention
unset — or `0` — the log path writes nothing: reads never mutate the store.
Entries are removed on request by [`kubic journal prune`](#kubic-journal-prune---session-id---keep-days-n---yes---json),
which lists them by default.

```
kubic diff [--path <path>] [--max-content-bytes <n>] [--session <id>] [--json]
kubic undo [--step] [--dry-run] [--force] [--session <id>] [--json] [--] [<path>]
kubic log [--session <id>] [--json]
kubic status [--session <id>] [--json]
```

Options also take the `--flag=value` form (`--path=src/a.ts`).

| Subcommand | Meaning |
| --- | --- |
| `diff [path] [--path <p>] [--json] [--max-content-bytes <n>] [--session <id>]` | Rendered diff of journaled changes (`no changes` + exit 0 when empty). The `[path]` operand scopes exactly like `--path` (giving both with different values exits 2 naming the conflict; a second operand is refused the same way); `--stat` prints the per-file summary `path +added -removed tool[, turn N]` instead of hunks (counts from the same hunks, so they always agree; tool and turn render when the entry carries them — entries without them show the op, reconciliation finds `reconciled`); `--path` filters; `--json` prints `{session, root, changes}` — the change array with each side clipped at 64 KiB per change (`--max-content-bytes <n>` overrides the bound; `0` = unlimited). A `--path`/`--session` without a value, or a `--max-content-bytes` that is missing or not a non-negative integer, is a usage error (exit 2). Read-only: `undo` keeps the single-store contract (undo across worktrees is out of scope). |
| `undo [--] [<path>] [--step] [--dry-run] [--force] [--json] [--session <id>]` | Restore journaled changes. `--json` prints one object `{session, root, dryRun, restored: [paths], skipped: [{path, kind: stale\|already-undone\|non-reversible\|head-moved, reason}]}` (also when there is nothing to undo) with the same exit codes. Positional `<path>` limits scope; `--step` restores one step; `--dry-run` prints `would restore N step(s)…` and exits 0 without touching anything. Real runs print `restored <p>` per path plus a summary; warnings (a removal whose content had no recoverable copy, a pre-undo file that is no longer lossless utf-8 text — recorded hash-only, so that undo cannot be redone — or a step whose inverse record would not fit the journal's byte bound — that step is skipped BEFORE the file is touched, so the undo never lands unrecorded) go to stderr as `warn: …`. A session whose lock is live refuses the whole invocation with one `error: session '<id>' is attached by pid <pid> — refusing to undo under a live run (pass --force to override)` line and exit 1: restoring under a live run races its writes, and `--force` is the documented override (the same knob the staleness refusal uses). `nothing to undo` exits 0. **Exit 1 when any step was skipped** (the partial outcome never reuses the usage code) — four skip classes, each with its own line: `non-reversible (skipped): <p>` (no retrievable pre-image: an unattributed reconciliation find with no git pre-image (untracked, dirty at baseline, non-repo, binary or over-bound) or whose tool chain stored none, a write over a file above the 8 MiB pre-image bound (recorded hash-only), a delete-shaped undo whose file was absent pre-undo, or an inverse record over the journal's byte bound), `stale (skipped): <p> — <reason>` (the file changed after the entry was journaled — restoring would destroy unjournaled changes), `already undone (skipped): <p>` (a previous undo already unwound it — nothing is rewritten), `head-moved (skipped): <p> — <reason>` (the entry predates a HEAD move the run observed — restoring would write pre-move content onto the moved HEAD; `--force` overrides per-invocation). The summary is `undo: N restored, M non-reversible` when all skips are the non-reversible class, else `undo: N restored, M skipped (K stale, J already undone)` naming the counts present. The `--session` value selects the store, never the path scope. |

**Undo staleness safety.** Before any restore, the file's
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

**The undo record and redo.** Every successful restore is
itself journaled: the store appends the inverse entry for the step — the
pre-undo content as `before`, the restored content as `after`, attributed
`toolCall=none` and never marked `reconciled` (it is an
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
| `log [--json] [--session <id>]` | With `session.retentionDays` set and the session's lock live, the read-time self-heal is skipped with one `warn: journal retention skipped: session '<id>' is attached by pid <pid> — pruning under a live run can drop entries it just appended` line; the read itself is unchanged. A `TIME TOOL CALL OP PATH BYTES NOTE` table, one row per journal entry, oldest first — `NOTE` reads `reconciled` for an unattributed sweep find (`journal is empty` + exit 0 when empty); `--json` prints `{session, root, entries}` with the raw entries array. The human output closes with the reconciliation line `unattributed: N of M entr(ies) reconciled at run end` (printed for an empty journal too). |
| `status [--json] [--session <id>]` | `--json` prints the status object (`session`, `root`, `entries`, `reversible`, `nonReversible`, `unattributed`, `corrupt`, `corruptLines`, `repo`). Otherwise `entries: N (reversible: R, non-reversible: M)`, then `unattributed: U of N (reconciled at run end)`, then `corrupt: C` (content missing under a recorded hash) and `corrupt index lines: L` (index lines that do not parse and were dropped from the read — a torn tail from a crash or a full disk; the next append repairs it and the next retention rewrite drops it), plus repo line: `repo: non-repo directory (journal works without git)` or `repo: branch <b>, dirty: yes|no|unknown` with `, root <path>` when the root reads, `, ahead <n>, behind <m>` when an upstream exists, and `, conflicts: <p>, …` when merges are unresolved. Inside a linked worktree the branch is resolved through the `.git` `gitdir:` pointer (below); an unreadable pointer prints `branch (unknown)`. |

**Display truthfulness.** Three display-level guarantees on the
read side:

- **Worktree branches resolve.** A linked worktree's `.git` is a pointer
  file (`gitdir: <path>`), not a directory. The `status` repo line follows
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
  `--max-content-bytes 0` means **unlimited** (the unbounded pre behavior, for scripting). The bound applies to `--json` only — the human
  diff renders hunks, never whole files, and is never clipped.

### End-of-run reconciliation

Interception alone has holes: a file moved by `bash`
(`sed -i`, a formatter, `npm install` fallout, a build) never passes through
Kubic's own `write`/`edit` operations, so nothing journals it. The run and TUI
composition paths therefore capture a **baseline** when the lane boots and
**sweep** the workspace when it ends:

- A path the walk could SEE but not READ is stored as the sentinel `unreadable`
  instead of a hash: reconcile records neither a change nor a
  delete for it — nothing was observed to change and nothing was observed to
  vanish — and no before-hash is invented. A subtree whose listing fails with
  EACCES/EPERM/EIO is carried forward from the previous baseline the same way;
  one whose listing fails with ENOENT really went away, so its files are
  recorded as deletes like any other disappearance.
- **In `kubic tui` every prompt is a run**. The baseline
  is re-captured when each turn starts, a turn that used `bash` is swept when
  it settles (so `Ctrl-O` / `Ctrl-R` and `kubic diff` from another terminal
  show the shell's change at once), and the baseline is re-captured again
  once no turn is running and before an idle quit. An edit you make in your
  own editor **between prompts** is therefore absorbed, never journaled as
  the agent's change — so plain `kubic undo` does not revert it — while the
  sweep still journals whatever changed during a turn, your concurrent edits
  included (there is no way to tell them apart from the agent's). Each sweep
  entry carries `turn` (1 for the first prompt in this process); the
  quit-time sweep still catches a turn the quit interrupted and appends
  nothing for one that already settled.
- The baseline is a metadata walk — sha256 per file, **no content copied** — of
  the lane's workspace root (``), persisted as
  `<sessions-root>/<id>/journal/baseline-<id>.json` beside that run's journal.
- The sweep compares each path against its **expected state**: the last
  entry journaled for it during *this* run (the journal position is recorded
  with the baseline), or the baseline when this run journaled nothing for it.
  It appends one entry per changed, created or deleted path with
  `unattributed: true` and `toolCallId: null`, and the entry's `beforeHash`
  is that expected state. A revert behind the tools' back is a
  change too: a tool writes `a.txt` and `git checkout a.txt` restores it, so
  the sweep records the restore and `diff` stops showing an edit that no
  longer exists. Earlier runs of a resumed session never mask a change: a
  file set back to an older run's content, or deleted again after being
  recreated between runs, is journaled. A path only a tool journaled (absent
  from the boot baseline) is never reported deleted while it is still a
  regular file on disk: the sweep walk skips gitignored, `.git/` and `.kubic/`
  paths, so their absence from the walk is not a delete. Once such
  a file is really gone — removed, or replaced by a directory or a symlink —
  the delete is journaled.
- Excluded from **both** walks: `.git/`, `.kubic/` (journal state is never
  journaled) and anything the `.gitignore` files match — the root's rules plus
  every nested file's, child rules after the parent's so a nested negation
  overrides a parent ignore (last-match-wins, the ordering git uses, issue
  ); caller-declared out-of-scope paths are honoured when supplied. The
  matcher is the documented common subset (`*`, `?`, `**` at the edges,
  `dir/`, `!`) — exotic syntax is not covered, a nested anchored pattern is
  matched against the workspace-relative path (write it repo-relative:
  `packages/foo/build/`), and an unreadable nested ignore leaves its parent's
  rules in force. Anything missed only widens the baseline, never narrows the
  journal.
- Before-content for these finds comes from the git object store when the
  path was clean against the index at boot — the baseline records its blob
  OID, the sweep reads it back, and `kubic undo` restores it, so a bash `rm`
  or `sed -i` on a committed file undoes like a tool edit (the badge then
  reads `[unattributed]` alone). Otherwise — untracked files, files dirty at
  baseline, non-repositories, binary or over-4-MiB pre-images — they are
  recorded **hashes only** and the badge is `[unattributed, non-reversible]`:
  `kubic undo` skips them naming the path (`non-reversible (skipped): <p>`),
  exiting **1** without writing. The sweep never invents a pre-image: a blob
  that does not hash to the baseline digest is refused. If an earlier
  attributed entry in the same run already stored that path's pre-image, the
  entry *is* reversible through the tool chain instead, and `undo` restores
  it — the badge then reads `[unattributed]` alone.
- Cost is bounded: unchanged files cost one hash and no blob, and a file larger
  than 4 MiB is hashed in chunks, so its boot and sweep cost is one chunk of
  memory rather than the file size (a 256MB artifact measured below 1MB of heap
  growth). A sweep that finds nothing appends
  nothing; a file that *did* change is read once to store its after-content,
  because that content is what `diff` and `undo` serve — and that read is
  bounded too: above `MAX_SWEEP_CONTENT_BYTES` (4 MiB) the entry is
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
- HEAD moves are marked, not silently absorbed: the baseline records HEAD sha,
  branch and stash count, and a sweep that finds them changed appends one
  `marker` entry (`head-moved <branch>@<sha> -> <branch>@<sha>`) instead of
  letting a `checkout`/`reset`/`stash` read as hundreds of ordinary file
  changes. `kubic status` warns per move, `kubic log` lists the marker, and
  `kubic undo` refuses to restore entries from before the move without
  `--force` — their pre-move content does not belong on the moved HEAD.
  Entries journaled after the move undo normally.

`kubic log` answers "did anything bypass the tools?" with the count line above;
`kubic status` names it in the summary. `--json` keeps the raw entries (the
`unattributed` flag is on each entry there).

## `kubic journal prune [--session <id>] [--keep-days <n>] [--yes] [--json]`

Deletes journal entries older than the keep window from the journal `kubic
log` reads: `--session <id>`, else this workspace's journal (the same store
resolution as `kubic diff`, `undo`, `log` and `status`). **A dry run unless
`--yes`**: without it the command lists each entry it would prune (`would
prune <time> <op> <path>`) and deletes nothing.

| Option | Meaning |
| --- | --- |
| `--session <id>` | Prune that session's journal (or the `journal:<id>` ref `kubic run` prints). |
| `--keep-days <n>` | Keep entries younger than `n` days (a non-negative integer). Default: `[journal] retentionDays`, or `KUBIC_JOURNAL_RETENTION_DAYS`. |
| `--yes` | Delete the listed entries. |
| `--json` | Print one document `{session, root, keepDays, dryRun, pruned, candidates: [{timestamp, op, path}]}`; `candidates` is what the dry run would prune, or what `--yes` pruned. |

- **The keep window is never invented.** The window is `--keep-days` when
  given, else the resolved `[journal] retentionDays`: the
  `KUBIC_JOURNAL_RETENTION_DAYS` env var counts and beats the file key, and the
  flag beats both. With neither, the command exits 1 and names both ways to set
  one, plus the config error when the config did not load. `0` (either way)
  means retention is off: nothing is listed or deleted, exit 0. A window that
  is not a non-negative integer of days exits by where it came from:
  - `--keep-days 0.5`: exit 2, a usage error from the flag parser.
  - `retentionDays = 0.5` in a config file: the config loader accepts it, and
    prune exits 2.
  - `KUBIC_JOURNAL_RETENTION_DAYS=0.5`: the loader refuses the env value, so the
    config does not load and prune exits 1 with `the config did not load: …`
    naming the env var.
- **The checks run in this order, and the first failing one decides the exit.**
  (1) A window that is not a non-negative integer of days: exit 2. (2) An
  explicit `--session` that does not exist: exit 1 (`unknown session: <id>`), as
  `kubic cost --session` does, and nothing is created. (3) A session attached by
  a live pid (its session lock): exit 1 with one `error:` line, on a dry run too
  and for every window, `--keep-days 0` included. This is the rule `kubic undo`
  applies; the workspace journal has no session lock and is pruned directly.
  (4) No window at all: exit 1, naming both ways to set one. A zero window
  exits 0 and deletes nothing, after checks 2 and 3.
- **Deletion goes through the store's own retention pass**, which rewrites the
  index under its mutation lock. The report is what that pass removed: `pruned
  N entries, B reclaimed`, with `(M listed: the journal changed while pruning)`
  when the count differs from the M the dry run listed. A pass that removed
  nothing while entries were listed (the journal changed under it) exits 1 with
  `the journal changed while pruning and this run removed nothing — run it again
  to see what is left`.
- **Blob files.** `--yes` also sweeps the blob files no remaining entry
  references: leftovers from earlier passes, and content only the pruned
  entries used. The sweep runs only as part of a pass that drops entries, so
  with nothing to prune an orphan blob stays in place. Its bytes count in
  `reclaimed`; the dry run lists entries only and does not list the blobs.
- **Output.** Text mode prints the candidate lines and `dry run: N entries
  would be pruned (keep window D day(s)) — pass --yes to delete`, or
  `pruned N entries, B reclaimed` after `--yes`. It prints `nothing to prune`
  when no entry is older than the window.
- **Exit codes:** 0 for a dry run, a completed prune, or nothing to prune; 1
  for a missing keep window, a config the loader refused (such as
  `KUBIC_JOURNAL_RETENTION_DAYS=0.5`), an unknown session, a live-run refusal,
  or a pass that removed nothing; 2 for a usage error (a `--keep-days` that is
  not a non-negative integer of days, a file-configured window that is not one,
  an unknown option, or `kubic journal` without its subcommand).

```
kubic journal prune --keep-days 30
kubic journal prune --session 3f2a --keep-days 30 --yes
```

## `kubic models [provider] [--all] [--json] [--resolve <provider/id>]`

Catalog readout over Pi's **built-in providers** (the generated catalogue:
`anthropic`, `openai`, `google`, `amazon-bedrock`, `openrouter`, …) plus
`models.json` customs from `~/.kubic/models/models.json` (always) and the
project's `models.json` at the project root — the git top level or nearest
`.kubic/`, so any subdirectory sees the same providers — only once the
project is trusted (`KUBIC_TRUST_PROJECT=1`). Each file found is reported as an
`info: loaded models.json: <path> (global|project, trusted): …` /
`info: models.json ignored: <path> …` line on stderr (under `--json` too:
stdout stays one document) — untrusted, invalid
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
| (none) | Off a terminal: a `PROVIDER  MODEL  THINKING  IN $/1M  OUT $/1M` table (plain aligned columns), one row per model of every **usable** provider, then `info: <n> built-in providers not configured (set their env key): …` on stderr for the rest. On an interactive colour terminal: the catalogue view — a `MODEL  CONTEXT  THINKING  INPUT  IN $/1M  OUT $/1M  KEY` kit table grouped by provider, the default model marked `● <provider/id>  default` (the configured pin, else the model a run would pick), every provider with more than 8 models folded to its first 3 rows and a `<provider>/… N more  kubic models <provider>` line, one `○ N providers without a key  kubic models --all` line, the `keys: <provider> ← <source>` line, and `set a default: kubic setup`. With nothing usable, stdout stays empty and stderr says `info: no usable providers (set a built-in provider's env key, e.g. ANTHROPIC_API_KEY, or add models.json)`. Exits 0. |
| `[provider]` | List one provider in full (no folding), configured or not; `--json` is scoped to it too. An unknown provider is a usage error: `error: unknown provider "<id>"; did you mean '<id>'?` when one is close, else `error: unknown provider "<id>" (known: …)`, on stderr, exit 2. |
| `--all` | Include the providers without a configured key (their KEY cell reads `—`; off a terminal their rows join the plain table and the `not configured` note is dropped). |
| `--json` | Every registered provider, usable or not, as one pretty-printed JSON document: `id`, `name`, `source` (`built-in`, `testing` or the `models.json` path), `usable`, `auth` (the auth source Pi reported, when configured) and `models` (`id`, `name`, `contextWindow`, `thinking`, `inputCost`, `outputCost`, `cacheReadCost`, `cacheWriteCost`, `input` modalities; `contextWindow` is followed by `contextWindowDefaulted: true` on a `models.json` model that declares no window). A model on the fallback window is marked `(default — set contextWindow)` in the interactive catalogue and flagged in `--json`; piped output has no window column and shows no marker. Exits 0. |
| `--resolve <provider/id>` | Print `selected <provider>/<id> (thinking: …)` for any registered model, built-in or custom, configured or not; a resolution failure prints `error: …` on stderr and exits 1. |

**Default model.** `kubic run`/`kubic tui` with no `--model`, `[model]`,
`KUBIC_MODEL` or role pin take the first model of the first usable
provider: `models.json` customs first, then built-ins whose auth is
configured. A built-in with no key is never picked implicitly; with nothing
usable the run exits 6 (`provider_probe_failed`). Pin the model you mean,
e.g. `[model] provider = "anthropic"`, `id = "claude-sonnet-4-6"`.

Usage errors (unknown option, `--resolve` without a value, an unknown
provider) exit 2 on stderr. `--help`/`-h` prints the generated help and exits 0.

## `kubic setup`

Interactive first-run setup: from "installed" to "ready" in
under a minute.

1. **Provider** — the providers whose key is detected (the same detection
   `kubic models` and `kubic doctor` use: env keys, Bedrock/Vertex ambient
   credentials, `models.json` customs; the testing provider is never offered).
   One detected provider is confirmed as a step; several are a choice.
2. **Default model** — that provider's chat models, the current pin
   preselected, each with its context window and thinking support.
3. **Thinking level** — only for a model that supports thinking (`medium`
   preselected when supported).
4. **Trust** — when the current directory has a project layer
   (`.kubic/config.toml` or a project `models.json`) with no recorded
   decision, the same question `kubic tui` asks; the answer is recorded in
   the trust store.
5. **Save** — `[model] provider`, `id` and `thinking` go to
   `~/.kubic/config.toml`. An existing file is updated line by line: the
   three keys are replaced inside an existing `[model]` table (missing ones
   appended to it) or the table is appended; comments, other tables and
   CRLF line endings are kept. The write is atomic (write then rename).

A frozen enterprise `[model]` (`/etc/kubic/config.toml`) asks no model
question: the step names the pinned model and nothing is written. With no
provider key at all, setup names the variables to set (and `models.json`)
and exits **6** without writing. A cancelled question (Ctrl-C / Esc) writes
nothing and exits **130**. Off a terminal (stdin or stdout not a TTY) setup
refuses with `error: kubic setup is interactive: …` and the manual
alternative (`[model]` in `~/.kubic/config.toml` or `KUBIC_MODEL`), exit
**2**.

**First run.** A bare `kubic` on a terminal with no `~/.kubic/config.toml`,
no `KUBIC_MODEL`, not under `KUBIC_PROVIDER=faux` and without
`KUBIC_SKIP_SETUP=1` runs setup first, then opens the TUI on the model it
saved. Cancelling it still opens the TUI and leaves a comment-only
`~/.kubic/config.toml` (`# kubic setup was skipped …`) so the question is
not asked on every launch; `kubic setup` asks again any time. With no
provider key the first run exits 6 like `kubic setup`.

## `kubic config [--json] [--model <provider/id>] [--thinking <level>]`

The effective configuration with the layer each value came from — see
[configuration](configuration.md#seeing-the-effective-values). `--json`
prints one pretty-printed JSON document. `--model <provider/id>` reports
the config as if that session override were passed, so the `model.*` rows
and the `selected model:` line carry the `(cli)` source the `run`/`tui`
lane would use. `--thinking <level>` does the same for the thinking level:
the `thinking level:` line carries the `(cli)` source the lane boots with.
A refused config prints
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

## `kubic doctor [--skip <id[,id…]>]... [--json] [--verbose]`

Health readout — see [doctor and debug](doctor-and-debug.md).

| Flag | Meaning |
| --- | --- |
| `--skip <id[,id…]>` | Mark checks skipped (comma-separated, repeatable). An id that matches no check exits 2 (`error: unknown check "<id>"` on stderr); `--skip` without a value exits 2. |
| `--json` | Emit `{ok, exitCode, checks}` as one pretty-printed JSON document instead of human lines. Same exit code either way. |
| `--verbose` | On an interactive colour terminal, print every check in full instead of the grouped summary. Off a terminal the full report always prints. |

On an interactive colour terminal the default is a grouped summary.
See [doctor and debug](doctor-and-debug.md). The full report keeps the
`STATUS id (reason): detail` shape; on a colour terminal the status is
coloured (pass green, warn amber, fail red, skip grey). Unknown options exit 2. Full exit-code contract is on the
[exit-codes page](exit-codes.md).

## Analysis commands: shared rules

`eval`, `benchmark`, `replay`, `export`, `cost`, `policy` and `audit` are
parsed by commander
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
  `error: required option '--tool <name>' not specified`) and exits
  **2**. The command itself never runs.
- **stdout is data, stderr is diagnostics.** Reports, tables and JSON go
  to stdout. Refusals and warnings go to stderr, one `<level>: <message>`
  line each. A refusal is `error: <message>`, or
  `error: [<code>] <message>` when it has a code.
- **Tables.** `cost`, `audit` and `benchmark` print their rows as
  a table. On a colour terminal the table is the kit table (muted header, faint rule) with coloured
  headers. On a pipe, in CI, or with `NO_COLOR`, it is plain
  space-aligned columns.
- **`--json`.** stdout carries exactly one JSON document and nothing
  else, with no colour and no tables. Every document is indented with
  two spaces (the eval, benchmark, replay and export envelopes were
  single-line before the commander migration). `eval`, `benchmark`, `replay` and
  `export` put runtime failures inside their envelope. A bad invocation,
  which is a usage error, leaves stdout empty and prints its `error:`
  line on stderr.

## `kubic eval --suite <id> (--task <prompt> | --trajectory <file>) [--worktree <path>] [--size <size>] [--model <id>] [--workspace inline|worktree] [--thinking <level>] [--json]`

Scores one suite against a task prompt or an existing trajectory
export. Every record needs its provenance (`model`, `thinking`,
`worktree`) and a `--size`; a record missing any of them is refused with
exit 2 and is never stored. A suite is one case: a record's `caseId` is the
suite name.

- With `--task`, the provenance comes from the flags: `--worktree` is
  mandatory and `--model` defaults to `faux/echo`
  (the shipped testing provider's registered model).
- With `--trajectory`, the provenance comes from the export itself:
  `model` from `provenance.model`, `thinking` from `model.thinking`, and
  `worktree` from `provenance`. These flags become
  optional cross-checks. A flag that disagrees with the export is
  refused with exit 2 and `[provenance-mismatch]`, and no record is
  printed. The size is not part of an export, so `--size` stays
  mandatory; the determinism tier is derived from the path.

Exports written by earlier builds (schema 1.0 to 1.3) still parse, for
`replay`, `eval` and `export` alike. Keys the 1.0 contract no longer defines
are carried through unread, and an escalation recorded without its model
endpoints reads them as `null`.

Every record carries `suite`, `caseId`, `success`, `costUsd`, `tokens`,
`latencyMs`, `toolCalls`, `model`, `thinking`, `worktree`, `size` and
`determinism`. `determinism` is the tier,
derived from the path: `--trajectory` scores a recorded export without
re-executing anything → `recorded`; `--task` executes a model-backed
suite → `live`. Benchmark rows publish the same field (`live` — including
a skipped stub, which names the tier it would run at).

| Flag | Meaning |
| --- | --- |
| `--suite <id>` | **Required.** A built-in suite id — `swe-bench-mini`, `repo-mod-rename`, `bugfix-repro`, `refactor-extract`, `testgen-cover`, `review-diff` or `agentic-live` — or a **category alias** (`swe`, `repo-mod`, `bugfix`, `refactor`, `testgen`, `review`, `agentic`); `kubic eval` scores one record, so a category with more than one suite exits 2 (`ambiguous-suite`). `terminal-live` is a stub and refuses with exit 2. An unknown selector exits 2. |
| `--task <prompt>` | Runs the suite's fixture through the real lane and scores the trajectory it writes: the fixture's prompt is the run, its gate command(s) decide the verdict, and the record carries the eval fields. Needs a reachable model (`--model`, default `faux/echo`) and `--worktree`; the suite's fixture is materialized in a temp directory (or a fresh checkout, with `--workspace worktree`). |
| `--trajectory <file>` | Scores an existing trajectory export file, without re-running anything: the same file form `replay` and `export` take. `-` reads the export from stdin; a value starting with `{`/`[` is the pre inline-JSON form and still works. Fully live: exits 0 with the record, or 1 when the gates fail it. An unreadable file exits 2 (`trajectory-unreadable`), a file that is not JSON or not a valid export exits 2 (`trajectory-malformed`). |
| `--worktree <path>` | The worktree the run executes in (`--workspace worktree` needs it clean). With `--task`, a record without it is refused with exit 2. With `--trajectory` it is read from `provenance.worktree`; a different value exits 2 (`provenance-mismatch`). |
| `--size <smoke\|standard\|extended>` | The record's size class (how much was run) — an implementation-side label, not a tier. Published on every record; a missing or unknown size exits 2 on both paths. |
| `--model <id>` | `provider/id` of the run. With `--task` it defaults to `faux/echo`. With `--trajectory` it is read from `provenance.model`, and a different value exits 2 (`provenance-mismatch`). |
| `--workspace inline\|worktree` | `inline` (default) materializes the suite fixture in a temp directory. `worktree` refuses with exit 2 unless `git status --porcelain` in `--worktree` is clean, then runs each suite in a fresh detached checkout of that repo at its HEAD (`git worktree add --detach`), removed and pruned afterwards. Any other value exits 2. |
| `--thinking <level>` | With `--task`, recorded on the record verbatim (default none). With `--trajectory` it is read from `model.thinking`, and a different value exits 2 (`provenance-mismatch`). |
| `--json` | Prints one JSON envelope (`ok`, `exitCode`, and either `record` or `error`) instead of the text line. The exit code is the same either way. |

Text mode prints one `eval ok: suite …` line on stdout. A refusal prints
`error: [<code>] <message>` on stderr.

## `kubic benchmark [--suite <id>] [--worktree <path>] [--size <size>] [--model <id>] [--workspace inline|worktree] [--thinking <level>] [--json]`

Runs the reproducible matrix: every suite, or a single one with
`--suite`. The output is a `SUITE / CATEGORY / STATUS` table followed by
the verdict line: `benchmark ok|FAILED: <passed>/<executed> suites passed,
<n> stub(s) skipped`.

Stub suites show as `skipped (stub)` with `success:false`, so they are
never reported as passing work, and they never count toward the verdict.
Provenance (`--size`, `--worktree`) is validated once
before the matrix, so even a stub-only selection cannot skip it. A matrix
with **no executable suite** (only stubs selected) refuses with
`error: [no-executable-suites] benchmark: no executable suites selected`
and exit 2 — it never reports `benchmark ok` over zero evidence. The exit
code is:

- 0 if every executed suite succeeded
- 1 if any executed suite failed
- 2 on usage errors: an unknown suite, missing provenance, a dirty
  `--workspace worktree`, a stub-only selection
  (`no-executable-suites`), or a stub suite (the live-PTY
  `terminal-live`, `stub-suite`)

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
| `... --tier deterministic --model <provider/id> --lockfile <file>` | Re-executes the recorded objective through the lane at the pinned model. Refuses with exit 2 unless both pins are given. A pin that is not registered exits 6 (`provider_probe_failed`); a model the lockfile does not pin refuses with `lockfile-mismatch` (exit 2). |
| `... --tier live --role-config <file>` | Re-executes at the recorded model under the pinned role config — a JSON file `{"role": "<name>"}`. The role document `.kubic/roles/<name>.md` is loaded from the pinned worktree, so its tools and prompt apply. Refuses with exit 2 without the role config. `--model` and `--lockfile` are refused under live. |
| `... --diff-against other.json` | Recorded compare: names the variables that changed (`model`, `worktree`, `diff`). Any difference exits 1 as the regression signal; identical trajectories exit 0. |

- **Worktree pin.** The re-execution lane is rooted at the pinned
  worktree — the `--worktree` override, or the trajectory's recorded
  `worktree.path` when that path exists on this machine — so the lane's
  tools, journal, role document and project `models.json` resolve there.
  A recorded worktree absent on this machine falls back to the working
  directory; `--worktree` is existence-checked before the run, so an
  explicit override never falls back silently.
- **Lockfile pins.** `--lockfile <file>` is JSON:

  ```json
  {
    "models": { "provider/id": { "digest": "sha256:…" } },
    "prompt": { "digest": "sha256:<hex>" },
    "tools":  { "digest": "sha256:<hex>" }
  }
  ```

  `models` may also key a provider to its pinned ids
  (`{ "provider": ["id", …] }`). The requested `--model` must be pinned
  there, or the run refuses with `lockfile-mismatch` (exit 2) — an
  unpinned model is never silently re-executed. The optional `prompt` and
  `tools` digests are verified against the trajectory being replayed (its
  objective text, and the sorted distinct tools its actions used); a
  mismatch is the same named refusal, and a malformed pin is
  `lockfile-invalid` (exit 2).
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
- **Exit codes** are the subset 0/1/2/5/6 (see
  [exit codes](exit-codes.md)).

The re-execution tiers read the effective config the same way
`kubic run` does: the configured permission classes and journal
retention govern the re-executed lane, and so does the enterprise
`[policy]` — a re-execution model outside `allowed_models`/
`allowed_providers` exits 6 with the named policy refusal before any
provider call, and the re-executed lane's tools are the same allow/deny
intersection. A refused config exits 1 with the config's named reason
instead of running on defaults.

The refusal check applies to the whole command, not to individual tiers.
A refused config also blocks the log-only tiers (`recorded` and
`compare`): the command exits 1 before any tier runs, so the config has
to be fixed first.

## `kubic export (--trajectory <file> | --session <id> | --dataset <dir|glob>) [--type sft|dpo|grpo|preference|tooluse|coding] [--against <other.json>] [--out <file.jsonl>] [--json]`

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
- the runs cross a worktree or task-role boundary (`cross-boundary-excluded`)

An excluded pair prints `excluded: <tag> — <reason>` and exits 0; it
never produces a training record. A DPO record carries both sides'
`taskRef` and `roleRef`, and a hand-built record whose task refs differ fails
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

### Batch mode: `--dataset <dir|glob> --type <t> --out <file.jsonl>`

One directory (every `.json` it holds) or a basename glob (`traj/*.json`)
of trajectory exports in, one JSONL of dataset records out, plus a
manifest beside it (`<out>.manifest.json`). `--dataset` needs both
`--type` and `--out`, and refuses `--trajectory`/`--against` (those
belong to single-file mode).

Pairing and grouping are automatic, and the same eligibility policy the
single-file builders enforce applies:

- `dpo` and `preference`: every pass×fail combination within one task id
  *and* prompt — env failures, cross-boundary runs, missing preference
  signals and prompt/task mismatches are excluded, never emitted.
- `grpo`: one group per task id + prompt holding **every** candidate
  (not capped at two).
- `sft`, `tooluse`, `coding`: one record per trajectory.

Files are read one at a time and each record is appended as it is built,
so memory is bounded by one task group, not the dataset size. The output
order is deterministic (sorted files, sorted groups).

The manifest carries the schema version (`dataset/1`), the input count,
the record count, exclusions **by tag** (`env-failure-excluded`,
`cross-boundary-excluded`, `no-preference-signal-excluded`,
`prompt-mismatch-excluded`, `no-counterpart-excluded`,
`singleton-excluded`) with a file/tag/reason row each, and a provenance
summary (distinct sessions, worktrees and models). Text mode
prints one `dataset: …` summary line; `--json` wraps the manifest in
`{ok, exitCode, type, dataset, out, manifest}`.

Exit codes: 0 exported; 1 a matched trajectory failed to parse or build
(`dataset-invalid`, the file is named), or the JSONL/manifest could not be
written (`export-failed`); 2 a usage error or an empty match
(`dataset-empty`). The JSONL is truncated before the first record and the
manifest is written last, so a failed batch leaves a partial JSONL and no
`<out>.manifest.json` — the missing manifest is the completeness marker.

## `kubic cost [--session <id>] [--all] [--by <level>] [--json]`

Reads real usage out of the durable session store, scoped to the current
project by default: only sessions touching the invoking workspace are
reported, with `--all` for the machine-global total the command prints. The unit is the session: rows aggregate to the `--by` level
(`request | session | project`, default `session`), one `GROUP / MODEL / IN
/ OUT / CACHE-R / CACHE-W / COST` row each — a session that ran more than one
model reads as one row per model, with input, output and prefix-cache
counters split out — followed by
`task total $<sum> (<n> <level>)`. The total is exactly the sum of the
rows. Costs below $1 print at 4 decimals (`$0.0023`), $1 and above at 2.

The numbers are the sessions' `pi.usage` documents, so they match what
`Harness.usage()` reports for the same run. Reading is read-only and never
boots a lane. `--by request` lists one row per assistant entry that
carries its response's usage (the model spend of that request — tools that
report their own spend aggregate at the higher levels); `--by project`
rolls each workspace to a single row. A session whose storage a live run
owns is skipped, never opened (pi-durable: one process per storage), and
reported as a zero row with `MODEL` `(locked)`; a session that cannot be
read at all (a half-written directory) is `(unreadable)` the same way. A session that goes live *during* the read —
after the lock probe said it was dead — is read as far as it can be (a
partial trailing record is the writer's uncommitted tail and is skipped,
never a parse error) and gets a zero `(live)` row beside its rows: the
sibling rows may be partial. A session the operator NAMED with `--session`
is never skipped that way: an unknown id and a live lock each print their
refusal and exit 1. The read path is lock-free: `kubic cost` never
creates or removes `lock.json`, so session dir mtimes (the prune age
signal) are untouched and a concurrent attach is never blocked.

When the sessions carry prefix-cache counters, the readout adds the
cache line and the transparent-caching note. With no sessions stored it
prints `no cost rows` and exits 0.

| Flag | Meaning |
| --- | --- |
| `--session <id>` | Reads only this session. Ids follow the same `[A-Za-z0-9_-]` rule as `run`: anything else exits 2 before the store is touched, and an unknown session exits 1 (`error: unknown session: <id>`). An explicitly named session ignores the project scope. |
| `--all` | Lifts the default project scope: report sessions from every project on the machine. |
| `--by <level>` | Group rows at `request`, `session` (the default) or `project`. Anything else exits 2. |
| `--json` | Prints the in-code `toCostJson` shape (`rows`, `taskTotal`) field-for-field — rows carry the same `session`/`project`/`request` identity the table groups on. Exits 0. Pre-release change: the array was named `agents` before this change; Kubic has no published JSON contract yet, so the rename is not a versioned break. |

## `kubic policy --tool <name> [--json]`

Answers a policy query as a routing offer, never as enforcement. It
prints `allow <tool>` or `deny <tool>` for the tool policy that a run
from this directory actually installs: the same permission classes, from
the same config load, that `kubic run` enforces and that `kubic doctor`
reports on its `policy:installed` line.

Policy is deny-by-default: a tool outside the installed allowlist is
denied. Tool names match regardless of case and surrounding whitespace.

Unsupported levels are named, never silent: for each
installed permission level the tool set cannot express (network or
credentials `allowlist`, filesystem or git `full`) the command writes one
`warn: <class> '<level>' is unsupported — enforced as '<level>': <reason>`
line to stderr. `kubic doctor` names the same set on its
`policy:installed` line, which is then `WARN (unsupported-level)`.

| Flag | Meaning |
| --- | --- |
| `--tool <name>` | **Required.** The tool to query. A missing or whitespace-only name exits 2. |
| `--json` | Prints `{"tool", "decision"}` instead of the text line, plus `unsupported` (`[{class, level, enforcedAs, reason}]`) when any installed level is unsupported. Exits 0. |

## `kubic audit [--posture <p>] [--result <r>] [--session <id>] [--json]`

Queries the audit trail, matching each supplied filter exactly. `--session`
reads one session's rows (`agent.session` is the session).

**Output.** Text mode prints a table with the columns `WHEN`, `POSTURE`,
`RESULT`, `WHAT`, `PERMISSION`, `APPROVAL` and `REASON`. With no matching
records it prints `no audit records` and exits 0. `--json` prints the full
records: the 13 fields plus `version`, which is `1`. A ledger that exists but
cannot be read (permission denied, I/O error) is not an empty trail: the
command prints `error: cannot read the audit ledger <path>: …` on stderr and
exits 1. Only a missing ledger reads as empty. A ledger line that is a record
of another version, or has no `version`, makes the whole ledger unreadable
with the same error (`line <n> is not a version 1 audit record`); the ledger
is not converted or rewritten, so move it aside to start a new trail. A run
whose ledger is unreadable still writes its `trajectory.json`, with no
approvals in it, after naming the ledger on its warning channel.

**Redaction.** Every record is redacted before it is printed:
secret-shaped values and listed-secret inventory values become
`[redacted-secret]`, so credentials only ever appear as sentinels.

**Where records come from.** There is one ledger per repository,
`<repo>/.kubic/audit/audit.jsonl`, one record per line. `<repo>` is the
main checkout: from a subdirectory or from a linked worktree, every writer
and `kubic audit` resolve the same file (the parent of git's common dir;
outside git, the current directory). The shipped runtime ignore rules cover
this file.

- `kubic run` and `kubic tui` append one record per resolved approval ask,
  approved or denied, with `posture` `approvals` or `full-access`. An
  untriggered call raises no ask and writes nothing; a call full access
  waives is recorded once per capability it raised
  (`trigger:<capability>`, posture `full-access`), so the trail names what
  ran unapproved instead of one opaque `trigger:full-access` row per tool
  call. A run from `<repo>/sub` writes the repo ledger, never
  `<repo>/sub/.kubic/`.
- The model on every record is the model the lane runs: `kubic run` reads
  it after the stored-model rule (`--session` without a pin keeps the
  session's own model, and both the record and `trajectory.json` say so).
  `model.thinking` is the thinking level the lane runs, read from the
  conversation's agent document (a `/thinking` change mid-session is read
  at record time, so later rows name the new level).
- `process.pid` names the process that made the decision.
- `workspace.base` is the base revision the run started from: `HEAD` at
  run start, `none` outside git. A row that genuinely knows no better keeps
  the honest `unknown` instead of inventing a value.
- Enabling full access (`--dangerously-skip-approvals` on `kubic`, `tui`,
  `run` or `sessions create`, or the in-session `Alt+A` / `/approvals on`
  toggle) appends one `posture:full-access` row naming the session and the
  command; turning it back off (`Alt+A` again, or `/approvals off`) appends
  one `posture:approvals` row, so the ledger carries the posture history in
  order. A flip that would change nothing (the direction is already in
  force) is reported on the footer and writes no row. A `posture.json`
  change made during a session by anything else is refused and recorded
  once as `posture:changed-mid-session`.
- A failed ledger write never changes the decision.

| Flag | Meaning |
| --- | --- |
| `--posture <name>` | Filters on posture. |
| `--result <ok\|deny\|error>` | Filters on result. Any other value exits 2. |
| `--session <id>` | Filters on one session's rows. A whitespace-only value exits 2. |
| `--json` | Prints the matching records as a JSON array, with the same redaction. Exits 0. |

Back to the [docs index](../README.md). See also
[exit codes](exit-codes.md), [configuration](configuration.md), and
[doctor and debug](doctor-and-debug.md).
