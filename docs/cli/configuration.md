# Configuration

> Where Kubic reads its settings, which layer wins, and what every key does.

## Layers

Kubic merges six layers, then the environment overrides, then the
command-line flags. The first layer to set a key owns it: a lower layer that
sets the same key is reported in `overriddenAttempts` and never applied. An
enterprise key is frozen against everything below it, the environment and the
flags included.

| # | Layer | Read from | Notes |
| --- | --- | --- | --- |
| 1 | `enterprise` | The managed `config.toml` ([where](#where-the-managed-files-live)) | Highest. Nothing overrides it, not even a flag. It may require a signature and bring in a remote policy ([managed configuration](enterprise.md#managed-configuration)). |
| 2 | `product` | The managed `product.toml`, found the same way | A distribution or vertical profile, below enterprise and above your own files. |
| 3 | `global` | `~/.kubic/config.toml` | Your machine-wide defaults. |
| 4 | `project` | `.kubic/config.toml` at the [project root](#the-project-root) | Read only once the project is [trusted](#project-trust). |
| 5 | `session` | — | Reserved: no command supplies it, so it is always empty. |
| 6 | `agent` | — | Lowest. Reserved and always empty, like `session`. |
| — | `env` | The [`KUBIC_*` variables](#environment-overrides) | Above every file layer, below `enterprise` and the flags. |
| — | `cli` | `--model`, `--thinking` | Highest, except against a frozen `enterprise` key. |

### Where the managed files live

The enterprise `config.toml` is read from `/Library/Application Support/Kubic/`
then `/etc/kubic/` on macOS, from `%ProgramData%\Kubic\` on Windows, and from
`/etc/kubic/` elsewhere. The product `product.toml` is found the same way. A
program that embeds Kubic can name other paths (`enterprisePath`,
`productPath`).

### The project root

The project layer is `.kubic/config.toml` in the nearest directory, from the
working directory up, that holds `.kubic/` or `.git`, or in the working
directory itself when none does. The home directory's `.kubic/` is the global
layer, never a project. So `kubic config` and `kubic run --role` read the same
committed project from a subdirectory as from the root, and a subdirectory
with its own `.kubic/` is a project of its own. A missing file is an empty
layer.

### Project trust

A project-local `config.toml` (and the project `models.json`) is
configuration the repository controls, so it is gated: an untrusted
project `config.toml` is **refused by path before it is read** — never
half-applied (`ProjectUntrustedError`) — with the remedies named in the
refusal:

- `kubic trust` records a durable grant for the current directory (or an
  explicit `[path]`); `kubic trust --revoke` removes the decision and the
  refusal comes back; `kubic trust --list` prints every recorded decision.
- On `kubic tui` — and a bare interactive `kubic` — a present, undecided
  project config prompts once before the session starts. Accepting or
  declining is recorded under `~/.kubic/`, so the next invocation does not
  ask again; a cancelled prompt records nothing and fails closed.
- `KUBIC_TRUST_PROJECT=1` accepts the project layer for one invocation,
  above the persistent store, and records nothing.

A grant is recorded at the project root and checked there, so trusting the
root covers runs from its subdirectories. It covers the project's files as
they were when you gave it: a change to them refuses the layer again until
`kubic trust` confirms it ([what a grant covers](trust.md#what-a-grant-covers)).

Trust is exact-path: a decision names the tree its files live in and never
applies to a parent or sibling directory (`/a` does not trust `/a-sibling`,
and a grant for `/a/b` never unlocks `/a`'s committed files). Consumers that
walk up to the repository root — the project `models.json`, project skills —
check the store for the directory they resolved, so a grant for the root
still applies from a subdirectory. A symlinked path is the same decision as
its target. `kubic doctor`'s `config-load` check names the trust state and
where it came from. The store file, its concurrency and every message are on
[project trust](trust.md).

### Command-line flags

`--model <provider/id>` and `--thinking <level>`, accepted by `kubic run`,
`kubic tui` and `kubic config`, are the session overrides: above the
`KUBIC_MODEL` and `KUBIC_MODEL_THINKING` variables and every file layer, and
still below a frozen `enterprise` key. Each flag is an input to the one config
load, so `kubic config --model <provider/id>` shows the same `(cli)` source
that `kubic run` and `kubic tui` start with, and `kubic tui` never patches the
flag over the load afterwards: a frozen enterprise `[model]` holds there
exactly as it does for `kubic run`. A frozen enterprise `model.thinking`
refuses `--thinking` by name and ignores the environment override; the
session then applies the remaining order (session record, role default, file
default) and clamps the level to the model.

A frozen enterprise `[model]` drops a `--model` or `KUBIC_MODEL` pin, but
never silently: `kubic run` and `kubic tui` print one note per overridden pin
on stderr when they start (`note: --model evil/other ignored: model pinned by
enterprise policy (corp/approved)`, and `note: KUBIC_MODEL=evil/other ignored:
…` for the environment pin), and `kubic config` lists the attempt under
`overriddenAttempts`. The note is stderr only, so a `--json` envelope stays
one document, and a pin equal to the enterprise one says nothing. The freeze
binds the whole session: the TUI's `/model`, at the same level as `--model`,
cannot leave a frozen pin. A refusal of an unknown provider or model names the
input that carried the pin (`--model`, `KUBIC_MODEL`, `[model] in <layer>
config` or `role model`) and, when a registered provider or model id is close,
ends with `; did you mean '<id>'?`.

### Environment overrides

| Variable | Effect |
| --- | --- |
| `KUBIC_MODEL` | A `provider/id` model pin, one step above the file key. |
| `KUBIC_MODEL_THINKING` | The thinking level for the selected model: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. |
| `KUBIC_APPROVALS_ROUTE` | `ask-user` or `deny`. |
| `KUBIC_JOURNAL_RETENTION_DAYS` | The journal's age bound, in days (a non-negative integer). |
| `KUBIC_TRUST_PROJECT` | `1` or `true` accepts the project layer, `config.toml` and the project [`models.json`](models.md#modelsjson), for this invocation, without recording anything. |
| `KUBIC_SKIP_SETUP` | `1` skips the first-run setup a bare `kubic` runs on a terminal when there is no `~/.kubic/config.toml` (see [`kubic setup`](models.md#kubic-setup)). |

`KUBIC_MODEL_THINKING` sits below `--thinking` and above `[model] thinking`,
and below the session's stored level and a frozen enterprise key, which
ignores it and reports the attempt in `overriddenAttempts`. The session clamps
it to the effective model with a notice that names the change.

A malformed value fails the config load with the variable named, `kubic
config` included: it never falls back to a default.

`KUBIC_PROVIDER` is not a config key: `KUBIC_PROVIDER=faux` selects the
scripted **testing** provider for one invocation (no network, no model),
and any other non-empty value is refused by name — see
[the testing provider](run.md#testing-provider-kubic_providerfaux).

## The `bash` tool: timeouts and background jobs

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

## Seeing the effective values

`kubic config` prints every value that is set, with the layer it came from,
plus what a run consumes: the selected model, the thinking level, approvals,
permissions, journal retention and the out-of-scope paths. `kubic config
--json` emits the same as one object: `values`, a `{ key, value, layer }` per
set key, and one object per consumed setting. `--model <provider/id>` and
`--thinking <level>` report the config as if that override were passed, so
the `model.*` rows and the `selected model:` and `thinking level:` lines carry
the `(cli)` source. `kubic config --help` (or `-h`) prints the generated help
and exits 0 without loading anything; an unknown flag prints one `error: …`
line on stderr and exits 2.

A broken config (an unknown key, a refused project layer, a secret reference)
exits 1 with the named reason instead of printing defaults. Every command that
reads the config refuses it the same way: `kubic run`, `kubic tui` (with
`attach` and `resume`), `kubic replay`, `kubic policy`, `kubic eval` and `kubic
benchmark` print one `error: <reason>` line on stderr, exit 1 and leave stdout
empty, so a `--json` consumer never parses the refusal as data, and none of
them proceeds on built-in defaults while you believe your file is in force.
`kubic policy` refuses because it reports the posture a run would enforce:
built-in defaults would be more permissive than what you configured.

`kubic config`, `kubic doctor` and `kubic trust` still run, so you can see what
is wrong (doctor reports the load as `dep:config-load (deps-missing)`).
Commands that read no config (`git`, `diff`, `cost`, `audit`, `export`, …)
are unaffected. `kubic models` reads only the trust report, which exists
apart from the load, so it is unaffected too. `kubic sessions` reads one
setting, `session.retentionDays`, the default keep-window for `kubic sessions
prune`, and `kubic log` reads the same key to clean session journals as it
reads them; a refused config leaves both without a window, so prune asks for
an explicit `--keep-days` (deletion stays explicit either way) and `log`
writes nothing.

## Sections

<!-- generated:config-sections -->
- `[agent]`: `name`, `systemPromptFile`, `projectInstructions`
- `[model]`: `provider`, `id`, `thinking`, `timeoutMs`, `maxRetries`, `maxRetryDelayMs`, `cacheRetention`, `escalate`, `maxEscalations`, `fallback`
- `[approvals]`: `route`, `maxPendingMs`, `autoApprove`, `sessionScoped`, `requireJustification`, `broker`, `brokerTokenEnv`, `preApprovalKey`
- `[permissions]`: `filesystem`, `shell`, `network`, `git`, `credentials`
- `[journal]`: `retentionDays`, `maxBytes`, `outOfScope`
- `[roles.<name>]`, one table per name: `model`, `tools`, `requires`, `thinking`, `models`, `escalate`, `timeoutMs`, `maxRetries`, `maxRetryDelayMs`, `cacheRetention`
- `[ui]`: `theme`, `statusBar`
- `[session]`: `store`, `dir`, `retentionDays`, `autoCompact`, `reserveTokens`, `keepRecentTokens`
- `[verify]`: `tests`, `build`, `lint`, `typecheck`, `timeoutMs`
- `[run]`: `timeoutMs`, `maxTurns`
- `[telemetry]`: `enabled`, `endpoint`, `content`
- `[cost]`: `team`
- `[providers.<name>]`, one table per name: `region`
- `[sandbox]`: `mode`, `writable`
- `[mcp.<name>]`, one table per name: `command`, `args`, `url`, `version` (required), `tools`, `approve`, `env`
- `[oidc]`: `provider`, `tokenEnv`, `awsRoleArn`, `gcpAudience`, `gcpServiceAccount`, `gatewayAudience`
- `[tls]`: `systemCa`
- `[managed]`: `url`, `refreshHours`
- `[policy]`: `allowed_models`, `allowed_providers`, `allowed_regions`, `allowed_tools`, `denied_tools`, `network_policy`, `allowed_domains`, `filesystem_policy`, `data_policy`, `logging_policy`, `max_run_cost_usd`, `max_daily_cost_usd`, `project_policy`
- `[[hooks]]`, an array of tables: `event` (required), `command` (required), `tools`, `timeoutMs`
- `[[audit]]`, an array of tables: `sink` (required), `level` (required), `target`, `facility`, `ca`, `tokenEnv`
- `skills`: a top-level key, not a section
<!-- /generated:config-sections -->

Unknown sections or keys are rejected (`ConfigError`). The canonical example
is `packages/host/src/config/example.toml`, generated from the same schema as
the list above: copy it to start. A smaller `.kubic/config.toml` that changes
behaviour:

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
merely shares the prefix (`dist-x`). The rule is applied the same way to the
baseline taken when a run starts and to the sweep when it ends, so a build or
formatter that touches a declared path produces no unattributed journal
entry. Patterns and negations belong in `.gitignore`: the walk honours the
root's rules and every nested file's, child rules after the parent's; `.git/`
and `.kubic/` are skipped before any config. An empty entry (`[""]`) is
refused by name: it would match nothing.

The value vocabularies:

- Thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
- Approval routes: `ask-user` or `deny`.
- Permission classes: filesystem (`none`, `read`, `workspace-write`, `full`),
  shell (a boolean or `read-only-allowlist`), network (`none`, `allowlist`,
  `full`), git (a boolean, `workspace` or `full`) and credentials (`none`,
  `allowlist`).
- `[ui] theme`: a built-in name or the path of a JSON theme.

Four permission values cannot be expressed by the tool set, so `kubic doctor`
and `kubic policy` report them as unsupported and Kubic enforces the narrower
level named here: network `allowlist` runs as `none` (no domain list exists,
so every network command is blocked and raises the network approval trigger),
credentials `allowlist` as `none` (no credential list exists, so every access
to a listed credential path raises the credential trigger), filesystem `full`
as `workspace-write`, and git `full` as `workspace`.

Every millisecond key (`timeoutMs`, `maxRetryDelayMs`, `maxPendingMs`) is at
most 2147483647 (about 24.8 days), the longest delay a timer can hold: a
longer one would fire at once, so the load refuses it by name.

`skills = ["...", ...]` lists files or directories of skills, loaded with
source `settings` (see [settings skills](#settings-skills) below). It is a
top-level key, not a `[skills]` section: a `[skills]` table is rejected like
any unknown section.

## Keys

Every key has a section below. A key Kubic reads names what reads it; a key
it keeps but does not read says why. A key with no section fails `kubic
doctor`'s config check by name, and `kubic config` prints the disposition of
every effective value (`(project, consumed)`), so a config file can never
quietly stop configuring anything.

<!-- generated:config-keys -->
### `agent.name`

The agent's id: journal entries are attributed to it. Unset ⇒ `root`, unchanged.

### `agent.systemPromptFile`

Prompt augmentation: a path whose contents are read at load and appended to the assembled system prompt — ahead of the skills block — for `kubic run`, `kubic tui` and the live tiers of `kubic replay`. A leading `~/` expands to the home directory; a relative path resolves against the declaring config file's directory, so the shipped example's `SYSTEM.md` travels with `example.toml`. Global-layer paths are always allowed; a project-layer path applies only when the project is trusted (an untrusted project's file is refused pre-trust with the trust message, before it is read) and must resolve inside the project root — a trusted path outside it, or a symlink whose target lies outside it, is refused by name. A missing or unreadable file is a named `ConfigError`, never a silent skip. `kubic config` reports the effective (resolved) path; the contents never render.

### `agent.projectInstructions`

Project instructions: `kubic run` and `kubic tui` read one `AGENTS.md` per directory from the repository root down to the working directory (the working directory alone outside a repository) and append them to the system prompt, outermost first, after the `systemPromptFile` and ahead of the skills block. A file loads only when its directory is trusted (see [Project instructions](#project-instructions-agentsmd)); each one reaches the prompt up to 32 KiB, and a longer one is cut with a notice. `false` turns the search off; an enterprise `false` holds against every lower layer.

### `model.provider`, `model.id`

Selects the provider/model for `kubic run` and `kubic tui` (`selectModel`); `--model` and `KUBIC_MODEL` beat it as the `cli`/`env` layers of the config load, and a frozen enterprise `[model]` beats all of them (announced on stderr).

### `model.escalate`, `model.maxEscalations`, `roles.<name>.escalate`

The escalation ladder: `escalate` lists the rungs as concrete `provider/id` refs in climbing order (wildcards refused per entry at load); a role's `escalate` wins outright for runs as that role, even an empty list (which freezes every `/model` switch — opting out of climbing, not of the gate). `maxEscalations` bounds the climbs per run, unset meaning the ladder length. Climbs are one-way (a down-step or off-ladder target is refused by name with the live model untouched) and recorded: `/model <ref>` climbs the ladder silently, `/escalate <ref> [reason]` climbs naming why, and three consecutive tool-failure turns climb one rung automatically — once per run, never back (`kubic run` settles one turn per invocation, so the automatic trigger lives in `kubic tui`). Every climb appends an `escalation: <from> → <to> (<reason>)` transcript row and lands on the trajectory's `model.escalations` (per-model usage already attributes the spend each side of the move).

### `model.fallback`

The fallback chain: concrete `provider/id` refs in the order they are tried. When the selected model cannot be used — its provider has no credentials, is not registered, or is refused by `[policy]` — the first usable rung is selected instead, named on stderr. During a `kubic run`, a turn that fails with a provider error (unreachable, overloaded, rate-limited after the retries, or refusing the credentials) is run again on the next rung. Each move is named on stderr, listed as `fallbacks` in the `--json` envelope and recorded as an escalation on the trajectory, with the error that caused it. See [Regions and fallbacks](enterprise.md#regions-and-fallbacks).

### `model.thinking`

The file-layer thinking default. A session starts with the winner of `--thinking` > `KUBIC_MODEL_THINKING` > session record > role default > this key, clamped to the effective model's supported levels (a clamp is one stderr notice naming the model, the request and the level applied, never a silent rewrite); the applied level is committed to the session and recorded in `trajectory.json`. A level the vocabulary does not know is refused by name at load.

### `model.timeoutMs`, `model.maxRetries`, `model.maxRetryDelayMs`, `model.cacheRetention`

Request options for every model request (`settings.stream`): `timeoutMs` bounds one provider request (a positive integer of milliseconds), `maxRetries` caps the provider/SDK retries inside one request attempt and `maxRetryDelayMs` caps the delay a server may ask for before a retry (non-negative integers: `0` disables retries / the cap), and `cacheRetention` is the prompt cache preference (`none`, `short`, `long`). `[roles.<name>]` layers each of them per key for runs as that role. A mistyped value is refused by name at load.

### `approvals.route`

Approval routing (`ask-user` | `deny`), installed by `kubic run`, `kubic tui`, `kubic replay` and reported by doctor's `policy:installed` line. `deny` refuses every challenged call with `denied by policy route` (exit 4) and never opens the TUI overlay — `autoApprove` entries never apply under it (they are denied too, and doctor fails `policy:approvals` for the combination). `KUBIC_APPROVALS_ROUTE` overrides it.

### `approvals.broker`, `brokerTokenEnv`, `preApprovalKey`

Headless approvals for `kubic run`: `broker` is an https URL (plain http only to this machine) each challenged call is posted to as one ask, answered by a person within `maxPendingMs` or denied; `brokerTokenEnv` names the variable whose value is sent as a bearer token; `preApprovalKey` is the Ed25519 public key (PEM) a `--pre-approvals` file must be signed with. Read from the enterprise, product and global layers only: a project config setting any of them is refused. See [Headless approvals](enterprise.md#headless-approvals).

### `approvals.maxPendingMs`, `autoApprove`, `sessionScoped`, `requireJustification`

Applied to `kubic run`, `kubic tui` and `kubic replay` from the same projection doctor prints, so `policy:approvals` and `policy:installed` always show the same route and bound (doctor fails `policy-mismatch` if they ever differ). `maxPendingMs` bounds the TUI overlay: an unanswered ask denies on timeout. `autoApprove` is explicit-only and applies headless too (the audit record says `approved by autoApprove`), except for an always-ask capability (`kubic-state-write`): naming it is accepted but ignored — it takes the normal ask path (the TUI seat, or the instant no-surface refusal headless, never a `maxPendingMs` stall), `kubic doctor`'s `policy:approvals` line warns by name and `kubic config` counts it as not auto-approved. `requireJustification = true` denies any approval that carries no justification (the TUI overlay and `autoApprove` supply none, so every challenged call is refused). `sessionScoped = false` is refused by the config load: decisions are always stored per session. Only real answers (user, route, autoApprove) persist to `approvals.json` — a timeout denies the call but stores nothing, so a later surface can still ask about the same operation.

### `permissions.*`

Permission classes → the tool allowlist they derive. `shell = "read-only-allowlist"` keeps `bash` but enforces an explicit read-only command allowlist at the guard: every `|`/`||`/`&&`/`;`/`&`/newline segment must head with `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `find` or `git`, and then only in its read-only form — `git status`/`diff`/`log`/`show` (after global options like `-C`/`--no-pager`, without `--output`, and never `-c`/`--config-env`/`--exec-path`/`--upload-pack`/`--receive-pack`, which can execute code), `find` without `-exec*`/`-ok*`/`-delete`/`-fprint*`/`-fls`, `rg` without `--pre`/`--hostname-bin`. Redirection (`>`, `>>`, any fd form) is refused, `sed`/`perl` with `-i`/`--in-place` are refused, and any other verb (`tee`, `rm`, `npm`, `node`, `cp`, …) is blocked by name. Expansion and substitution are never interpreted and are refused outright — `$(…)`, backticks, `<(...)` process substitution and any unquoted `$` (single-quoted text is literal and stays readable) — because an allowed head verb could otherwise launder another command. The parser is lexical, so it over-blocks rather than under-blocks; `shell = true` is unchanged (no allowlist).

### `journal.retentionDays`

Journal age bound (days), enforced on every append. `0` means retention is off: no age bound is installed, the same reading `kubic journal prune --keep-days 0` has, and `kubic config` prints `journal retention: off`. Unset installs no bound either. It is also the default keep window of `kubic journal prune` (`--keep-days` overrides it).

### `journal.maxBytes`

Journal byte bound, enforced on every append: the store — `index.jsonl` plus the blobs it references — is pruned to stay under it, and a pass that has to prune frees a tenth of the bound (the headroom the next appends need). Content addressing dedupes blobs, so a file toggling between two contents (a formatter fighting the agent, repeated `undo --step`) grows the journal through its lines alone; this key is what keeps that bounded. A positive integer (0 is refused by name: it is not "retention off" — unset is — it is a bound nothing fits). Unset ⇒ 100 MiB (`DEFAULT_JOURNAL_MAX_BYTES`). An entry whose own content cannot fit is refused before anything is written, so the tool call fails as `journal_failed` with the file untouched, and a pass that has to prune never drops the newest entry — the store stays over its bound by that entry instead.

### `journal.outOfScope`

Paths excluded from the baseline and the end-of-run sweep (self + children): `outOfScope = ["dist"]` ⇒ `dist/`, `dist/**`. Path-boundary aware (`dist` never matches `dist-x`). An entry is read as the plain path it names (`./dist` and `dist/` are `dist`); an empty entry, one that names the whole workspace (`.`) and one outside it (`../x`, `/abs`) are refused by name. A change under an excluded path is never journaled, so `kubic undo` cannot restore it: `kubic doctor` warns about every excluded path (`journal:out-of-scope`), and the trust question names journal coverage among what a project config sets.

### `roles.<name>.model`, `roles.<name>.tools`, `roles.<name>.thinking`, `roles.<name>.requires`, `roles.<name>.models`

Per-role defaults layered under the role document for `kubic run --role <name>`: `model` is a `provider/id` pin the run selects unless an explicit `--model`/`[model]` pin wins, `tools` replaces the document's own list, `thinking` is the role's thinking default — below the session's stored level and any `--thinking`/`KUBIC_MODEL_THINKING` override, above the `[model].thinking` file default — `requires` names tools that always require approval under the role — unioned with the document's own `requires:` list, never subtracted. `models` is the role's allowed model set: entries are `"provider/id"` or `"provider/*"` strings, or `{ id, thinking? }` tables whose thinking beats the flat role default for the matched model — an empty set (or none) allows every registered model, a malformed entry is refused by name at load, and selection plus every `/model` switch resolve against it, refusing out-of-set by name (`kubic config` renders the winning layer's list with provenance; `/scoped-models` reports the resolved set in the TUI). Each leaf is attributed to the layer that set it (enterprise > product > global > project > session > agent). A malformed model ref, an unknown thinking level, a malformed set entry, or a mistyped request option is refused by name at load. Scope: `kubic run --role` and `kubic tui --role` both apply the whole layer (model pin + tools + thinking + requires + models) and install the most restrictive merge of the config classes and the role's (a role declaring `network: none` runs under it even when config allows full); the TUI also takes the `[agent].name` agent id. No role, model or provider is invented when none of those levels sets one. `timeoutMs`/`maxRetries`/`maxRetryDelayMs`/`cacheRetention` layer over the `[model]` request tuning per key for runs as that role.

### `.kubic/roles/<name>.md` frontmatter `name`, `description`, `model`

The role document's own Pi-agent keys: `name` aliases `role` (a document disagreeing with itself is refused by name), `description` is shown by `kubic doctor` in the role detail, and `model` is a `provider/id` pin validated at parse (a malformed ref is refused with its reason before any session starts). Precedence for the model pin: an explicit CLI pin beats `[roles.<name>].model`, which beats the document pin (a layer winning over the document is precedence, never an overridden attempt); the winning pin reaches `kubic run --role`/`kubic tui --role` through the existing role-model selection.

### `ui.theme`

TUI theme (token themes). A built-in name — `default` or `dark` (the shipped Konic brand palette), `light` (for light terminal backgrounds) or `terminal` (your terminal's own colours: no backgrounds of its own, semantic colours on the ANSI palette slots) — or a path to a JSON theme file, read relative to the current directory (an absolute path is taken as typed). Resolved and validated **before the alt-screen opens**: a missing file, malformed JSON, an unknown key or colour, an unknown `extends` base, or a value that is not `#rrggbb` is one `error: theme '<ref>': …` line on stderr and exit 2 (the message never quotes the file). A theme assigns colours to the design-token roles: `bg0`–`bg3` surfaces, `fg0`–`fg3` text levels, `accent`/`accentBg`, `ok`/`okBg`, `warn`/`warnBg`, `err`/`errBg`, `info`, `add`/`addBg`, `del`/`delBg`, `addWordBg`/`delWordBg` (the changed words of a diff line). Schema (v2): `{ "name": "mine", "extends": "dark", "colors": { "accent": "#00aaff", "bg2": "#202030" } }` — any subset of roles; the rest come from `extends` (`default`/`dark` when absent). A v1 file (exactly the seven keys `accent`, `warm`, `success`, `error`, `warning`, `muted`, `prompt`) is still accepted and mapped onto the dark palette (`accent`→accent, `success`→ok, `error`→err, `warning`→warn, `muted`→fg2, `prompt`→fg0; `warm` is accepted and unused); a file cannot mix v1 keys with `extends`. Every colour is downgraded to the terminal's colour level (truecolor RGB, else the nearest xterm-256 entry, else the nearest ANSI colour — surfaces drop their background at 16 colours except the selection — and the identity under `NO_COLOR`). Unset ⇒ `default`.

### `ui.statusBar`

Kept: the status bar is always shown. The key is parsed and reported but hides nothing.

### `session.store`

Kept: `jsonl` is the only store. The key is parsed and reported; `sqlite` and `memory` are not implemented.

### `session.dir`

Not implemented: sessions stay under `~/.kubic/sessions`, and the key does not relocate them.

### `session.retentionDays`

Default keep-window (days) for `kubic sessions prune`: `--keep-days` overrides it. `0` means retention is off — prune exits 0 with `session retention is off (keep-days 0) — nothing is pruned`; unset, prune exits 1 naming both ways to set a window (`--keep-days`, or this key) rather than inventing one. Deletion stays explicit (`--yes`), dry-run is the default, and a session holding a live lock is never pruned — the lock is re-checked immediately before each delete, so a session locked between plan and delete is skipped too. The same window self-heals session journals at read time: `kubic log` (with `--session <id>` or the latest-session fallback) drops aged entries as it reads them — with retention unset, or `0`, the log path writes nothing. `kubic journal prune` reads `[journal] retentionDays` instead (see the paragraph below the table).

### `session.autoCompact`

Threshold compaction in `kubic run` and `kubic tui`: `false` disables it, `true` (and unset) keeps the automatic default. A non-boolean is refused by name.

### `session.reserveTokens`

Reserved-room tokens before a session compacts: unset ⇒ 16384. A value that is not a positive integer is refused by name. The effective reserve is clamped per model to at most a quarter of its context window (an 8192-token model reserves 2048), so a small-window model compacts sooner than the configured figure; `kubic config` and `kubic doctor` print the effective reserve.

### `session.keepRecentTokens`

Verbatim recent-context window a session keeps across a compaction: unset ⇒ 20000. A value that is not a positive integer is refused by name. The effective window is capped per model to a quarter of the room below its reserve (window − reserve), so it scales with the model: an 8192-token model keeps 1536, a 16384-token model 3072, a 32768-token model 6144, and the configured 20000 applies from a 96384-token window up. A `/compact` keeps at most 2000 tokens verbatim, whatever the window.

### `verify.tests`, `verify.build`, `verify.lint`, `verify.typecheck`

The gate commands (see [Gate verification](#gate-verification-verify)). After each `kubic run` settles, each configured command runs as `sh -c <command>` in the run's worktree and its exit status becomes the trajectory's `signal:<gate>` label (0 = `pass`). A gate with no command stays `unknown`. A blank or non-string command is refused by name at load. The command runs outside the approval interceptors, so each run of one is announced on stderr (`verify: running the <gate> gate: <command>`) and recorded as a `verify:<gate>` row in the audit ledger, and `kubic config` lists the commands that will run. A trusted project's config can set them: the trust question says so.

### `verify.timeoutMs`

Per-command bound for the `[verify]` gates, a positive integer of milliseconds up to 2147483647 (default 600000). A command still running at the bound is killed and its gate is `fail`.

### `run.timeoutMs`

Wall-clock bound for a headless `kubic run` (and the bare `kubic "<prompt>"`), a positive integer of milliseconds up to 2147483647 (default 300000). `--timeout` wins over it. A run still going at the bound settles `status: timeout` and exits 1.

### `run.maxTurns`

Turn bound for a headless `kubic run`: a positive integer (no bound by default). `--max-turns` wins over it. A run that reaches the bound exits 3 (`turn_limit`).

### `telemetry.enabled`, `telemetry.endpoint`, `telemetry.content`

OpenTelemetry export, off by default. With `enabled = true`, every `kubic run` and every settled `kubic tui` turn is sent to an OTLP/HTTP collector: the spans (`kubic.agent.run`, the phases of the run, `pi.tool.execute` per tool call) with the GenAI attributes — model, input and output tokens, cost — and the metrics `gen_ai.client.token.usage`, `kubic.cost`, `kubic.tool.errors` and `kubic.approvals`. The standard variables apply: `OTEL_EXPORTER_OTLP_ENDPOINT` (when `endpoint` is unset), `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME` and `OTEL_SDK_DISABLED`. No prompt, argument or output leaves unless `content = true`. See [OpenTelemetry](enterprise.md#opentelemetry).

### `cost.team`

The team a new session is billed to: recorded on the session with the OS user who ran it, so `kubic cost --by team` and `--by user` group spend by them. Set it in the managed config to bill a fleet by team. Sessions recorded before it report `(unknown)`.

### `providers.<name>.region` (`[providers.<name>]`)

The region a provider's endpoint runs in, for a provider whose region Kubic cannot read from its environment: Azure OpenAI, a gateway in models.json, a direct API. `[policy] allowed_regions` checks it. Read from the enterprise and product layers only — a region is the organization's declaration, so a global or project config setting one is refused by name. Amazon Bedrock and Vertex AI always use the region their environment selects.

### `sandbox.mode`, `sandbox.writable`

The bash tool's OS sandbox: `mode = "auto"` runs each bash command in Seatbelt (macOS) or bubblewrap (Linux) when the machine has it, `"required"` refuses to run without one, `"off"` (the default) does not sandbox. Inside it a command writes only to the workspace, the temporary directories and `writable` (anywhere under `filesystem = "full"`), opens no network connection unless `network = "full"`, and cannot read the credential paths (`~/.ssh`, `~/.aws`, …); a call the approval ask approved for `network` or `credentials` gets exactly that. The strictest mode any layer sets wins; `writable` is read from the enterprise, product and global layers only. `kubic doctor` reports the sandbox as `sandbox`. See [The bash sandbox](enterprise.md#the-bash-sandbox).

### `mcp.<name>` (`[mcp.<name>]`)

An MCP server the organization allowlists: a stdio server's pinned `command` (an absolute path) and `args`, or a streamable HTTP server's `url` (https, or plain http to this machine); the `version` it must report (a server reporting another is refused); the `tools` offered (all when absent), each named `mcp__<name>__<tool>`; the tools that always ask (`approve`); and the variables a stdio server receives (`env`, above the tool environment). Read from the enterprise and product layers only: a server another layer names is refused by name. See [MCP servers](enterprise.md#mcp-servers).

### `oidc` (`[oidc]`)

OIDC workload identity for `kubic run` and `kubic tui` in CI: `provider = "github"` requests the job's token from GitHub Actions (the job needs `permissions: id-token: write`), `provider = "env"` reads it from the variable `tokenEnv` names (GitLab's `id_tokens`, for example). `awsRoleArn` lets Amazon Bedrock assume that role with it, `gcpAudience` (the workload identity provider's resource name, `//iam.googleapis.com/projects/…/providers/…`) lets Vertex AI exchange it, impersonating `gcpServiceAccount` when set, and `gatewayAudience` offers a token for that audience to models.json as `$KUBIC_OIDC_TOKEN`. Read from the enterprise, product and global layers only: a project config setting any key is refused. See [Keys and workload identity](enterprise.md#keys-and-workload-identity).

### `tls.systemCa`

`true` makes Kubic trust the operating system's certificate store (the macOS keychain, the Windows store, the Linux system bundle) beside Node's bundled roots, so a provider behind a TLS-inspecting proxy whose corporate root the device management installed works without `NODE_EXTRA_CA_CERTS`. `KUBIC_SYSTEM_CA=1` turns it on for one invocation. Applied when the command starts; a Node without the API says so on stderr. See [Corporate networks](enterprise.md#corporate-networks).

### `managed.url`, `managed.refreshHours`

The organization's remote policy: a TOML config served at `url` (https, or plain http to this machine) with its Ed25519 signature at `<url>.sig`. A command that reads the config fetches it when the cached copy is older than `refreshHours` (24 by default), verifies it against the `policy.pub` beside the managed config, and keeps it in `~/.kubic/managed/`; every load verifies the cached copy again, and an unreachable server leaves the last verified copy in force. It is merged into the enterprise layer above the local file. Read only from the managed config — any other layer setting it is refused. See [Managed configuration](enterprise.md#managed-configuration).

### `policy.allowed_models`

The model gate: `provider/id`, `provider/*` (or `*` glob) patterns and bare model ids. A selection outside the list — `--model`, `[model]`, `KUBIC_MODEL`, a role pin, or the implicit first-available pick — exits 6 with a named policy refusal before any provider call; the implicit pick skips disallowed providers. It gates `kubic run`, `kubic tui` (boot and `/model` switches — a refused switch leaves the live model untouched) and the re-executing tiers of `kubic replay`.

### `policy.allowed_regions`

The regions a model endpoint may run in, as region ids or `*` globs (`["eu-*", "europe-*", "westeurope"]`). The region is read from the environment for Amazon Bedrock (`AWS_REGION`, `AWS_DEFAULT_REGION` or the profile) and Vertex AI (`GOOGLE_CLOUD_LOCATION`), is `local` for the testing provider and a models.json provider on this machine, and is what the managed config declares for any other provider (`[providers.<id>] region`). A model whose region is unknown or unlisted is refused before any request — at selection, on a resumed session and on a `/model` switch. See [Regions and fallbacks](enterprise.md#regions-and-fallbacks).

### `policy.allowed_providers`

The provider gate, applied with `allowed_models`: both lists intersect, so a provider the list omits is refused even when a pattern would name the model.

### `policy.allowed_tools`, `policy.denied_tools`

The tool intersection: `kubic run`/`kubic tui` (and the re-executing tiers of `kubic replay`) activate only tools that survive it, and the system prompt's `tools:` line names exactly that set. A deny holds against every lower layer, a role document and the model — a role that declares a denied tool is refused by name, while a role that declares none of them is unaffected by a deny-only policy. With no allow list, only the deny list narrows; with one, anything outside it is refused.

### `policy.network_policy`, `policy.allowed_domains`

`"proxy"` (the engine's allowlist mode) with `allowed_domains` starts the egress proxy each `kubic run` and `kubic tui` boot: the bash tool's environment points at it, a host off the list is refused (403), and every connection is a `network:egress` audit row with its host, port, decision and bytes; under `[sandbox]` on macOS it is the only connection a command can open. Entries are domains (`github.com` covers its subdomains, `*.github.com` only the subdomains) or IPs. Any other configured value is parsed and reported, not enforced, and `kubic doctor` fails `policy:enterprise-network` for it. The engine mode names (`none`, `allowlist`, `full`) are accepted too. See [The egress proxy](enterprise.md#the-egress-proxy).

### `policy.filesystem_policy`

Parsed and resolved (`workspace-only` is the engine's `workspace-write`; the engine level names are accepted). Kubic derives filesystem reach from the `[permissions]` classes, so this value is **not enforced** as a gate of its own; `kubic config` lists it (`kept`), `kubic doctor` does not report it.

### `policy.max_run_cost_usd`, `policy.max_daily_cost_usd`

Spend caps in US dollars, from the cost the providers report. `max_run_cost_usd` stops a `kubic run` once its own spend reaches the cap (a `kubic tui` process counts its spend since it started); `max_daily_cost_usd` refuses a run when this machine's spend for the UTC day has reached the cap, and stops one that reaches it. Unlike other policy keys, every layer may set a cap and the **lowest** wins, so a user can tighten an organization's cap but never loosen it. A run stopped by a cap exits 3 with status `spend_limit`; the check runs after each model response, so one response can overshoot the cap by its own cost. See [Spend caps](enterprise.md#spend-caps).

### `policy.project_policy`

What a repository may set for itself: `"open"` (the default) or `"restricted"`. Set in a layer above the project (enterprise, product or global; the first that sets it wins), `"restricted"` refuses a project config that sets `[approvals] autoApprove`, widens a `[permissions]` class past the layers above (or the defaults), or declares `[verify]` commands — the load names every such key, before anything runs — and keeps the project `models.json` providers out of the catalog (`kubic models` and `kubic doctor` name the file). A project may still narrow. See [Restricting project configuration](enterprise.md#restricting-project-configuration).

### `policy.data_policy`

Data loss prevention. `"redact"` runs the secret scanner (PEM private keys, key shapes, random-looking secret-named assignments, URL passwords, Basic credentials) over everything a session stores — its transcript, the run trajectory and the spans; the change journal keeps file content verbatim so `kubic undo` still restores it — and over the raw transcript `kubic sessions attach` prints. `"redact-model"` also scans each tool result before the model reads it and names every redaction. Any other value (`no-external-training`, …) is carried and reported, never claimed as enforced: no local mechanism can promise a provider-side policy. `kubic doctor` reports it as `policy:data`. See [Data loss prevention](enterprise.md#data-loss-prevention).

### `policy.logging_policy`

Parsed and carried (for example `full-audit`); no local mechanism is selected by it, so it is reported, never claimed as enforced.

### `hooks` (`[[hooks]]`)

Admin hooks: `event` = `beforeTool` | `afterTool` | `runEnd`, `command` (run as `sh -c` with a JSON payload on stdin and the tool environment, so no provider key), optional `tools` (the tool names a tool hook applies to; all when absent) and `timeoutMs` (default 5000). A `beforeTool` hook that exits non-zero refuses the call, naming the reason from its output; one that times out refuses it too (fails closed). Every hook run is audited (`hook:<event>`). Read from the enterprise, product and global layers, all of them; a project config declaring hooks is refused. See [Admin hooks](enterprise.md#admin-hooks).

### `audit` (`[[audit]]`)

Sink tables (`sink` = `syslog` | `https` | `otlp` | `file` | `memory`, `level` = `privileged` | `all`, optional `target`, `facility`, `ca` and `tokenEnv`). Parsed and validated fail-closed (an unknown kind, level or key is named); every audit row fans out to the configured sinks plus the mandatory, hash-chained repo ledger. A collector over the network (`tcp://`/`tls://` syslog, `https`, `otlp`) is spooled on disk and drained when it answers (see [Audit sinks](enterprise.md#audit-sinks-audit)).

### `skills`

Settings skills: files or directories loaded with source `settings` in every session a command starts — `kubic run`, `kubic tui`, the suite runs of `kubic eval`/`kubic benchmark` and the re-executing tiers of `kubic replay` (see [Settings skills](#settings-skills)). Project-layer entries apply only for a trusted project; a non-string or blank entry is refused by name at load.
<!-- /generated:config-keys -->

## Skills, instructions and gates

### Settings skills

```toml
skills = ["./team", "/opt/shared/skills"]
```

A top-level array of skill files or directories. Each entry loads with source
`settings` (like an explicit `--skill`, it applies even under `--no-skills`)
in every session a command starts: `kubic run`, `kubic tui`, the suite runs
of `kubic eval` and `kubic benchmark`, and the re-executing tiers of `kubic
replay`, which discover skills at the pinned worktree. A relative entry
resolves against the directory of the config file that declared it, never
the working directory, so a project config's `"../shared"` names the
project's sibling wherever the run starts; an absolute entry is used as
written. `~` and environment variables are not expanded. The first layer that
sets the key wins the whole array (enterprise, then product, global and
project), and a project's entries apply only once the project is trusted,
exactly like every other project key. `kubic config` reports the resolved,
absolute list with its layer.

The user discovery roots are `~/.pi/agent/skills` and `~/.agents/skills`
(Pi-compatible) plus `~/.kubic/skills`: the Kubic-native root is read last,
so it wins a same-name conflict with a Pi-carried skill.

### Project instructions (`AGENTS.md`)

Kubic follows the cross-agent `AGENTS.md` convention. `kubic run` and
`kubic tui` read one `AGENTS.md` per directory, from the repository root
(the nearest ancestor holding `.git`) down to the working directory — the
working directory alone outside a repository — and append them to the system
prompt as one `<project_instructions>` section, outermost first, so the file
nearest the work comes last. The section sits after the
`[agent] systemPromptFile` text and ahead of the skills block.

- **Trust.** A file loads only when its directory is trusted, exactly like
  the project skills: a grant for `/repo` covers `/repo/AGENTS.md` from any
  subdirectory, and `/repo/pkg/AGENTS.md` needs a grant for `/repo/pkg`
  (`kubic trust /repo/pkg`). The grant's fingerprint covers the root
  `AGENTS.md`, so an edited file asks again (see
  [What a grant covers](trust.md#what-a-grant-covers)). A file from an
  untrusted directory is left out and named on stderr (`kubic run`) or in
  the boot notices (`kubic tui`).
- **Size.** Each file reaches the prompt up to 32 KiB. A longer one is cut on
  a character boundary, the prompt says it was cut, and the run names it.
- **Reporting.** `kubic config` prints a `project instructions:` line (and
  an `instructions` object under `--json`) naming every file a run from the
  current directory would load or leave out; `kubic doctor` reports the same
  as its `instructions` check, a warning when a file is cut or left out.
- **Off switch.** `[agent] projectInstructions = false` turns the search off;
  set in the enterprise layer, it holds against every lower layer.

### Gate verification (`[verify]`)

```toml
[verify]
tests = "npm test"
typecheck = "npm run typecheck"
timeoutMs = 600000
```

With at least one command configured, every `kubic run` verifies its work
after it settles, before it writes its trajectory:

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
[the eval package](../packages/eval.md). With no
`[verify]` section nothing runs and every gate stays `unknown`. `kubic tui`
turns are not verified.

The commands are ordinary shell commands run with your permissions,
outside the approval interceptors, so they come only from layers you trust:
a project `.kubic/config.toml` is refused until the project is trusted, and
the trust question names its `[verify]` commands among what a grant lets
the project do (see [project trust](#project-trust)). Each command a run
executes is announced on stderr when it starts — `verify: running the tests
gate: npm test`, and `… at the base revision: …` for the baseline checkout —
and recorded as a `verify:<gate>` row in the workspace's audit ledger
(`.kubic/audit/audit.jsonl`, a privileged action) with its verdict.
`kubic config` lists the commands that will run, with their layer.
Verification adds the commands' run time to every `kubic run`.

## What lives where

`.kubic/` is a **mixed** directory: configuration is committed, run state is
not.

- **Committed**: `.kubic/config.toml`, `.kubic/roles/*.md`.
- **Runtime state (never committed)**: `.kubic/audit/`, the approval audit
  ledger. Sessions and their journals live outside the workspace, under the
  sessions root (`~/.kubic/sessions`).
- **How a repository gets the rules**: every `kubic run` and `kubic tui`
  invocation, before it creates any state, writes that runtime prefix into the
  repository's **local, uncommitted** exclude file (`.git/info/exclude`), in a
  marked block it rewrites in place on later runs. So nothing of Kubic's own
  appears in `git status`, and your committed `.gitignore` is never touched.
  `kubic doctor` checks the same file the writer writes: it resolves the
  repository with `git rev-parse --show-toplevel` and the exclude with `git
  rev-parse --git-path info/exclude`, so a linked worktree checks the common
  directory's exclude, and a run from a subdirectory checks the root's.
  `.kubic/` itself is deliberately **not** ignored, so `config.toml` and
  `roles/*.md` stay committable. Outside a git repository there is nothing to
  write and nothing to check, and the write never fails a run. This
  repository's own `.gitignore` ignores its whole `.kubic/` directory
  (`/.kubic/`) and also lists the same rule, because `kubic doctor` checks for
  that literal line.
- **Models**: see [where the models come from](#where-the-models-come-from).
- **Sessions store**: `~/.kubic/sessions` by default. Retention is opt-in
  and manual: `kubic sessions prune` lists candidates by default and
  deletes only with `--yes`, and `[session] retentionDays` supplies the
  default keep-window; a session a live process holds is never pruned.
- **Journal**: each run journals into its session, at
  `<sessions-root>/<id>/journal`. With the store's default `durable` on, the
  content an entry references is flushed before the entry is: a blob's bytes
  are fsynced before its rename and its directory after it, and the index
  line is fsynced before the append returns. A few fsyncs per tool write are
  the price of "reversible": a crash can neither take back a change the
  journal promised to undo nor leave a durable entry pointing at bytes that
  were never written. The retention rewrite is flushed the same way, so a
  crash right after it cannot leave an empty index where the whole history
  was ([journal and safety](../architecture/journal-and-safety.md);
  `JournalRetention.durable` is the programmatic opt-out, which trades all of
  it for a crash window of one truncated last line). Growth is bounded by
  `[journal] retentionDays`, `[journal] maxBytes` (the whole store: index plus
  blobs) and the 100 MiB default size cap. `kubic journal prune` removes
  entries older than the keep window on request, a dry run unless `--yes`.

### Two retention windows

`kubic journal prune` removes journal entries older than `[journal]
retentionDays`, read from the runtime load: the
`KUBIC_JOURNAL_RETENTION_DAYS` variable beats the file key, and
`--keep-days` beats both. An append also trims past `[journal]
retentionDays`. Reading a session's journal with `kubic log --session <id>`
deletes entries past `[session] retentionDays` (it is not a dry run), and
only for a session no live run is attached to. So a read applies only
`[session] retentionDays`, and `kubic journal prune` applies only `[journal]
retentionDays` (or `--keep-days`). To have one window, set both keys to the
same value.

### Where the models come from

Pi's built-in providers (`anthropic`, `openai`, `google`, `amazon-bedrock`,
…) are always registered; each is usable once its documented environment key
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …) or its ambient
credentials are set, and a built-in without a key is never selected
implicitly (`kubic models` shows which are usable). Anthropic is also usable
through workload identity federation (`ANTHROPIC_FEDERATION_RULE_ID`,
`ANTHROPIC_ORGANIZATION_ID` and `ANTHROPIC_IDENTITY_TOKEN_FILE`, with an
optional `ANTHROPIC_SERVICE_ACCOUNT_ID` or `ANTHROPIC_WORKSPACE_ID`), which Pi
resolves only when no `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set.
Only **chat** models are listed or selected: the catalogue's image and
classifier entries never appear in `kubic models` and are never picked.
Custom providers come from [`models.json`](models.md#modelsjson).

A model without `contextWindow` and `maxTokens` gets the fail-safe defaults
`8192` and `2048`, because small local servers overflow above them. The
compaction reserve (`[session] reserveTokens`, default 16384) is clamped to a
quarter of the model's window (an 8192-token model reserves 2048), and the
kept window (`[session] keepRecentTokens`, default 20000) to a quarter of the
room below that reserve, so a small-window model compacts only near its limit.
`kubic run` and `kubic tui` use the same three `[session]` keys
(`autoCompact`, `reserveTokens`, `keepRecentTokens`), and `kubic config` and
`kubic doctor` print the reserve in effect after the clamp.

The system prompt and the default tool set take about 2800 tokens of every
request, so the room a compaction leaves is smaller than the window suggests.
As estimates (the threshold, minus those 2800 tokens and the kept window, with
a summary of 700 to 1400 tokens): about 360 to 1060 tokens on an 8192-token
window, roughly one exchange, so agent work needs a larger window; about 5000
on 16384; about 14300 on 32768; and about 91000 on 131072. `kubic doctor`
warns (`context-room`) when a model you can configure, one defined in
`models.json` or your default model, keeps less than 4096 estimated tokens of
room.

## See also

- [Project trust](trust.md): the trust store and what a grant covers.
- [Models and providers](models.md): `models.json` and provider keys.
- [For teams](enterprise.md): the managed layers, policy and audit.
- [Doctor and debug](doctor-and-debug.md): the `kubic doctor` checks, including
  the honest limits it states: Kubic runs in-process with your authority, the
  approval policy routes asks rather than enforcing them, and the journal is a
  review and undo log, not a backup.
