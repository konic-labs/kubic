# Configuration

> Design ref: §33–§36 config/secrets; §58 enterprise policy. Implementation:
> `packages/host/src/config/config.ts` (layers, TOML, merge),
> `runtime.ts` (the load the binary actually runs on), `config-cli.ts`
> (`kubic config`), `secrets.ts` (request-time secrets), `stances.ts`
> (refusals), `../host/src/policy/enterprise.ts` (the `[policy]` engine).
> This table matches that implementation exactly.

## Precedence: first layer wins

Seven layers, highest first, then the documented environment overrides, then
an explicit CLI flag. Merge is per leaf path: the first (highest) layer to
set a key owns it — a lower layer attempting to override a set key is
reported in `overriddenAttempts`, never applied. Enterprise keys are frozen
against every override attempt, the environment and the CLI included.

| # | Layer | Source file | Notes |
| --- | --- | --- | --- |
| 1 | `enterprise` | `/etc/kubic/config.toml` (or an explicit `enterprisePath` override) | Highest. Never overridden — by a file, the environment, or a flag. |
| 2 | `product` | `/etc/kubic/product.toml` (or an explicit `productPath` override) | The distribution/vertical profile, below enterprise and above the user's own files. |
| 3 | `global` | `~/.kubic/config.toml` | Your machine-wide defaults. |
| 4 | `project` | `<projectRoot>/.kubic/config.toml` | Resolved as the nearest ancestor holding `.kubic/` (or the git top level), the cwd itself outside a repository — so `kubic config` and `kubic run --role` from a subdirectory read the same committed project as from the root (issue #229). **Trust-gated**: refused by path before it is read (`ProjectUntrustedError`) until the project is trusted (`kubic trust`, the `kubic tui` prompt, or `KUBIC_TRUST_PROJECT=1` for one invocation) — the grant is recorded at, and checked against, that same root, so trusting the root covers runs from its subdirectories; absent file counts as an empty layer. |
| 5 | `workspace` | `<workspaceRoot>/.kubic/config.toml` | Only when a workspace root is set — otherwise the layer does not exist. **Not yet populated (issue #229)**: no shipped caller sets a workspace root (orchestrator worktree roots are not wired in), so this layer never exists today; recorded in [design drift](../design-drift.md). |
| 6 | `session` | Supplied programmatically | Never a file. **Not yet populated (issue #229)**: no shipped caller supplies a session layer (attaching a session does not feed its recorded settings back), so this layer is always empty; recorded in [design drift](../design-drift.md). |
| 7 | `agent` | Supplied programmatically | Never a file. Lowest. **Not yet populated (issue #229)**: no shipped caller supplies an agent layer, so this layer is always empty; recorded in [design drift](../design-drift.md). |
| — | `env` | The `KUBIC_*` overrides below | Above every file layer, below `enterprise`, below the CLI. |
| — | `cli` | e.g. `--model`, `--thinking` | Highest, except against a frozen `enterprise` key. |

The `cli` flags are `--model <provider/id>` (issue #227) and
`--thinking <level>` (issue #225), accepted by `kubic run`, `kubic tui`
and `kubic config`: they are the §38.1/§38.3 session overrides, above the
`KUBIC_MODEL`/`KUBIC_MODEL_THINKING` variables and every file layer, and
still below a frozen `enterprise` key. Each flag is an input to the one
config load, so `kubic config --model <provider/id>` shows the same
`(cli)` source the `run`/`tui` lane boots with; `kubic tui` reads the pin
from that load and never patches the flag over it afterwards, so a frozen
enterprise `[model]` holds there exactly as it does for `kubic run`.
A frozen enterprise `model.thinking` refuses `--thinking` by name and
ignores the env override; the lane then applies the remaining precedence
(session record > role default > file default) and clamps to the model.

A frozen enterprise `[model]` drops a `--model` or `KUBIC_MODEL` pin — but
never silently: `kubic run`, `kubic tui` and `kubic orchestrate` print one
note per overridden pin on stderr at boot (`note: --model evil/other
ignored: model pinned by enterprise policy (corp/approved)`, and
`note: KUBIC_MODEL=evil/other ignored: …` for the env pin), and `kubic
config` lists the attempt under `overriddenAttempts`. The note is stderr
only, so a `--json` envelope stays one document, and a pin equal to the
enterprise one says nothing. The freeze binds the whole session, not only the
boot: the TUI's `/model` (the same session-override level as `--model`, §38.1)
cannot leave a frozen pin, and every `kubic orchestrate` worker runs the
enterprise model — the manager injects no role-default pin, strips the
operator's `KUBIC_MODEL` from the child env, and names the enterprise model's
provider in the credential preflight. A refusal of an unknown provider/model names
the input that carried the pin: `--model`, `KUBIC_MODEL`, `[model] in
<layer> config`, or `role model`.

### Project trust

A project-local `config.toml` (and the project `models.json`) is
configuration the repository controls, so it is gated: an untrusted
project `config.toml` is **refused by path before it is read** — never
half-applied — with the remedies named in the refusal:

- `kubic trust` records a durable grant for the current directory (or an
explicit `[path]`); `kubic trust --revoke` removes the decision and the
refusal comes back; `kubic trust --list` prints every recorded decision.
- On `kubic tui` — and a bare interactive `kubic` — a present, undecided
project config prompts once before the lane boots. Accepting or declining
is recorded under `~/.kubic/`, so the next invocation does not ask again;
a cancelled prompt records nothing and fails closed.
- `KUBIC_TRUST_PROJECT=1` accepts the project layer for one invocation,
above the persistent store, and records nothing.

Trust is exact-path: a decision names the tree its files live in and never
applies to a parent or sibling directory (`/a` does not trust `/a-sibling`,
and a grant for `/a/b` never unlocks `/a`'s committed files). Consumers that
walk up to the repository root — the project `models.json`, project skills —
check the store for the directory they resolved, so a grant for the root
still applies from a subdirectory. A symlinked path is the same decision as
its target. `kubic doctor`'s `config-load` check names the
trust state and where it came from. Full detail — the store file, its
concurrency posture and every message — is on
[project trust](trust.md).

### Environment overrides

| Variable | Effect |
| --- | --- |
| `KUBIC_MODEL` | `provider/id` model pin (same precedence as the file key, one step higher). |
| `KUBIC_MODEL_THINKING` | Thinking level for the selected model (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Below `--thinking`, above `[model].thinking`, below the session's stored level and a frozen enterprise key (which ignores it and reports the attempt in `overriddenAttempts`); the lane clamps it to the effective model with a named notice. Malformed values fail the config load by name — `kubic config` included. |
| `KUBIC_APPROVALS_ROUTE` | `ask-user` or `deny`. |
| `KUBIC_JOURNAL_RETENTION_DAYS` | Journal age bound, in days (non-negative integer). |
| `KUBIC_TRUST_PROJECT` | `1`/`true` accepts the project layer — `config.toml` and the project [`models.json`](#modelsjson) — for this invocation, above the persistent store and without recording anything. |

A malformed value fails closed with the variable named — it never silently
falls back to a default.

`KUBIC_PROVIDER` is not a config key: `KUBIC_PROVIDER=faux` selects the
scripted **testing** provider for one invocation (no network, no model),
and any other non-empty value is refused by name — see
[the testing provider](commands.md#testing-provider-kubic_providerfaux).

### `KUBIC_BUDGET`: the per-run budget (issue #208, §71)

Every `kubic run` reads `KUBIC_BUDGET`, a JSON object, and enforces it for that
run. It is how `kubic orchestrate --budget` reaches each worker child: the
manager writes the resolved spec into the child's environment (and clears it
when the worker has no budget, so an ambient value in the manager's own
environment never leaks into a child the manager did not budget). It is not a
config key and has no file-layer form; export it yourself to budget one solo
run.

```sh
KUBIC_BUDGET='{"maxToolCalls":20,"maxTokens":200000,"maxCostUsd":1.5}' kubic run -p "…"
```

| Key | Effect |
| --- | --- |
| `maxToolCalls` | Every tool attempt counts, including one a policy guard then blocks; the attempt past the cap is blocked. |
| `maxTokens` | Input plus output tokens across the run (cache reads/writes are not counted). |
| `maxCostUsd` | Priced spend across the run. |
| `maxRuntimeMs` | Accepted and validated, but not enforced by a plain run: wall clock belongs to the orchestrator manager's watchdog, and it is never written into a worker's `KUBIC_BUDGET`. |

Every value must be a positive finite number (`retryBudget` is an object with
`maxAttempts` and `maxCostUsd`; it is accepted and validated but not counted
by a plain run, like `maxRuntimeMs`). A malformed value — invalid JSON, a
non-object, an unknown key (a typo such as `maxToolcalls` would otherwise run
with no limit), a non-positive number — fails closed as a usage error (exit 2)
naming `KUBIC_BUDGET`, never a silently dropped limit; empty or unset means no
budget. A run that reaches a limit ends `budget_exhausted` (exit 3) naming the
dimension (`limit=toolCalls|tokens|cost`).

### The `bash` tool: timeouts and background jobs

The agent's `bash` tool runs each command in its own process group with
stdin closed (`/dev/null`). A command that reads stdin (`cat`, `read -p`, a
REPL, `npm init`, a hook that reads stdin) sees end-of-input at once and
never blocks the turn. There is no interactive terminal (PTY) or job
control.

The tool settles when the command's own shell exits, after a short drain
(150 ms) for output that is still in the pipes. Anything the command
backgrounded (`npm run dev &`, `sleep 30 >/dev/null &`) is **killed with
the group** by default: SIGTERM, then SIGKILL after a 2 s grace. The result
says so with a `background: "killed"` field and a `[kubic: background
processes …]` line on stderr, so nothing started by a tool outlives Kubic
unannounced. A command killed by a signal reports `128 + signal`
(`kill -9 $$` → `137`), the shell convention.

Every command has a timeout, even when the model gives none:

| Variable | Effect |
| --- | --- |
| `KUBIC_BASH_TIMEOUT` | Timeout in seconds when the model supplies none (default `120`; capped at the maximum). |
| `KUBIC_BASH_MAX_TIMEOUT` | Upper bound on any bash timeout in seconds, the model's included (default `600`). |
| `KUBIC_BASH_KEEP_BACKGROUND` | `1`/`true` leaves background jobs running, detached (`background: "detached"`); they outlive Kubic. `0`/`false` or unset kills them. |

These are read by the process that runs the tool. A malformed value fails
the bash call with the variable named.

### Seeing the effective values

`kubic config` prints every value that is set, with the layer it came from,
plus the projections the run consumes (selected model, thinking level,
approvals, permissions, journal retention and out-of-scope paths, modes,
budgets).
`kubic config --json` emits
the same thing as one object — `values`: `{ key, value, layer }` per set
key, and one object per projection. A broken config (unknown key, refused
project layer, `[budgets]`, a secret ref) exits 1 with the named reason
instead of printing defaults. The commands that consume the config (`run`,
`orchestrate`, `tui` — including `attach` and `resume`, which boot the same
lane — `replay`, `clean`, `policy`, `eval`, `benchmark`) refuse a broken
config the same way: one `error: <reason>` line on stderr, exit 1, stdout
empty (so a `--json` consumer never parses the refusal as data). `clean`
refuses because it reads the configured worktree root, and `policy` refuses
because it reports the posture a run would actually enforce — answering
from built-in defaults would be more permissive than what you configured.
`kubic config --help` (or `-h`) prints the generated help and exits 0
without loading anything; an unknown flag prints one `error: …` line on
stderr and exits 2.

A refusal also stops every other command that reads the config: `kubic run`,
`kubic orchestrate`, `kubic tui` (including `attach`/`resume`), `kubic replay`,
`kubic clean`, `kubic policy`, `kubic eval` and `kubic benchmark` exit 1 with
the named reason rather than proceeding on built-in defaults while you
believe your config file is in force. `kubic config`, `kubic doctor` and
`kubic trust` still run, so you can see what is wrong (doctor reports the
load as `dep:config-load (deps-missing)`).
Commands that consume no config projection (`git`, `diff`, `cost`, `perf`,
`audit`, `workers`, `export`, …) are unaffected. `kubic models` reads only
the trust report, which exists independently of the load, so it is
unaffected too. `kubic sessions` reads exactly one projection —
`session.retentionDays`, the default keep-window for `kubic sessions prune`
— and `kubic log` reads the same key to self-heal session journals at read
time; a refused config simply leaves both without a window: prune then
demands an explicit `--keep-days` rather than falling back to a default
(deletion stays explicit either way), and `log` writes nothing.

A minimal `.kubic/config.toml` that actually changes behaviour — this exact
block is parsed and loaded by `config-docs.test.ts`, so the page can never
drift from the parser:

```toml
[model]
provider = "local"
id = "llama3"
thinking = "medium"

[approvals]
route = "ask-user"
maxPendingMs = 30000

[permissions]
filesystem = "workspace-write"
shell = true
network = "none"

[journal]
retentionDays = 30
maxBytes = 1048576
outOfScope = ["dist", "coverage"]
```

`outOfScope` entries are plain workspace-relative paths, not patterns, and an
entry excludes the path itself **and everything under it**: `["dist"]`
excludes `dist/`, `dist/a.js` and `dist/sub/b.js`, and never a sibling that
merely shares the prefix (`dist-x`). Path-boundary aware, applied identically
to the §42.5 boot baseline and the end-of-run sweep — a build or formatter
that touches a declared path produces no unattributed journal entry. Patterns
and negations belong in `.gitignore` — the walk honours the root's rules and
every nested file's, child rules after the parent's (issue #116); `.git/` and
`.kubic/` are hard-skipped before any config. An empty entry (`[""]`) is
refused by name — it would match nothing.

## Shape (canonical sections)

`[agent]` name/systemPromptFile · `[model]` provider/id/thinking (`off`, `minimal`,
`low`, `medium`, `high`, `xhigh`, `max`) + timeoutMs/maxRetries/maxRetryDelayMs/cacheRetention (§37.4) + escalate/maxEscalations (§38.4) · `[modes]` solo/orchestrator ·
`[approvals]` route (`ask-user` or `deny`), maxPendingMs, autoApprove,
sessionScoped, requireJustification · `[permissions]` filesystem
(`none`, `read`, `workspace-write`, `full`), shell (boolean or
`read-only-allowlist`), network (`none`, `allowlist`, `full`), git
(boolean, `workspace`, `full`), credentials (`none`, `allowlist`) — four
of these cannot be expressed by the tool set and are reported as
unsupported by `kubic doctor` and `kubic policy`, enforced as the named
narrower level (§40.2, issue #166): network `allowlist` → `none` (no domain
list exists, so every network command is blocked and raises the network
approval trigger), credentials `allowlist` → `none` (no credential list
exists, so every access to a listed credential path raises the credential
trigger — issue #275), filesystem `full` → `workspace-write`, git
`full` → `workspace` ·
`[journal]` retentionDays/maxBytes/outOfScope · `[roles.<name>]` model/tools/thinking/timeoutMs/maxRetries/maxRetryDelayMs/cacheRetention/models ·
`[orchestrator]` root/maxWorkers/manager · `[ui]` theme (a built-in name or a JSON
theme path, §16.9) /statusBar ·
`[session]` store/dir/retentionDays/autoCompact/reserveTokens/keepRecentTokens · `[policy]` (the §58 enterprise policy,
below) · `[[audit]]` (sink/level, below). The canonical example is
`packages/host/src/config/example.toml` (pinned by test — copy it to
start). Unknown sections or keys are rejected (`ConfigError`).

Plus one top-level key (issue #237, §29.2): `skills = ["...", ...]` —
files or directories of skills, loaded with source `settings` (see
[Settings skills](#settings-skills-skills-292) below). It is a key, not a
`[skills]` section: a `[skills]` table is rejected like any unknown section.

Every one of those keys is in the key-effect table below: **consumed** keys
name the code path that reads them, **kept** keys are reserved with the
reason they are not consumed, and a key with no row at all fails `kubic
doctor`'s config check by name. `kubic config` prints the disposition of
every effective value (`(project, consumed)`), so a config file can never
quietly stop configuring anything.

| Key | Effect |
| --- | --- |
| `model.provider`, `model.id` | Selects the provider/model for `kubic run` and `kubic tui` (`selectModel`); `--model` and `KUBIC_MODEL` beat it as the `cli`/`env` layers of the config load, and a frozen enterprise `[model]` beats all of them (announced on stderr). |
| `model.escalate`, `model.maxEscalations`, `roles.<name>.escalate` | The escalation ladder (§38.4, issue #210): `escalate` lists the rungs as concrete `provider/id` refs in climbing order (wildcards refused per entry at load); a role's `escalate` wins outright for runs as that role, even an empty list (which freezes every `/model` switch — opting out of climbing, not of the gate). `maxEscalations` bounds the climbs per run, unset meaning the ladder length. Climbs are one-way (a down-step or off-ladder target is refused by name with the live model untouched) and recorded: `/model <ref>` climbs the ladder silently, `/escalate <ref> [reason]` climbs naming why, and three consecutive tool-failure turns climb one rung automatically — once per run, never back (`kubic run` settles one turn per invocation, so the automatic trigger lives on the `kubic tui` lane). Every climb appends an `escalation: <from> → <to> (<reason>)` transcript row and lands on the trajectory's `model.escalations` (per-model usage already attributes the spend each side of the move). |
| `model.thinking` | The file-layer thinking default. The lane boots with the winner of `--thinking` > `KUBIC_MODEL_THINKING` > session record > role default > this key, clamped to the effective model's supported levels (a clamp is one stderr notice naming the model, the request and the level applied, never a silent rewrite); the applied level is committed to the session and recorded in `trajectory.json`. A level the vocabulary does not know is refused by name at load. |
| `modes.solo`, `modes.orchestrator` | Selects the session mode. `orchestrator = true` starts `kubic tui` (and a bare interactive `kubic`) in orchestrator mode, where each submitted prompt drives the manager lane `kubic orchestrate` runs; `solo = true` keeps the solo default. The `--orchestrator` flag beats the key, and both `true` is refused by name. The key is the default for a session that was never switched: the in-session toggle (`Ctrl-G`) is persisted with the session (`<session>/mode.json`, issue #276) and a reattach restores it over the key; outside a git repository a saved orchestrator mode starts solo with a `warning:` line. |
| `approvals.route` | Approval routing (`ask-user` \| `deny`), installed by `kubic run`, `kubic tui`, `kubic replay` and reported by doctor's `policy:installed` line. `deny` refuses every challenged call with `denied by policy route` (exit 4) and never opens the TUI overlay — `autoApprove` entries never apply under it (the lane denies them too, and doctor fails `policy:approvals` for the combination). `KUBIC_APPROVALS_ROUTE` overrides it. |
| `approvals.maxPendingMs`, `autoApprove`, `sessionScoped`, `requireJustification` | Installed on the solo lane (`run`, `tui`, `replay`) from the same projection doctor prints, so `policy:approvals` and `policy:installed` always show the same route and bound (doctor fails `policy-mismatch` if they ever differ). `maxPendingMs` bounds the TUI overlay: an unanswered ask denies on timeout. `autoApprove` is explicit-only and applies headless too (the audit record says `approved by autoApprove`), except for an always-ask capability (`kubic-state-write`): naming it is accepted but ignored — it takes the normal ask path (the TUI seat, or the instant no-surface refusal headless, never a `maxPendingMs` stall), `kubic doctor`'s `policy:approvals` line warns by name and `kubic config` counts it as not auto-approved. `requireJustification = true` denies any approval that carries no justification (the TUI overlay and `autoApprove` supply none, so every challenged call is refused). `sessionScoped = false` is refused by the config load: decisions are always stored per session. Only real answers (user, route, autoApprove) persist to `approvals.json` — a timeout denies the call but stores nothing, so a later surface can still ask about the same operation. The same bound is the orchestrator's worker-ask bound and its interactive merge gate (issue #130): an unanswered ask denies closed on elapse, naming the bound. Each worker child waits a little less than the manager (a tenth of the bound, at most 5 s, less), so the child denies with its own status first. |
| `permissions.*` | Permission classes → the lane's derived tool allowlist (§40). `shell = "read-only-allowlist"` (issue #161, §12.1) keeps `bash` but enforces an explicit read-only command allowlist at the guard: every `|`/`||`/`&&`/`;`/`&`/newline segment must head with `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `find` or `git`, and then only in its read-only form — `git status`/`diff`/`log`/`show` (after global options like `-C`/`--no-pager`, without `--output`, and never `-c`/`--config-env`/`--exec-path`/`--upload-pack`/`--receive-pack`, which can execute code), `find` without `-exec*`/`-ok*`/`-delete`/`-fprint*`/`-fls`, `rg` without `--pre`/`--hostname-bin`. Redirection (`>`, `>>`, any fd form) is refused, `sed`/`perl` with `-i`/`--in-place` are refused, and any other verb (`tee`, `rm`, `npm`, `node`, `cp`, …) is blocked by name. Expansion and substitution are never interpreted and are refused outright — `$(…)`, backticks, `<(...)` process substitution and any unquoted `$` (single-quoted text is literal and stays readable) — because an allowed head verb could otherwise launder another command. The parser is lexical, so it over-blocks rather than under-blocks; `shell = true` is unchanged (no allowlist). |
| `journal.retentionDays` | Journal age bound, enforced on every append. |
| `journal.maxBytes` | Journal byte bound, enforced on every append: the store — `index.jsonl` plus the blobs it references — is pruned to stay under it, and a pass that has to prune frees a tenth of the bound (the headroom the next appends need). Content addressing dedupes blobs, so a file toggling between two contents (a formatter fighting the agent, repeated `undo --step`) grows the journal through its lines alone; this key is what keeps that bounded. A positive integer (0 is refused by name: it is not "retention off" — unset is — it is a bound nothing fits). Unset ⇒ 100 MiB (`DEFAULT_JOURNAL_MAX_BYTES`). An entry whose own content cannot fit is refused before anything is written, so the tool call fails as `journal_failed` with the file untouched, and a pass that has to prune never drops the newest entry — it reports `over bound by N byte(s)` instead (`kubic clean --journal`). |
| `journal.outOfScope` | Paths excluded from the §42.5 baseline and the end-of-run sweep (self + children): `outOfScope = ["dist"]` ⇒ `dist/`, `dist/**`. Path-boundary aware (`dist` never matches `dist-x`), plain paths only, empty entries refused by name. |
| `agent.name` | The solo lane's agent id: journal entries are attributed to it and `kubic diff --agent <name>` filters by it. Unset ⇒ `root`, unchanged. |
| `skills` | Settings skills (§29.2, issue #237): files or directories loaded with source `settings` on `kubic run`, `kubic tui` and every orchestrator worker's child (see [Settings skills](#settings-skills-skills-292)). Project-layer entries apply only for a trusted project; a non-string or blank entry is refused by name at load. |
| `agent.systemPromptFile` | Prompt augmentation (§63 `system_prompt_file`): a path whose contents are read at load and appended to the assembled system prompt — ahead of the skills block — for `kubic run`, `kubic tui`, the live tiers of `kubic replay`, and orchestrator worker children (each a `kubic run` process loading the same committed config, so they assemble the same prompt). A leading `~/` expands to the home directory; a relative path resolves against the declaring config file's directory, so the shipped example's `SYSTEM.md` travels with `example.toml`. Global-layer paths are always allowed; a project-layer path applies only when the project is trusted (an untrusted project's file is refused pre-trust with the trust message, before it is read) and must resolve inside the project root — a trusted path outside it is refused by name. A missing or unreadable file is a named `ConfigError`, never a silent skip. `kubic config` reports the effective (resolved) path; the contents never render. |
| `roles.<name>.model`, `roles.<name>.tools`, `roles.<name>.thinking`, `roles.<name>.requires`, `roles.<name>.models` | Per-role defaults layered under the role document for `kubic run --role <name>` (§12.1): `model` is a `provider/id` pin the run selects unless an explicit `--model`/`[model]` pin wins, `tools` replaces the document's own list, `thinking` is the role's thinking default — below the session's stored level and any `--thinking`/`KUBIC_MODEL_THINKING` override, above the `[model].thinking` file default — `requires` (issue #196, §41.1) names tools that always require approval under the role — unioned with the document's own `requires:` list, never subtracted. `models` (§38.2, issue #255) is the role's allowed model set: entries are `"provider/id"` or `"provider/*"` strings, or `{ id, thinking? }` tables whose thinking beats the flat role default for the matched model — an empty set (or none) allows every registered model, a malformed entry is refused by name at load, and selection plus every `/model` switch resolve against it, refusing out-of-set by name (`kubic config` renders the winning layer's list with provenance; `/scoped-models` reports the resolved set on the TUI lane). Each leaf is attributed to the layer that set it (enterprise > product > global > project > workspace > session > agent). A malformed model ref, an unknown thinking level, a malformed set entry, or a mistyped request option is refused by name at load. Scope: `kubic run --role` and `kubic tui --role` both apply the whole layer (model pin + tools + thinking + requires + models) and install the most restrictive merge of the config classes and the role's (issue #196, §40.2 — a role declaring `network: none` runs under it even when config allows full); the TUI also takes the `[agent].name` agent id. `kubic orchestrate` resolves each worker over the same layers (§38.1, issue #202): `[roles.<name>].model` outranks the manager's effective model for that worker (which is otherwise inherited), the child is told the winning `provider/id` on `KUBIC_MODEL`, `tools` narrows the orchestrated worker's plan and its `kubic run --role` lane, the role's classes and `requires` travel in the task resources (the child merges the classes with its own config, most restrictive wins, and challenges the requires on its triggers), and the role's thinking default travels on `KUBIC_MODEL_THINKING` unless the run's own `KUBIC_MODEL_THINKING` is set (which outranks it). No role, model or provider is invented when none of those levels sets one. `timeoutMs`/`maxRetries`/`maxRetryDelayMs`/`cacheRetention` layer over the `[model]` request tuning per key for runs as that role (§37.4). |
| `.kubic/roles/<name>.md` frontmatter `name`, `description`, `model`, `budget` | The role document's own Pi-agent keys (issue #198, §12): `name` aliases `role` (a document disagreeing with itself is refused by name), `description` is shown by `kubic doctor` in the role detail, `model` is a `provider/id` pin validated at parse (a malformed ref is refused with its reason before any lane boots), and `budget = { maxToolCalls = 5 }` declares the `--budget` dims (`maxTokens`, `maxCostUsd`, `maxRuntimeMs`, `maxToolCalls` — `=`-separated, same positivity and `maxRuntimeMs` ceiling rules as the flag; unknown dims refused by name). Precedence for the model pin: an explicit spawn/CLI pin beats `[roles.<name>].model`, which beats the document pin (a layer winning over the document is precedence, never an overridden attempt); the winning pin reaches `kubic run --role`/`kubic tui --role` through the existing role-model selection and each orchestrated worker on `KUBIC_MODEL`. A document budget applies to a spawned worker of that role only when present and only when no spawn (`spawn_agent(budget=…)`) or CLI (`--budget`) spec outranks it — absent everywhere means unbounded (budgets stay opt-in, never role defaults); the applied spec is reported on the approvals debug line and enforced by the spawn's own gate (`limit=toolCalls`, exit 3). |
| `orchestrator.root` | Parent directory for orchestrator worktrees: the spawned set is `<repo>/<root>/<session>/<agent>`, `kubic clean` plans the same set, and the §35 runtime exclude entries cover it (the derived entry is `/<root>/`, anchored to the repo root, so only that directory matches — a bare `worktrees` never hides `deep/worktrees/…`). Workspace-relative only — refused by name at load: an absolute path, a `..` segment, a trailing `/`, an empty value, a `.` segment (`.`, `./x`, `foo/.` — the entry would match nothing and the worktree set would stay unignored), a control character, a gitignore metacharacter (`*`, `?`, `[`, `]`, a leading `#`, a backslash), and the committed half (`.kubic`, `.kubic/roles` — case-insensitively, since git folds ignore patterns on a case-insensitive filesystem). Unset ⇒ `.kubic/wt`. || `orchestrator.maxWorkers` | Default admission cap for the orchestrator scheduler (§45): the concurrency a run starts with when nothing else caps it. `kubic orchestrate --concurrency <n>` overrides it for that run, and an explicit limits cap still wins over this key; a value that is not a positive integer is refused by name. Unset ⇒ 4. |
| `orchestrator.manager` | Opt-in driver for `kubic orchestrate` (issue #431): `"lane"` routes the run through the model-driven manager lane (needs a resolvable manager model), `"template"` keeps the deterministic plan. `kubic orchestrate --manager-lane` selects the lane for one run regardless of this key. Anything but `"lane"` or `"template"` is refused by name at load. `kubic tui --orchestrator` always uses the template plan (lane wiring is a deferred follow-up, #439). Unset ⇒ `"template"`. |
| `ui.theme` | TUI theme (§16.9, issue #304). A built-in name — `default` or `dark` (the shipped Konic brand palette) or `light` — or a path to a JSON theme file, read relative to the current directory (an absolute path is taken as typed). Resolved and validated **before the alt-screen opens**: a missing file, malformed JSON, an unknown or missing colour, or a value that is not `#rrggbb` is one `error: theme '<ref>': …` line on stderr and exit 2. A custom theme names the seven colours Kubic styles with (the structure — bold accent, dim, italic, … — stays Kubic's); each is downgraded to the terminal's colour level exactly like the built-in palette (truecolor RGB, else the nearest xterm-256 entry, else the nearest ANSI colour, and the identity under `NO_COLOR`). Schema: `{ "name": "solarized", "colors": { "accent": "#268bd2", "warm": "#b58900", "success": "#859900", "error": "#dc322f", "warning": "#cb4b16", "muted": "#93a1a1", "prompt": "#fdf6e3" } }` — `colors` and all seven keys are required, unknown keys are refused by name. Unset ⇒ `default`. |
| `ui.statusBar` | Kept: the status bar is always shown; hiding it is a named follow-up — parsed and reported for forward-compat only. |
| `session.store` | Kept: `jsonl` is the only store implemented; `sqlite`/`memory` are a separate decision — parsed and reported for forward-compat only. |
| `session.dir` | Not yet implemented: sessions stay under `~/.kubic/sessions`; relocation is a named follow-up with no filed issue yet (session-lock placement and the runtime-exclude split must settle first). |
| `session.autoCompact` | Threshold compaction on the solo lane (`run`, `tui`, workers): `false` disables it, `true` (and unset) keeps the automatic default. A non-boolean is refused by name. |
| `session.reserveTokens` | Reserved-room tokens before the lane compacts: unset ⇒ 16384. A value that is not a positive integer is refused by name. The effective reserve is clamped per model to at most a quarter of its context window (an 8192-token model reserves 2048), so a small-window model compacts sooner than the configured figure; `kubic config` and `kubic doctor` print the effective reserve. Orchestrator worker children are `kubic run` processes loading the same committed config, so they inherit the value with no extra wiring. |
| `session.keepRecentTokens` | Verbatim recent-context window the lane keeps across a compaction: unset ⇒ 20000. A value that is not a positive integer is refused by name. |
| `session.retentionDays` | Default keep-window (days) for `kubic sessions prune`: `--keep-days` overrides it. `0` means retention is off — prune exits 0 with `session retention is off (keep-days 0) — nothing is pruned`; unset, prune exits 1 naming both ways to set a window (`--keep-days`, or this key) rather than inventing one. Deletion stays explicit (`--yes`), dry-run is the default, and a session holding a live lock is never pruned — the lock is re-checked immediately before each delete, so a session locked between plan and delete is skipped too. The same window self-heals session journals at read time: `kubic log` (with `--session <id>` or the latest-session fallback) drops aged entries as it reads them — with retention unset, or `0`, the log path writes nothing. |
| `verify.tests`, `verify.build`, `verify.lint`, `verify.typecheck` | The §48 gate commands (see [Gate verification](#gate-verification-verify)). After each `kubic run` settles, each configured command runs as `sh -c <command>` in the run's worktree and its exit status becomes the trajectory's `signal:<gate>` label (0 = `pass`). A gate with no command stays `unknown`. A blank or non-string command is refused by name at load. |
| `verify.timeoutMs` | Per-command bound for the `[verify]` gates, a positive integer of milliseconds (default 600000). A command still running at the bound is killed and its gate is `fail`. |
| `policy.allowed_models` | The model gate: `provider/id`, `provider/*` (or `*` glob) patterns and bare model ids. A selection outside the list — `--model`, `[model]`, `KUBIC_MODEL`, a role pin, or the implicit first-available pick — exits 6 with a named policy refusal before any provider call; the implicit pick skips disallowed providers. It gates `kubic run`, `kubic tui` (boot and `/model` switches — a refused switch leaves the live model untouched) and the re-executing tiers of `kubic replay`. |
| `policy.allowed_providers` | The provider gate, applied with `allowed_models`: both lists intersect, so a provider the list omits is refused even when a pattern would name the model. |
| `policy.allowed_tools`, `policy.denied_tools` | The lane tool intersection: `kubic run`/`kubic tui` (and the re-executing tiers of `kubic replay`) activate only tools that survive it, and the system prompt's `tools:` line names exactly that set. A deny holds against every lower layer, a role document and the model — a role that declares a denied tool is refused by name, while a role that declares none of them is unaffected by a deny-only policy. With no allow list, only the deny list narrows; with one, anything outside it is refused. |
| `policy.network_policy`, `policy.allowed_domains` | Parsed and resolved into the effective policy: `"proxy"` is carried as the engine's allowlist mode. **Not enforced today:** proxy-mediated enforcement is a named follow-up, so these keys protect nothing yet — `kubic config` lists them (`kept`) rather than the section being silently ignored. `kubic doctor` reports the one shape it can judge (issue #289): an `allowlist` with no domains is unenforceable and fails `policy:enterprise-network`; proxy-mediated enforcement itself stays unreported. The engine mode names (`none`, `allowlist`, `full`) are accepted too. |
| `policy.filesystem_policy` | Parsed and resolved (`workspace-only` is the engine's `workspace-write`; the engine level names are accepted). The lane derives filesystem reach from `[permissions]` classes today, so this value is **not enforced** as a gate of its own; `kubic config` lists it (`kept`), `kubic doctor` does not report it (issue #289). |
| `policy.require_credential_broker`, `policy.deny_local_credentials` | Parsed and resolved into the effective policy, but **not enforced**: the credential broker is not on the worker spawn path yet, so `require_credential_broker = true` protects nothing today (issues #289, #359). `kubic config` lists both keys (`kept`); `kubic doctor` does not report them. |
| `policy.data_policy`, `policy.logging_policy` | Parsed and carried (for example `no-external-training`, `full-audit`); no local mechanism can promise a provider-side policy, so they are reported, never claimed as enforced. |
| `policy.agent_policy` | `{ max_agents, max_cost_usd }`, parsed into the effective policy's `agent` bounds; the orchestrator does not consume them yet, so they are **not enforced**; `kubic config` lists them (`kept`), `kubic doctor` does not report them (issue #289). |
| `audit` (`[[audit]]`) | Sink tables (`sink` = `syslog` \| `file` \| `memory`, `level` = `privileged` \| `all`, optional `target`/`facility`). Parsed and validated fail-closed (an unknown kind, level or key is named); every §60 row fans out to the configured sinks plus the mandatory repo ledger (see [Audit sinks](#audit-sinks-audit)). |

### Settings skills (`skills`, §29.2)

```toml
skills = ["./team", "/opt/shared/skills"]
```

A top-level array of skill files or directories (issue #237). Each entry
loads with source `settings` — like an explicit `--skill`, it applies even
under `--no-skills` — on `kubic run`, `kubic tui` and every orchestrator
worker's child (the manager forwards its own settings skills through the
`--skill` channel, ahead of the run's flags, so explicit intent still wins
a same-name conflict). Relative entries resolve against the directory of
the config file that declared them — a project config's `"../shared"`
names the project's sibling wherever the run was invoked from — never the
cwd; absolute entries pass through as written. `~` and env vars are not
expanded. The first layer that sets the key wins the whole array
(enterprise > product > global > project), and project-layer entries apply
only for a trusted project: an untrusted project file is refused before it
is read, exactly like every other project key. `kubic config` reports the
resolved (absolute) list with its layer.

The user discovery roots are `~/.pi/agent/skills` and `~/.agents/skills`
(Pi-compatible) plus `~/.kubic/skills` (issue #237): the Kubic-native root
is read last, so it wins a same-name conflict with a Pi-carried skill.

### Gate verification (`[verify]`)

```toml
[verify]
tests = "npm test"
typecheck = "npm run typecheck"
timeoutMs = 600000
```

With at least one command configured, every `kubic run` (and every
`kubic orchestrate` worker, which is a `kubic run` in its worktree)
verifies its work after it settles, before it writes its §46 trajectory:

1. Each configured gate runs in the run's worktree, in the order tests,
   build, lint, typecheck. The command runs as `sh -c <command>` with the
   allowlisted tool environment (no secrets) and is killed at `timeoutMs`.
   Exit 0 is `pass`; any other exit, a spawn failure or a timeout is
   `fail`.
2. When the run started from a git revision, the same commands run again
   in a temporary detached checkout of that revision (`git worktree add
   --detach`, removed afterwards whatever happens). A gate that passed there
   and fails after the run is a regression.
3. The trajectory's eval labels record `signal:<gate>` for each verified
   gate and, when a baseline was comparable, `signal:regression` (`pass` =
   no gate regressed, `fail` = at least one did). Outside a git checkout no
   regression is claimed.

`kubic eval --trajectory`, the reference verifier and the RL exporters read
these labels; see the signal and quality rules in
[the eval package](../packages/eval.md#signals-and-patch-quality). With no
`[verify]` section nothing runs and every gate stays `unknown`. `kubic tui`
turns are not verified.

The commands are ordinary shell commands run with your permissions, so
they come only from layers you trust: a project `.kubic/config.toml` is
refused until the project is trusted (see the trust gate above).
Verification adds the commands' run time to every `kubic run`.

### `autoApprove` capabilities

`autoApprove` entries name capabilities — the strings `detectTriggers`
(`packages/host/src/approvals.ts`) raises on tool calls. The known set
(`CAPABILITIES`):

| Capability | Raised by |
| --- | --- |
| `network` | A network command under `network = "none"` (`curl`, `wget`, `ssh`, `scp`, …) — including one hidden inside `$(…)` (nested substitutions included), backticks, or after `eval`. |
| `credentials` | An access to a listed credential location (issue #275), under the effective `credentials` class — which §40.2 enforces as `none`, `allowlist` included. Bash: home credential paths (`~/.aws/`, `~/.ssh/` — every child except the known-public `known_hosts*`, `authorized_keys*` and `*.pub`, so `~/.ssh/github` and `~/.ssh/*` raise, `~/.config/gh/`, `~/.config/gcloud/`, `~/.docker/config.json`, `~/.kube/config`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`, `~/.azure/`) spelled `~`, `$HOME`, `${HOME}`, `/Users/<user>` or `/home/<user>`, plus workspace credential files (`.env`, `.env.*` except `.env.example`/`.env.sample`/`.env.template`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*` — the public `*.pub` halves excluded). Read-family tools (`read`, `ls`, `find`, `grep`): the same names in the `path`/`root` argument, as typed before the confine rewrite (a home path is rewritten before the tool opens it, but the ask sees it), and the name filters `grep.include` / `find.nameContains` when the filter is a substring of a credential name or contains one (`include: "env"` reaches `.env`, `include: "src/.env.local"` too) — filters shorter than 3 characters are not treated as credential selectors. Matching is case-folded, like the default macOS/Windows volumes. Lexical detection, not enforcement (§59.1): an obfuscated or built-up path is a stated miss. Also fires via `requires:<tool>`. |
| `git-push` | `git push`, `git remote add/set-url/remove/rename` — in any command segment (`ls; git push`, `cd x && git push`), after git global options (`git -C . push`, `git -c k=v push`, `--git-dir=…`, `--work-tree=…`, `--no-pager`; an option argument may be quoted: `git -C "my dir" push`) and after any command-position boundary: whitespace, `\| ; &`, `(` (`$(git push)`), a path (`/usr/bin/git push`), a backslash (`\git push`), a quote (`bash -c 'git push'`, `sh -c "git push"`) or a backtick. The word must be exactly `git` followed by whitespace — `mygit push`, `digit push`, `gitpush` and `git-lfs push` do not raise. |
| `destructive-shell` | The destructive matcher (`rm -rf`, `mkfs`, `dd of=/dev/…`, `shred`, `git clean -f`, `chmod/chown -R`, force pushes — `git push --force`/`-f`/`--force-with-lease`/`--force-if-includes`/`+refspec` — `find … -delete`, `git reset --hard`, `git checkout -- <path>`/`.`/`-f`, and `git restore` of the working tree; a staged-only `git restore --staged` is not destructive), including a destructive verb unwrapped through `$(…)` (nested substitutions included), backticks, or after `eval`. |
| `install` | Package installs and fetch-and-run launchers, in any segment: `npm install/i/add/ci/exec/x`, `npx`, `pnpm install/i/add/dlx`, `yarn` (bare), `yarn add/install/dlx/global add`, `bun install/i/add`, `bunx`, `pip install`, `pipx install/run`, `uv add`, `uv pip install`, `uv tool install`, `uvx`, `gem install`, `composer require/install`, `brew install`, `apt install`, `cargo install/add`, `go install`. Scripts such as `npm test`, `npm run build`, `yarn build` and `uv run` are not installs. |
| `deploy` | Deploy verbs (`kubectl apply/create/delete/rollout`, `docker push`, `terraform apply`, `gh release create`). |
| `outside-write` | A write outside the workspace: the `write`/`edit` tools, any redirect target (`>`, `>>`, `2>`, `&>`, `&>>`, `>|`, `>& file` — every one in the command, not only the first), a `tee` target, or a `cp`/`mv`/`install` destination. |
| `budget-overrun` | The budget/concurrency overrun flag. |
| `spawn-agents` | Agent spawning (the orchestrator). |
| `privilege-escalation` | `sudo` anywhere in the command. |
| `kubic-state-write` | A write into Kubic's control plane — `<workspace>/.kubic/` (`config.toml`, `roles/`, …) and, for a target outside the workspace, any ancestor's `.kubic/` (a worker worktree's repo) or `~/.kubic/` (the global `config.toml`) — or into the workspace's own `.git/` (hooks, `config`): a planted hook runs on the host's later git commands, so it asks too (issue #363): the `write`/`edit` tools, any redirect target (`>`, `>>`, `>|`, `>&`, `&>`, `&>>`, `N>`), a `tee` target, a `cp`/`mv`/`install` destination, or an `rm`/`mv` operand (deleting or moving control-plane state is tampering; a `cp` source is only read). Relative targets resolve against a preceding `cd`/`pushd`, quote-split and backslash-escaped segments are read as the shell reads them (`".kubic"/roles/r.md`), and `$HOME/`/`${HOME}/` count exactly like `~/`. **Always asks**: `autoApprove` and `--full-access` never answer it (an `autoApprove` entry naming it is ignored and warned about by `kubic doctor`). Writes into `.kubic/journal/`, `.kubic/orchestrator/` and `.kubic/sessions/` at any of those roots, and into the session root in use, are refused outright as a tool error (issue #324; see [journal and safety](../architecture/journal-and-safety.md)). |

`requires:<tool>` is accepted alongside them (the per-tool trigger). A name
outside this set is reported by `kubic doctor` (`policy:approvals`), never
silently ignored.

Detection is a literal-pattern heuristic over the command string and the
read-family tool paths, not
sandbox-grade shell parsing — the posture is stated, not silent. Documented
heuristics:

- **Last-argument target** — for `tee`, `cp`, `mv`, and `install`, the
  last whitespace-separated argument of the command segment is taken as
  the write target (`cp a /etc/b` → `/etc/b`;
  `install -m 644 a /usr/local/b` → `/usr/local/b`). A flag that reorders
  arguments (`cp -t /etc a b`) points the heuristic at the wrong token, and
  only the final named target of a multi-file `tee` is checked
  (`tee /etc/x a.txt` writes `/etc/x` and is a documented silent miss —
  apart from stated cases the heuristic errs toward over-triggering, not
  uniformly so: a destination that is not the segment's last token can
  still be missed, e.g. `echo $(cp a /etc/b )`).
  A target lifted out of `$(…)` has that span's closing `)` trimmed
  (`$(cp a /etc/b)` → `/etc/b`) — scoped to lifted tokens: a plain target
  is never trimmed, so `tee '/work)'` names the literal sibling path
  `/work)` and still raises outside-write. The outside check itself stays
  path-boundary aware (`/work-evil` is not `/work`).
- **Every redirect** — each redirect operator in the command is checked,
  within one segment and across `;`, `&&`, `||`, `|` and newlines, so
  `echo a > notes.txt && echo b > /etc/cron.d/x` raises outside-write.
  Covered forms: `>`, `>>`, fd-prefixed (`2>`, `1>>`), `&>`, `&>>`,
  clobber `>|`, and `>&` — an fd duplication (`2>&1`, `>&-`) is not a
  file and is skipped, while `>& out.txt` names a file. The target is the
  next token up to whitespace or a `|;&<>` character, read the way the
  shell reads it: quotes and backslash escapes come off wherever they sit
  (`echo x > ".."/x` and `> \../x` name `../x` and raise outside-write).
  Stream pseudo-devices persist nothing and never raise: exactly
  `/dev/null`, `/dev/stdout`, `/dev/stderr`, `/dev/tty` and `/dev/fd/<n>`
  (so `cmd > out.txt 2>/dev/null` stays quiet); any other `/dev` target
  still raises.
- **Shell-expanded and `cd`-relative targets** — bash expands a target
  before it writes, the detector does not, so a target starting with `~`
  (`~/.bashrc`, `~root/x`) or `$` (`$HOME/.zshrc`, `${HOME}/x`,
  `$OUT/file`) counts as outside-write, fail-closed. A `cd <dir>` or
  `pushd <dir>` at a command START — at the start of the command or after
  `;`, `&`, `|`, a newline or `(`, then any run of `{`, `then`, `do`, `else`,
  `elif`, `if`, `while`, `until`, a `!` negation and the `command`/`builtin`
  wrappers (`{ cd /tmp; echo x > y; }`, `if cd /tmp; then …`); a keyword inside an
  argument (`git commit -m 'then cd /x'`) starts nothing — moves the
  directory later relative targets resolve against: `cd /etc && echo x > y`
  raises, `cd sub && echo x > y` does not. After a `cd` to an unknown place
  (bare `cd`, `cd ~`, `cd $X`, `cd -`, any `popd`) every later relative target
  raises. The `cd` trail is lexical, so it is only ONE of two candidates: a
  target is outside if it is outside as TYPED (against the workspace) or as
  resolved against the tracked directory. A subshell `(cd /etc); echo x > y`, a
  conditional `false && cd sub; echo x > ../y` or a `cd` quoted into an
  argument therefore over-trigger — they can never hide a write (a real `cd
  sub && echo x > ../y` over-triggers too). A redirect on the `cd` itself
  applies before it runs. A tracked directory longer than 1 KiB is treated as
  unknown. A
  `$VAR` in the middle of a target (`out/$f.log`) is not expanded and is
  checked as written. Any target under `~/.kubic` (session state,
  `posture.json`, `approvals.json`) — including a `write`/`edit` path —
  raises outside-write even when the workspace is the home directory.
  Tool paths are not shell-expanded: the `write` tool takes `~/.bashrc`
  literally, as a workspace file.
- **Control-plane targets** (`kubic-state-write`, issue #324) — the same
  target scan feeds the control-plane guard, with these additions. Every
  target is classified TWICE and either candidate being control-plane counts:
  as typed against the workspace, and resolved against the tracked
  `cd`/`pushd` directory (`cd .kubic/roles && echo x > r.md` writes
  `.kubic/roles/r.md`; `cd ~`, `cd $HOME/x` resolve against the home directory
  here, unlike the outside-write rule above). The trail is lexical, so it only
  ever adds a candidate: `(cd x); echo p > .kubic/journal/y` is still refused.
  A redirect on the `cd` command itself (`cd .. > config.toml`) resolves against
  the directory BEFORE that `cd`, and redirection words are never the
  directory (`cd 2>/dev/null .kubic`), nor are `--` and `-L`/`-P`. `$PWD`, `${PWD}`
  and `~+` are the current directory (`cd "$PWD/.kubic"`); `~-`, `$OLDPWD` and
  a `cd` to an unknown place read a relative `.kubic` segment as the
  workspace's own, fail-closed. Inner quotes and backslash escapes are removed
  before matching (`".kubic"/roles/r.md`, `.k"ub"ic/…`, `\.kubic/…`), and `$HOME`,
  `${HOME}` and `${HOME:-…}` expand like `~` (`$HOMEDIR` and `~user` do not).
  Operands of `rm` and `mv` count as writes: `rm .kubic/journal/index.jsonl`
  is refused outright, `rm .kubic/roles/r.md` asks. A glob or brace list that
  COULD expand into `.kubic/journal`, `orchestrator`, `sessions`, `config.toml` or
  `roles` — or into the state directory itself — is refused, not just asked
  (`rm .kubic/journa?/*`, `rm -rf .kubic/*`, `rm .kub*`, `rm .kubic/{journal,x}/y`);
  it is deliberately conservative (a leading `*` may match a dotfile, and a
  brace list past 32 expansions that names `.kubic` is refused). Still
  misses, by design: a path built from a variable set elsewhere (`D=.kubic; echo
  x > $D/roles/r.md`), `sed -i`, a script file, an interpreter (`bash -c 'cd
  .kubic && …'`), `time cd`, `eval cd`, a subshell `cd` that undoes an earlier
  one (`cd .kubic; (cd ..); echo x > config.toml`), a symlink, and a `cd` chain
  that started from an unknown place before reaching `.kubic` (`cd $X && cd
  .kubic && echo x > config.toml`).
- **Git verb scan** — the `git` word is found after the boundaries listed
  in the table, then the option run is walked token by token in linear time
  (a long `--namespace --namespace …` chain cannot stall the scan; it runs
  before every bash call). Words are read twice and either reading reaching
  `push` raises: quote-aware (a quoted option argument is one word, a
  backslash escapes the next character outside single quotes, a quote with no
  closer is an ordinary character) and plain whitespace-split (the original
  reading, the safety net for shell syntax the tokenizer misreads such as
  `git -c user.name=O\'Brien push`). A `!` is a boundary too
  (`-c alias.p='!git push'`). It only ever widens what raises, so the
  over-trigger stays an ask: `git -c "a push" status` still reads as a push.
- **`sudo` over-trigger** — `privilege-escalation` fires on the word `sudo`
  anywhere in the raw command, quoted text included
  (`echo "needs sudo"` raises it). A raised capability becomes an ask,
  never a silent grant, so the false positive costs a confirmation.
- **Indirection unwrap** — a destructive/network verb behind `$(…)`,
  backticks, or `eval` raises the underlying capability, and unwrapping
  runs to a fixpoint: single-level (`$(rm -rf /)`), eval-of-substitution
  (`eval $(rm -rf /)`), and nested (`echo $(echo $(rm -rf /))`) forms all
  raise. `$(…)` is collected with a bounded literal `$(…)`/`)` pairing scan
  (depth cap 16; the cap's unmatched-opener markers still consume closers,
  so the effective nesting threshold is 2× the cap — 31 nesting levels
  raise, 32 stay unraised, pinned in the detector tests) — a stated bound,
  never a fabricated unwrap.
- **Credential paths** (issue #275) — the `credentials` trigger is lexical,
  like every detector here: it recognizes the listed home locations in a
  bash command (`~/.aws/credentials`, `$HOME/.ssh/id_rsa`, `/Users/x/.netrc`;
  the `~`, `$HOME`, `${HOME}` and absolute home spellings), the listed file
  names in a read-family tool path, and the `grep.include`/`find.nameContains`
  name filters that select those files by substring (`include: "env"`
  reaches `.env`; a filter shorter than 3 characters is not treated as a
  credential selector). Matching is case-folded, like the filesystems it
  guards (`.ENV`, `~/.AWS/credentials`). Over-triggering is deliberate
  (`*.pem` is flagged whether or not it holds a key) and a raised credential
  capability is an ask, never a silent grant; the known-public files
  (`*.pub`, `authorized_keys*`, `known_hosts*`) stay quiet. Stated misses: a
  path the list does not name, an obfuscated or split spelling
  (`~/.a''ws/credentials`, `p=~/.ssh; cat $p/id_rsa`), a Windows-style
  backslash spelling, and a credential reached indirectly (`bash -c`, a
  script, a symlink). The `~/.ssh/*`
  directory name also matches the network verb scan, so those commands raise
  `network` as well.

What remains out of scope — documented gaps, not silently handled:
interpreter-based verbs (`bash -c "rm -rf …"`, `python3 -c`, `node -e` —
the command is data to the literal patterns; a `git push` inside `bash -c '…'`
is the one exception, caught because a quote is a boundary for the `git` word), network exfiltration via
`python -c`/`node -e`/`npm`, substitution nesting past ~2× the depth cap,
quoted or backslash-obfuscated verbs the literal patterns cannot see,
whitespace tricks around redirection targets, git subcommands reached
through an alias (`git config alias.p push; git p`), package managers
not listed above, and installs run by a build script (`npm run setup`).
The literal verb scan over-triggers on quoted text: `echo "git push
later"` raises `git-push` (an ask, never a silent grant).

Two keys are forbidden outright, not defaulted: **`[budgets]`**
(`BudgetKeyError` — budgets are never defaulted by config) and
**`[mcp]`** (unsupported in v1; third-party tools/MCP arrive in Phase 4
— doctor surfaces these as `policy-mismatch` fails pointing at
[doctor and debug](doctor-and-debug.md)).

## Enterprise policy (`[policy]`, §58)

An enterprise admin can put a §58 `[policy]` section in
`/etc/kubic/config.toml` (or in `/etc/kubic/product.toml` for a
product/vertical profile). It is the highest-precedence layer: a lower
layer, a role document or the model can narrow it, never widen or remove
it. One `EffectivePolicy` is resolved once per process at startup and
threaded through the composition root.

```toml
[policy]
allowed_models = ["claude-sonnet-4-6", "local/*"]
allowed_providers = ["anthropic", "local"]
allowed_tools = ["read", "grep", "find", "ls", "bash", "edit", "write", "git_diff"]
denied_tools = ["network_fetch"]

network_policy = "proxy"
allowed_domains = ["registry.npmjs.org", "github.com"]

filesystem_policy = "workspace-only"
# Parsed and listed by `kubic config`, NOT yet enforced (see the key list below):
require_credential_broker = true
deny_local_credentials = true

data_policy = "no-external-training"
logging_policy = "full-audit"
agent_policy = { max_agents = 2, max_cost_usd = 5.0 }

[[audit]]
sink = "syslog"
level = "privileged"
```

The keys, and the vocabulary reconciliation with the engine that consumes
them:

- `allowed_models` — `provider/id`, `provider/*`, `*` globs and bare model
  ids. `allowed_providers` intersects with it. Both gate `kubic run`,
  `kubic tui` (at boot and on every `/model` switch) and the re-executing
  tiers of `kubic replay` (the explicit `--model` pin, `[model]`,
  `KUBIC_MODEL`, a role pin, and the implicit first-available pick) before
  any provider call.
- `allowed_tools` / `denied_tools` — the lane's tool intersection. The
  system prompt's `tools:` line and the active tool set are the same set;
  a tool named in `denied_tools` cannot be re-enabled by a project config,
  a role document or the model.
- `network_policy` — `"proxy"` is carried as the engine's `allowlist`
  mode; the engine names (`none`, `allowlist`, `full`) are accepted too.
  Proxy-mediated enforcement is a named follow-up, so the value is **not
  enforced** today; `kubic config` lists it (`kept`) instead of the section
  being silently ignored.
- `filesystem_policy` — `"workspace-only"` is the engine's
  `workspace-write`; the engine level names are accepted too.
- `require_credential_broker`, `deny_local_credentials`, `data_policy`,
  `logging_policy`, `agent_policy` (`{ max_agents, max_cost_usd }`) —
  parsed into the effective policy and listed by `kubic config`; each one's
  enforcement status is the key-effect row above, never a claim. `kubic
  doctor` does not report these §58 keys yet: `enterpriseDoctorChecks`
  (audit-sink, network-allowlist and enforceability checks) has no caller
  (issue #289), so a green doctor says nothing about them.
  **`require_credential_broker` is parsed and reported but not yet
  enforced:** no producer in the composition root hands the resolved value to
  `kubic orchestrate` (the run's `requireCredentialBroker` option is only set
  by embedders), so `require_credential_broker = true` in a config does not
  put `broker:<ref>` sentinels in a worker's env today — workers get the
  plain grant described under "Provider credentials reach workers per role"
  below. See [design drift, item 22](../design-drift.md#item-22--363-tool-credential-brokering-is-not-implemented).
- `[[audit]]` — repeatable sink tables (`sink`, `level`, optional `target`
  and `facility`). Unknown kinds, levels and keys are refused by name.
  See [Audit sinks](#audit-sinks-audit).

### Audit sinks (`[[audit]]`)

Enterprises expect audit records to reach syslog or another org sink — a
JSONL file inside a repo the agent can write to is not tamper-evident.
Every §60 row (decisions and privileged actions alike) fans out to each
configured sink **plus** the mandatory repo ledger
(`.kubic/orchestrator/approvals/audit.jsonl`, read by `kubic audit`):

```toml
[[audit]]
sink = "syslog"
level = "privileged"

[[audit]]
sink = "file"
level = "all"
target = "/var/log/kubic.jsonl"
```

- `sink`: `syslog` (one RFC 5424 line per record), `file` (one JSON line
  per record appended at the exact `target` path), or `memory`
  (process-scoped, for embedders and tests).
- `level`: `privileged` keeps approval decisions (`tool:<name>`), the
  seven privileged actions, and the full-access revoke
  (`posture:approvals` — the disable half of a privileged posture
  change travels with its grant, issue #286 review), dropping
  everything else; `all` keeps every
  row. The repo ledger always keeps everything regardless of level.
- `target` (syslog): a unix datagram socket path (bare `/dev/log` or
  `unix:/path`; the default is `/var/run/syslog` on macos and `/dev/log`
  elsewhere) or a `host[:port]` UDP destination (port 514 when absent).
  UDP delivery is best-effort by protocol design. `target` (file): the
  exact file path (required). `memory` takes no target.
- `facility` (syslog): an RFC 5424 facility name (`local0`–`local7`,
  `user`, `authpriv`, …) or number 0–23; default `local0`. Unknown
  facilities and malformed targets are refused by name when the sinks
  build — the table is skipped (named on stderr and in `kubic doctor`)
  while the repo ledger keeps recording.
- A sink that fails at runtime records the failure and notes it on
  stderr once per process; the repo write is never blocked. `kubic doctor`
  lists every configured sink with a reachability probe (`audit:sink:*`)
  plus any runtime failure the process recorded.

Unknown keys inside `[policy]` fail closed and are named. `kubic policy
--tool <name>` answers from the merged enterprise and installed policy and
names the deciding layer (`deny bash (enterprise)`), so the offer and
`kubic run` cannot disagree.

## models.json

Custom (OpenAI-compatible) providers are declared in `models.json`, on top
of Pi's built-in providers. Files, in load order:

| Location | Trust |
| --- | --- |
| `~/.kubic/models/models.json` (global) | Always loaded — it is your own machine-local file, and the recommended place for provider config. |
| `<projectRoot>/.kubic/models.json`, else `<projectRoot>/models.json` (project) | **Trust-gated** like the project `config.toml`: before it is trusted (`kubic trust`, the `kubic tui` prompt, or `KUBIC_TRUST_PROJECT=1`) it is never read, only named (`models.json ignored: <path> (project, untrusted — run 'kubic trust' or set KUBIC_TRUST_PROJECT=1 to load it)`), so a cloned repository cannot point a provider — and your key — at its own URL. |

The **project root** is the nearest directory at or above the working
directory that holds a `.git` entry (a repository or worktree top level) or
a `.kubic/` directory — never your home directory, whose `.kubic/` is the
global tree; with neither, the working directory itself. So `kubic run`,
`kubic models` and `kubic doctor` see the same providers from any
subdirectory. `kubic orchestrate` hands each worker child the manager's
repository root in `KUBIC_MODELS_ROOT` (and forwards `KUBIC_TRUST_PROJECT`
when set), so a worker in its worktree resolves the manager's
`models.json` even when that file is untracked; setting `KUBIC_MODELS_ROOT`
yourself pins the project root the same way.

A project provider overrides a global provider with the same id. Every
file is refused whole (never half-applied) and named when:

- it is invalid JSON or fails the schema;
- a provider id collides with a **built-in** provider (`anthropic`,
  `openai`, …) — a custom provider can never replace a built-in's URL or
  auth, trusted or not;
- `apiKeyEnv` — or an `apiKey` / header `$VAR` — names a variable outside
  the allowlist: a `KUBIC_*` name or a `*_API_KEY` name (`OPENROUTER_API_KEY`, `KUBIC_GATEWAY_TOKEN`). Anything
  else (`AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `HOME`) is refused, so a
  file can never choose an arbitrary secret to send as a bearer token.
  Without `apiKeyEnv` the key is read from `KUBIC_API_KEY`.

Which files were found and their trust state is reported: `kubic models`
and `kubic doctor` print a `loaded models.json: <path> (global|project,
trusted): <ids>` / `models.json ignored: <path> …` line on stderr, doctor's
`dep:models-json` check lists each file with `loaded`, `ignored, untrusted`
or `invalid` (an invalid file fails the check), and `kubic run` prints a
`models.json ignored: …` line on stderr (the `loaded` receipt only under
`--debug`).

### models.json schema

The §38.5 shape — `providers` is an object keyed by provider id (an array
of entries with their own `id` is accepted as an alias):

```json
{
  "providers": {
    "local": {
      "baseUrl": "http://127.0.0.1:8000/v1",
      "api": "openai-completions",
      "apiKey": "not-needed",
      "models": [
        { "id": "qwen3-coder-27b", "contextWindow": 131072, "maxTokens": 16384 }
      ]
    }
  }
}
```

| Provider key | Meaning |
| --- | --- |
| `baseUrl` | `http(s)` endpoint (required). |
| `api` | `openai-completions` or `openai-responses` (required). |
| `apiKey` | A literal key (e.g. `not-needed` for a keyless local server), an allowlisted `$VAR` (same allowlist as `apiKeyEnv`), or a `!command` resolved per request. Escaped `\$` / `\!` stay literal. Not together with `apiKeyEnv`. |
| `apiKeyEnv` | The env variable holding the key (allowlist above; default `KUBIC_API_KEY`). |
| `name`, `headers` | Display name; per-request headers (non-empty strings). Literal values ride every request statically; `$VAR` (allowlisted) and `!command` values resolve per request through the key auth instead and never reach the wire verbatim. |
| `models` | Non-empty list of models (ids unique per provider). |

| Model key | Meaning |
| --- | --- |
| `id`, `name`, `reasoning` | Model id (required), display name, reasoning support. |
| `contextWindow`, `maxTokens` | Positive integers; `maxTokens` must be **less than** `contextWindow`, judged on the effective values (defaults `8192`/`2048`), so `contextWindow: 1024` alone is refused too. A `0` or fractional value is refused with the field named. |
| `cost` | `{input, output, cacheRead, cacheWrite}` in USD per 1M tokens (§37.2); cache reads and writes are priced separately (§39) and reach `kubic models --json` as `cacheReadCost`/`cacheWriteCost`. The flat `inputCost`/`outputCost` keys still work — one place per field, never both. |
| `input` | Input modalities: a non-empty list from `text`, `image` (default `["text"]`). |
| `samplingParams`, `samplingParamsByThinkingLevel` | Extra request-body fields Pi assigns into the provider request verbatim (`temperature`, `top_p`, …). The by-level form is keyed by thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`); at request time the effective level's object is merged over `samplingParams`. An unknown level or a non-object body is refused with the field named. Supported for the OpenAI-compatible APIs this file declares (`openai-completions`, `openai-responses`). |

## Secrets (never in config)

Secrets never appear in config: a secret-shaped value or a secret ref in
`config.toml` is refused by name. What ships (issue #359):

- **Provider keys from `models.json` are resolved at request time.** A
  provider's `apiKeyEnv` names the environment variable holding its key; that
  is a `$ENV_VAR` ref, resolved through the request-time resolver on **every**
  model request (never cached; a missing or empty variable leaves the provider
  unconfigured). The same holds for an `apiKey` written as an allowlisted
  `$VAR` — except a missing variable fails the request closed naming it —
  and for `$VAR` / `!command` header values, which resolve into the request's
  auth headers instead of reaching the wire verbatim. An `apiKey` written
  `\$literal` (or any other plain string) stays a literal key and never
  touches the resolver. Availability checks (`kubic models`, the provider
  probe) read presence only and are not a use.
- **A `!command` ref runs a helper on every request.** The command and its
  arguments are parsed quote-aware (`!op read "my vault/item"` stays one
  argument — a quote opens grouping only at a word boundary, so a mid-word
  quote like `don't` stays literal and the helper receives exactly what was
  written) and executed directly — never through a shell — with a 10s
  timeout and a 64 KiB output cap; an empty result, a failure, or a timeout
  fails the request closed naming the provider and command. The check path
  never executes it (an unknowable command counts as configured; a missing
  binary or a broken helper surfaces at the first request). Commands run
  only from trusted `models.json` files — an untrusted project file is
  refused before it is read — and in an orchestrated worker the command
  runs in the child itself. Without the request-time resolver (the
  orchestrator's availability guess) a command ref counts as configured on
  the probe and refuses by name if a request ever reaches it.
- **Every use is audited.** Each resolution appends one §60 record to the
  audit ledger (`.kubic/orchestrator/approvals/audit.jsonl`, read by
  `kubic audit`): `what: credential:<provider>`, the ref as a sentinel
  (`sentinel:$GW_API_KEY`), the role, and the purpose
  (`model-request:<provider>`) — **never the value**. A worker's uses are
  recorded in its own worktree's ledger with `mode: orchestrator`.
- **The value never persists.** Resolved values are redacted from the
  `--debug` channel, and `kubic run` scrubs them from what the run leaves
  behind: the session JSONL is written through a redacting bridge, and the
  result (the `--json` envelope) and the trajectory's prompt are scrubbed
  — so a provider that echoes the key it rejected in its error body does not
  put it on disk or stdout (`[REDACTED]` in its place). A value is matched as
  text only from **8 characters**: a short or dummy key (`gw`, `ollama` for
  provider `ollama`) is not a secret worth blanking every word for, and it
  never causes its own credential-use row to be dropped. Likewise a key that
  is (or sits inside) one of the run's provider or model ids — LM Studio's
  documented dummy key is its provider's name, `lm-studio` — is identity, not
  a secret: it is never scrubbed out of the envelope or the session rows, and
  its credential-use row is still written (the row names only the ref). The one gap: a
  prompt that quotes the key is written to the session before the first
  request resolves it, so that line is scrubbed from the trajectory and the
  result but not from the session file. A trajectory export also redacts every
  secret-classified env key (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`,
  `*_CREDENTIALS`, `KUBIC_ROLE_*`, and the Anthropic federation block below)
  to `<redacted>` with the same classifier
  the worker spawn env uses. (`kubic tui` resolves and audits keys the same
  way but does not yet scrub its session writes.)

**Anthropic workload identity federation is secret whole (issue #402).**
`ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`,
`ANTHROPIC_IDENTITY_TOKEN_FILE` and the optional
`ANTHROPIC_SERVICE_ACCOUNT_ID` / `ANTHROPIC_WORKSPACE_ID` match none of the
suffix shapes above — the token key is a FILE path and the ids end in `_ID` —
yet the block is the credential: the Anthropic SDK exchanges the file's
identity token for a short-lived access token and refreshes it itself. All
five are classified secret, so they are redacted from worker debug logs and
from trajectory exports like any `*_TOKEN`. The token file's *contents* never
pass through Kubic: Pi hands the SDK the path, and the SDK reads the file.
Anthropic counts as **configured** in `kubic models` and `kubic doctor` when
the three required variables are present (the two ids are optional), while an
API key or `ANTHROPIC_AUTH_TOKEN`, when set, wins as it does in Pi.

Not implemented: **tool-credential brokering** — no budget-bounded scoped token is
issued to a worker or revoked at settle/exit (see
[design drift, item 22](../design-drift.md#item-22--363-tool-credential-brokering-is-not-implemented)).

**Provider credentials reach workers per role (issue #200; §36.3).** An
orchestrator worker is a `kubic run` child behind the §3.8 allowlist, so its
provider key does not travel as ambient env. The manager resolves which
provider each worker's role will use, forwards exactly that provider's key
environment variables — the declared `apiKeyEnv`, the documented
`KUBIC_API_KEY` default, and every `$VAR` an `apiKey` or header ref names —
and passes them as the child's role grant —
`KUBIC_ROLE_<ROLE>_<ENV_VAR>` (e.g. `KUBIC_ROLE_IMPLEMENTER_GW_API_KEY`) —
from where the child reads them back as the provider's apiKey auth. A
`!command` key forwards nothing: the child runs the command itself. Nothing
else rides along: never a sibling role's provider key, never an unrelated
parent secret (`AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, …), never the key
under its plain name in the child env. A `models.json` key is still resolved
per request and audited in the child's run (§36.1 rules 3-4); a built-in key
keeps Pi's own env auth. Every spawn/log surface redacts the `KUBIC_ROLE_*`
namespace. When the provider's key is
missing from the orchestrator's environment, `kubic orchestrate` fails
closed with **exit 6 naming the provider** before it creates any worktree;
`kubic doctor` reports the same per-role provider list (`dep:credentials:roles`).
A built-in whose credential is process-level configuration the worker env
allowlist does not carry — `amazon-bedrock` (`AWS_*`), `azure-openai-responses`
(`AZURE_OPENAI_BASE_URL` or `AZURE_OPENAI_RESOURCE_NAME`), and `google-vertex`
on application default credentials (project, location, credentials file) — is
refused the same way, by name, rather than passing the manager's preflight and
dying in the worker. `google-vertex` on `GOOGLE_CLOUD_API_KEY` is forwarded
like any single-key provider, and the Cloudflare providers forward their
account (and gateway) id next to the key. Anthropic over workload identity
federation forwards the whole block: the grant carries the three required
`ANTHROPIC_*` variables plus whichever optional ids are set, and the child
reads the identity token file from disk itself — the path travels, never the
token.
With `require_credential_broker` the grant carries `broker:<ref>` sentinels
instead of values, so no secret material reaches the child env — the flag is
host policy input, and the `[policy] require_credential_broker` key is parsed and reported but not wired to it yet (see
[design drift, item 22](../design-drift.md#item-22--363-tool-credential-brokering-is-not-implemented)).

## What lives where

`.kubic/` is a **mixed** directory: configuration is committed, run state is
not. The split, exactly as shipped:

- **Committed**: `.kubic/config.toml`, `.kubic/roles/*.md`.
- **Runtime state (never committed)**: `.kubic/sessions/`,
  `.kubic/journal/`, `.kubic/artifacts/`, `.kubic/wt/`,
  `.kubic/orchestrator/`.
- **How a user repo gets the rules**: every `kubic run` and
  `kubic orchestrate` invocation (before it creates any state) writes
  those five runtime prefixes into the repository's **local, uncommitted**
  exclude file (`.git/info/exclude`), in a marked block it rewrites in
  place on later runs — so nothing of Kubic's own appears in `git status`,
  and your committed `.gitignore` is never touched by the tool. `kubic doctor`
  checks the same file the writer writes: it resolves the repository with
  `git rev-parse --show-toplevel` and the exclude with `git rev-parse
  --git-path info/exclude`, so a linked worktree (whose `.git` is a file
  pointing at the common dir) checks the common dir's exclude, and a run
  from a subdirectory checks the root files. Outside a git repository the
  check does not apply. A
  configured `[orchestrator].root` joins that block as `/<root>/`, anchored
  to the repo root, so a worktree parent named `worktrees` never hides a
  `deep/worktrees/` or `src/worktrees/` you meant to keep. `.kubic/`
  itself is deliberately **not** ignored: `config.toml` and `roles/*.md`
  stay committable. Outside a git repository the write is a no-op (runtime
  state is local wherever it is written), and the write never fails a run.
  This repository ships the same five rules in its own `.gitignore` — the
  rules, the writer, and this page are pinned together by
  `scripts/runtime-exclude.test.mjs` and the config tests.
- **Models**: Pi's built-in providers (`anthropic`, `openai`, `google`,
  `amazon-bedrock`, …) are always registered; each is usable once its
  documented env key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GEMINI_API_KEY`, …) or its ambient credentials are set, and a keyless
  built-in is never selected implicitly (`kubic models` shows which are
  usable). Anthropic is also usable from workload identity federation
  (`ANTHROPIC_FEDERATION_RULE_ID` + `ANTHROPIC_ORGANIZATION_ID` +
  `ANTHROPIC_IDENTITY_TOKEN_FILE`, optional `ANTHROPIC_SERVICE_ACCOUNT_ID` /
  `ANTHROPIC_WORKSPACE_ID`), which Pi resolves only when no
  `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` is set. Only **chat** models are
  listed or selected: the catalogue's image and classifier entries are never
  listed by `kubic models` and never picked by model selection. Custom
  providers come from `models.json` (see
  [models.json](#modelsjson) above). A model without `contextWindow`/`maxTokens` gets
  fail-safe defaults `8192`/`2048` (small local servers overflow above
  them). The compaction reserve (`[session] reserveTokens`, default 16384) is
  clamped to a quarter of the model's window (an 8192-token model reserves
  2048), so a small-window model compacts only near its limit, never every
  turn. The same three `[session]` keys (`autoCompact`, `reserveTokens`,
  `keepRecentTokens`) drive `kubic run`, `kubic tui` and orchestrator workers
  alike — see the key-effect table — and `kubic config` / `kubic doctor`
  print the effective reserve after the clamp.
- **Sessions store**: `~/.kubic/sessions` by default. Retention is opt-in
  and manual: `kubic sessions prune` lists candidates by default and
  deletes only with `--yes`, and `[session] retentionDays` (above) supplies
  the default keep-window — a live-locked session is never pruned.
- **Journal**: `<root>/.kubic/journal` by default. With the store's default
  `durable` on, the content an entry references is flushed before the entry
  is: a blob's bytes are fsynced before its rename and its directory after
  it, and the index line is fsynced before the append returns — a few
  fsyncs per tool write are the price of "reversible", and a crash can
  neither take back a change the journal promised to undo nor leave a
  durable entry pointing at bytes that were never written. The retention
  compaction rewrite is flushed the same way, so a crash right after it
  cannot leave an empty index where the whole history was (stated in
  [the journal and safety page](../architecture/journal-and-safety.md);
  `JournalRetention.durable` is the programmatic opt-out, which trades all
  of it for a crash window of one truncated last line).
  Growth is bounded by `[journal] retentionDays`, `[journal] maxBytes` (the
  whole store: index plus blobs) and the 100 MiB default size cap.

Honest limits, stated plainly (§59.1): solo runs in-process with your
user authority — no isolation, no containment; approval policy is an
offer for routing, not enforcement; the journal is a review/undo log,
not a backup. `kubic doctor` reports each of these as an informational
`warn` — see [doctor and debug](doctor-and-debug.md).

Back to the [docs index](../README.md). See also
[commands](commands.md).
