# Configuration

> Implementation:
> `packages/host/src/config/config.ts` (layers, TOML, merge),
> `runtime.ts` (the load the binary actually runs on), `config-cli.ts`
> (`kubic config`), `stances.ts` (refusals), `../secret-refs/secrets.ts`
> (request-time secrets) and `../policy/` (the `[policy]` engine).
> This table matches that implementation exactly.

## Precedence: first layer wins

Six layers, highest first, then the documented environment overrides, then
an explicit CLI flag. Merge is per leaf path: the first (highest) layer to
set a key owns it — a lower layer attempting to override a set key is
reported in `overriddenAttempts`, never applied. Enterprise keys are frozen
against every override attempt, the environment and the CLI included.

| # | Layer | Source file | Notes |
| --- | --- | --- | --- |
| 1 | `enterprise` | `/etc/kubic/config.toml` (or an explicit `enterprisePath` override) | Highest. Never overridden — by a file, the environment, or a flag. |
| 2 | `product` | `/etc/kubic/product.toml` (or an explicit `productPath` override) | The distribution/vertical profile, below enterprise and above the user's own files. |
| 3 | `global` | `~/.kubic/config.toml` | Your machine-wide defaults. |
| 4 | `project` | `<projectRoot>/.kubic/config.toml` | Resolved as the nearest directory, from the cwd up, that holds `.kubic/` or `.git` (the home directory's `.kubic/` is the global layer, never a project), the cwd itself when none does — so `kubic config` and `kubic run --role` from a subdirectory read the same committed project as from the root, and a subdirectory with its own `.kubic/` is a project of its own. **Trust-gated**: refused by path before it is read (`ProjectUntrustedError`) until the project is trusted (`kubic trust`, the `kubic tui` prompt, or `KUBIC_TRUST_PROJECT=1` for one invocation) — the grant is recorded at, and checked against, that same root, so trusting the root covers runs from its subdirectories, and it covers the project's files as they were when it was given: a change to them refuses the layer again until `kubic trust` re-confirms it ([what a grant covers](trust.md#what-a-grant-covers)); absent file counts as an empty layer. |
| 5 | `session` | Supplied programmatically | Never a file. **Unused**: no shipped caller supplies a session layer (attaching a session does not feed its recorded settings back), so this layer is always empty. |
| 6 | `agent` | Supplied programmatically | Never a file. Lowest. **Unused**: no shipped caller supplies an agent layer, so this layer is always empty. |
| — | `env` | The `KUBIC_*` overrides below | Above every file layer, below `enterprise`, below the CLI. |
| — | `cli` | e.g. `--model`, `--thinking` | Highest, except against a frozen `enterprise` key. |

The `cli` flags are `--model <provider/id>` and
`--thinking <level>`, accepted by `kubic run`, `kubic tui`
and `kubic config`: they are the session overrides, above the
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
never silently: `kubic run` and `kubic tui` print one note per overridden
pin on stderr at boot (`note: --model evil/other
ignored: model pinned by enterprise policy (corp/approved)`, and
`note: KUBIC_MODEL=evil/other ignored: …` for the env pin), and `kubic
config` lists the attempt under `overriddenAttempts`. The note is stderr
only, so a `--json` envelope stays one document, and a pin equal to the
enterprise one says nothing. The freeze binds the whole session, not only the
boot: the TUI's `/model` (the same session-override level as `--model`)
cannot leave a frozen pin. A refusal of an unknown provider/model names
the input that carried the pin: `--model`, `KUBIC_MODEL`, `[model] in
<layer> config`, or `role model` — and, when a registered provider or
model id is close, ends with `; did you mean '<id>'?`.

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
| `KUBIC_TRUST_PROJECT` | `1`/`true` accepts the project layer — `config.toml` and the project [`models.json`](models.md#modelsjson) — for this invocation, above the persistent store and without recording anything. |
| `KUBIC_SKIP_SETUP` | `1` skips the first-run setup a bare `kubic` on a terminal runs when there is no `~/.kubic/config.toml` (see [`kubic setup`](models.md#kubic-setup)). |

A malformed value fails closed with the variable named — it never silently
falls back to a default.

`KUBIC_PROVIDER` is not a config key: `KUBIC_PROVIDER=faux` selects the
scripted **testing** provider for one invocation (no network, no model),
and any other non-empty value is refused by name — see
[the testing provider](run.md#testing-provider-kubic_providerfaux).

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
approvals, permissions, journal retention and out-of-scope paths).
`kubic config --json` emits
the same thing as one object — `values`: `{ key, value, layer }` per set
key, and one object per projection. A broken config (unknown key, refused
project layer, a secret ref) exits 1 with the named reason instead of
printing defaults. The commands that consume the config (`run`, `tui` —
including `attach` and `resume`, which boot the same lane — `replay`,
`policy`, `eval`, `benchmark`) refuse a broken config the same way: one
`error: <reason>` line on stderr, exit 1, stdout empty (so a `--json`
consumer never parses the refusal as data). `policy` refuses because it
reports the posture a run would actually enforce — answering
from built-in defaults would be more permissive than what you configured.
`kubic config --help` (or `-h`) prints the generated help and exits 0
without loading anything; an unknown flag prints one `error: …` line on
stderr and exits 2.

A refusal also stops every other command that reads the config: `kubic run`,
`kubic tui` (including `attach`/`resume`), `kubic replay`, `kubic policy`,
`kubic eval` and `kubic benchmark` exit 1 with
the named reason rather than proceeding on built-in defaults while you
believe your config file is in force. `kubic config`, `kubic doctor` and
`kubic trust` still run, so you can see what is wrong (doctor reports the
load as `dep:config-load (deps-missing)`).
Commands that consume no config projection (`git`, `diff`, `cost`, `audit`,
`export`, …) are unaffected. `kubic models` reads only
the trust report, which exists independently of the load, so it is
unaffected too. `kubic sessions` reads exactly one projection —
`session.retentionDays`, the default keep-window for `kubic sessions prune`
— and `kubic log` reads the same key to self-heal session journals at read
time; a refused config simply leaves both without a window: prune then
demands an explicit `--keep-days` rather than falling back to a default
(deletion stays explicit either way), and `log` writes nothing.

A minimal `.kubic/config.toml` that actually changes behaviour:

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
to the boot baseline and the end-of-run sweep — a build or formatter
that touches a declared path produces no unattributed journal entry. Patterns
and negations belong in `.gitignore` — the walk honours the root's rules and
every nested file's, child rules after the parent's; `.git/` and
`.kubic/` are hard-skipped before any config. An empty entry (`[""]`) is
refused by name — it would match nothing.

## `kubic config [--json] [--model <provider/id>] [--thinking <level>]`

The effective configuration with the layer each value came from — see
[configuration](#seeing-the-effective-values). `--json`
prints one pretty-printed JSON document. `--model <provider/id>` reports
the config as if that session override were passed, so the `model.*` rows
and the `selected model:` line carry the `(cli)` source the `run`/`tui`
lane would use. `--thinking <level>` does the same for the thinking level:
the `thinking level:` line carries the `(cli)` source the lane boots with.
A refused config prints
`error: <reason>` on stderr and exits 1; usage errors exit 2.

## Shape (canonical sections)

<!-- generated:config-sections -->
- `[agent]`: `name`, `systemPromptFile`
- `[model]`: `provider`, `id`, `thinking`, `timeoutMs`, `maxRetries`, `maxRetryDelayMs`, `cacheRetention`, `escalate`, `maxEscalations`
- `[approvals]`: `route`, `maxPendingMs`, `autoApprove`, `sessionScoped`, `requireJustification`
- `[permissions]`: `filesystem`, `shell`, `network`, `git`, `credentials`
- `[journal]`: `retentionDays`, `maxBytes`, `outOfScope`
- `[roles.<name>]`, one table per name: `model`, `tools`, `requires`, `thinking`, `models`, `escalate`, `timeoutMs`, `maxRetries`, `maxRetryDelayMs`, `cacheRetention`
- `[ui]`: `theme`, `statusBar`
- `[session]`: `store`, `dir`, `retentionDays`, `autoCompact`, `reserveTokens`, `keepRecentTokens`
- `[verify]`: `tests`, `build`, `lint`, `typecheck`, `timeoutMs`
- `[run]`: `timeoutMs`, `maxTurns`
- `[policy]`: `allowed_models`, `allowed_providers`, `allowed_tools`, `denied_tools`, `network_policy`, `allowed_domains`, `filesystem_policy`, `data_policy`, `logging_policy`
- `[[audit]]`, an array of tables: `sink` (required), `level` (required), `target`, `facility`
- `skills`: a top-level key, not a section
<!-- /generated:config-sections -->

Unknown sections or keys are rejected (`ConfigError`). The canonical example
is `packages/host/src/config/example.toml`, generated from the same schema as
the list above — copy it to start.

The value vocabularies: thinking levels `off`, `minimal`, `low`, `medium`,
`high`, `xhigh`, `max`; approval routes `ask-user` or `deny`; permission
classes filesystem (`none`, `read`, `workspace-write`, `full`), shell (boolean
or `read-only-allowlist`), network (`none`, `allowlist`, `full`), git
(boolean, `workspace`, `full`) and credentials (`none`, `allowlist`) — four of
these cannot be expressed by the tool set and are reported as unsupported by
`kubic doctor` and `kubic policy`, enforced as the named narrower level:
network `allowlist` → `none` (no domain list exists, so every network command
is blocked and raises the network approval trigger), credentials `allowlist`
→ `none` (no credential list exists, so every access to a listed credential
path raises the credential trigger), filesystem `full` → `workspace-write`,
git `full` → `workspace`. `[ui] theme` is a built-in name or a JSON theme
path.

Every millisecond key (`timeoutMs`, `maxRetryDelayMs`, `maxPendingMs`) is at
most 2147483647 (about 24.8 days), the longest delay a timer can hold: a
longer one would fire at once, so the load refuses it by name.

`skills = ["...", ...]` lists files or directories of skills, loaded with
source `settings` (see [Settings skills](#settings-skills) below). It is a
top-level key, not a `[skills]` section: a `[skills]` table is rejected like
any unknown section.

Every one of those keys is in the key-effect table below: **consumed** keys
name the code path that reads them, **kept** keys are reserved with the
reason they are not consumed, and a key with no row at all fails `kubic
doctor`'s config check by name. `kubic config` prints the disposition of
every effective value (`(project, consumed)`), so a config file can never
quietly stop configuring anything.

<!-- generated:config-keys -->
| Key | Effect |
| --- | --- |
| `agent.name` | The lane's agent id: journal entries are attributed to it. Unset ⇒ `root`, unchanged. |
| `agent.systemPromptFile` | Prompt augmentation: a path whose contents are read at load and appended to the assembled system prompt — ahead of the skills block — for `kubic run`, `kubic tui` and the live tiers of `kubic replay`. A leading `~/` expands to the home directory; a relative path resolves against the declaring config file's directory, so the shipped example's `SYSTEM.md` travels with `example.toml`. Global-layer paths are always allowed; a project-layer path applies only when the project is trusted (an untrusted project's file is refused pre-trust with the trust message, before it is read) and must resolve inside the project root — a trusted path outside it, or a symlink whose target lies outside it, is refused by name. A missing or unreadable file is a named `ConfigError`, never a silent skip. `kubic config` reports the effective (resolved) path; the contents never render. |
| `model.provider`, `model.id` | Selects the provider/model for `kubic run` and `kubic tui` (`selectModel`); `--model` and `KUBIC_MODEL` beat it as the `cli`/`env` layers of the config load, and a frozen enterprise `[model]` beats all of them (announced on stderr). |
| `model.escalate`, `model.maxEscalations`, `roles.<name>.escalate` | The escalation ladder: `escalate` lists the rungs as concrete `provider/id` refs in climbing order (wildcards refused per entry at load); a role's `escalate` wins outright for runs as that role, even an empty list (which freezes every `/model` switch — opting out of climbing, not of the gate). `maxEscalations` bounds the climbs per run, unset meaning the ladder length. Climbs are one-way (a down-step or off-ladder target is refused by name with the live model untouched) and recorded: `/model <ref>` climbs the ladder silently, `/escalate <ref> [reason]` climbs naming why, and three consecutive tool-failure turns climb one rung automatically — once per run, never back (`kubic run` settles one turn per invocation, so the automatic trigger lives on the `kubic tui` lane). Every climb appends an `escalation: <from> → <to> (<reason>)` transcript row and lands on the trajectory's `model.escalations` (per-model usage already attributes the spend each side of the move). |
| `model.thinking` | The file-layer thinking default. The lane boots with the winner of `--thinking` > `KUBIC_MODEL_THINKING` > session record > role default > this key, clamped to the effective model's supported levels (a clamp is one stderr notice naming the model, the request and the level applied, never a silent rewrite); the applied level is committed to the session and recorded in `trajectory.json`. A level the vocabulary does not know is refused by name at load. |
| `model.timeoutMs`, `model.maxRetries`, `model.maxRetryDelayMs`, `model.cacheRetention` | Request options on the lane (`settings.stream`): `timeoutMs` bounds one provider request (a positive integer of milliseconds), `maxRetries` caps the provider/SDK retries inside one request attempt and `maxRetryDelayMs` caps the delay a server may ask for before a retry (non-negative integers: `0` disables retries / the cap), and `cacheRetention` is the prompt cache preference (`none`, `short`, `long`). `[roles.<name>]` layers each of them per key for runs as that role. A mistyped value is refused by name at load. |
| `approvals.route` | Approval routing (`ask-user` \| `deny`), installed by `kubic run`, `kubic tui`, `kubic replay` and reported by doctor's `policy:installed` line. `deny` refuses every challenged call with `denied by policy route` (exit 4) and never opens the TUI overlay — `autoApprove` entries never apply under it (the lane denies them too, and doctor fails `policy:approvals` for the combination). `KUBIC_APPROVALS_ROUTE` overrides it. |
| `approvals.maxPendingMs`, `autoApprove`, `sessionScoped`, `requireJustification` | Installed on the lane (`run`, `tui`, `replay`) from the same projection doctor prints, so `policy:approvals` and `policy:installed` always show the same route and bound (doctor fails `policy-mismatch` if they ever differ). `maxPendingMs` bounds the TUI overlay: an unanswered ask denies on timeout. `autoApprove` is explicit-only and applies headless too (the audit record says `approved by autoApprove`), except for an always-ask capability (`kubic-state-write`): naming it is accepted but ignored — it takes the normal ask path (the TUI seat, or the instant no-surface refusal headless, never a `maxPendingMs` stall), `kubic doctor`'s `policy:approvals` line warns by name and `kubic config` counts it as not auto-approved. `requireJustification = true` denies any approval that carries no justification (the TUI overlay and `autoApprove` supply none, so every challenged call is refused). `sessionScoped = false` is refused by the config load: decisions are always stored per session. Only real answers (user, route, autoApprove) persist to `approvals.json` — a timeout denies the call but stores nothing, so a later surface can still ask about the same operation. |
| `permissions.*` | Permission classes → the lane's derived tool allowlist. `shell = "read-only-allowlist"` keeps `bash` but enforces an explicit read-only command allowlist at the guard: every `|`/`||`/`&&`/`;`/`&`/newline segment must head with `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `find` or `git`, and then only in its read-only form — `git status`/`diff`/`log`/`show` (after global options like `-C`/`--no-pager`, without `--output`, and never `-c`/`--config-env`/`--exec-path`/`--upload-pack`/`--receive-pack`, which can execute code), `find` without `-exec*`/`-ok*`/`-delete`/`-fprint*`/`-fls`, `rg` without `--pre`/`--hostname-bin`. Redirection (`>`, `>>`, any fd form) is refused, `sed`/`perl` with `-i`/`--in-place` are refused, and any other verb (`tee`, `rm`, `npm`, `node`, `cp`, …) is blocked by name. Expansion and substitution are never interpreted and are refused outright — `$(…)`, backticks, `<(...)` process substitution and any unquoted `$` (single-quoted text is literal and stays readable) — because an allowed head verb could otherwise launder another command. The parser is lexical, so it over-blocks rather than under-blocks; `shell = true` is unchanged (no allowlist). |
| `journal.retentionDays` | Journal age bound (days), enforced on every append. `0` means retention is off: no age bound is installed, the same reading `kubic journal prune --keep-days 0` has, and `kubic config` prints `journal retention: off`. Unset installs no bound either. It is also the default keep window of `kubic journal prune` (`--keep-days` overrides it). |
| `journal.maxBytes` | Journal byte bound, enforced on every append: the store — `index.jsonl` plus the blobs it references — is pruned to stay under it, and a pass that has to prune frees a tenth of the bound (the headroom the next appends need). Content addressing dedupes blobs, so a file toggling between two contents (a formatter fighting the agent, repeated `undo --step`) grows the journal through its lines alone; this key is what keeps that bounded. A positive integer (0 is refused by name: it is not "retention off" — unset is — it is a bound nothing fits). Unset ⇒ 100 MiB (`DEFAULT_JOURNAL_MAX_BYTES`). An entry whose own content cannot fit is refused before anything is written, so the tool call fails as `journal_failed` with the file untouched, and a pass that has to prune never drops the newest entry — the store stays over its bound by that entry instead. |
| `journal.outOfScope` | Paths excluded from the baseline and the end-of-run sweep (self + children): `outOfScope = ["dist"]` ⇒ `dist/`, `dist/**`. Path-boundary aware (`dist` never matches `dist-x`). An entry is read as the plain path it names (`./dist` and `dist/` are `dist`); an empty entry, one that names the whole workspace (`.`) and one outside it (`../x`, `/abs`) are refused by name. A change under an excluded path is never journaled, so `kubic undo` cannot restore it: `kubic doctor` warns about every excluded path (`journal:out-of-scope`), and the trust question names journal coverage among what a project config sets. |
| `roles.<name>.model`, `roles.<name>.tools`, `roles.<name>.thinking`, `roles.<name>.requires`, `roles.<name>.models` | Per-role defaults layered under the role document for `kubic run --role <name>`: `model` is a `provider/id` pin the run selects unless an explicit `--model`/`[model]` pin wins, `tools` replaces the document's own list, `thinking` is the role's thinking default — below the session's stored level and any `--thinking`/`KUBIC_MODEL_THINKING` override, above the `[model].thinking` file default — `requires` names tools that always require approval under the role — unioned with the document's own `requires:` list, never subtracted. `models` is the role's allowed model set: entries are `"provider/id"` or `"provider/*"` strings, or `{ id, thinking? }` tables whose thinking beats the flat role default for the matched model — an empty set (or none) allows every registered model, a malformed entry is refused by name at load, and selection plus every `/model` switch resolve against it, refusing out-of-set by name (`kubic config` renders the winning layer's list with provenance; `/scoped-models` reports the resolved set on the TUI lane). Each leaf is attributed to the layer that set it (enterprise > product > global > project > session > agent). A malformed model ref, an unknown thinking level, a malformed set entry, or a mistyped request option is refused by name at load. Scope: `kubic run --role` and `kubic tui --role` both apply the whole layer (model pin + tools + thinking + requires + models) and install the most restrictive merge of the config classes and the role's (a role declaring `network: none` runs under it even when config allows full); the TUI also takes the `[agent].name` agent id. No role, model or provider is invented when none of those levels sets one. `timeoutMs`/`maxRetries`/`maxRetryDelayMs`/`cacheRetention` layer over the `[model]` request tuning per key for runs as that role. |
| `.kubic/roles/<name>.md` frontmatter `name`, `description`, `model` | The role document's own Pi-agent keys: `name` aliases `role` (a document disagreeing with itself is refused by name), `description` is shown by `kubic doctor` in the role detail, and `model` is a `provider/id` pin validated at parse (a malformed ref is refused with its reason before any lane boots). Precedence for the model pin: an explicit CLI pin beats `[roles.<name>].model`, which beats the document pin (a layer winning over the document is precedence, never an overridden attempt); the winning pin reaches `kubic run --role`/`kubic tui --role` through the existing role-model selection. |
| `ui.theme` | TUI theme (token themes). A built-in name — `default` or `dark` (the shipped Konic brand palette), `light` (for light terminal backgrounds) or `terminal` (your terminal's own colours: no backgrounds of its own, semantic colours on the ANSI palette slots) — or a path to a JSON theme file, read relative to the current directory (an absolute path is taken as typed). Resolved and validated **before the alt-screen opens**: a missing file, malformed JSON, an unknown key or colour, an unknown `extends` base, or a value that is not `#rrggbb` is one `error: theme '<ref>': …` line on stderr and exit 2 (the message never quotes the file). A theme assigns colours to the design-token roles: `bg0`–`bg3` surfaces, `fg0`–`fg3` text levels, `accent`/`accentBg`, `ok`/`okBg`, `warn`/`warnBg`, `err`/`errBg`, `info`, `add`/`addBg`, `del`/`delBg`, `addWordBg`/`delWordBg` (the changed words of a diff line). Schema (v2): `{ "name": "mine", "extends": "dark", "colors": { "accent": "#00aaff", "bg2": "#202030" } }` — any subset of roles; the rest come from `extends` (`default`/`dark` when absent). A v1 file (exactly the seven keys `accent`, `warm`, `success`, `error`, `warning`, `muted`, `prompt`) is still accepted and mapped onto the dark palette (`accent`→accent, `success`→ok, `error`→err, `warning`→warn, `muted`→fg2, `prompt`→fg0; `warm` is accepted and unused); a file cannot mix v1 keys with `extends`. Every colour is downgraded to the terminal's colour level (truecolor RGB, else the nearest xterm-256 entry, else the nearest ANSI colour — surfaces drop their background at 16 colours except the selection — and the identity under `NO_COLOR`). Unset ⇒ `default`. |
| `ui.statusBar` | Kept: the status bar is always shown. The key is parsed and reported but hides nothing. |
| `session.store` | Kept: `jsonl` is the only store. The key is parsed and reported; `sqlite` and `memory` are not implemented. |
| `session.dir` | Not implemented: sessions stay under `~/.kubic/sessions`, and the key does not relocate them. |
| `session.retentionDays` | Default keep-window (days) for `kubic sessions prune`: `--keep-days` overrides it. `0` means retention is off — prune exits 0 with `session retention is off (keep-days 0) — nothing is pruned`; unset, prune exits 1 naming both ways to set a window (`--keep-days`, or this key) rather than inventing one. Deletion stays explicit (`--yes`), dry-run is the default, and a session holding a live lock is never pruned — the lock is re-checked immediately before each delete, so a session locked between plan and delete is skipped too. The same window self-heals session journals at read time: `kubic log` (with `--session <id>` or the latest-session fallback) drops aged entries as it reads them — with retention unset, or `0`, the log path writes nothing. `kubic journal prune` reads `[journal] retentionDays` instead (see the paragraph below the table). |
| `session.autoCompact` | Threshold compaction on the lane (`run`, `tui`): `false` disables it, `true` (and unset) keeps the automatic default. A non-boolean is refused by name. |
| `session.reserveTokens` | Reserved-room tokens before the lane compacts: unset ⇒ 16384. A value that is not a positive integer is refused by name. The effective reserve is clamped per model to at most a quarter of its context window (an 8192-token model reserves 2048), so a small-window model compacts sooner than the configured figure; `kubic config` and `kubic doctor` print the effective reserve. |
| `session.keepRecentTokens` | Verbatim recent-context window the lane keeps across a compaction: unset ⇒ 20000. A value that is not a positive integer is refused by name. The effective window is capped per model to a quarter of the room below its reserve (window − reserve), so it scales with the model: an 8192-token model keeps 1536, a 16384-token model 3072, a 32768-token model 6144, and the configured 20000 applies from a 96384-token window up. A `/compact` keeps at most 2000 tokens verbatim, whatever the window. |
| `verify.tests`, `verify.build`, `verify.lint`, `verify.typecheck` | The gate commands (see [Gate verification](#gate-verification-verify)). After each `kubic run` settles, each configured command runs as `sh -c <command>` in the run's worktree and its exit status becomes the trajectory's `signal:<gate>` label (0 = `pass`). A gate with no command stays `unknown`. A blank or non-string command is refused by name at load. The command runs outside the approval interceptors, so each run of one is announced on stderr (`verify: running the <gate> gate: <command>`) and recorded as a `verify:<gate>` row in the audit ledger, and `kubic config` lists the commands that will run. A trusted project's config can set them: the trust question says so. |
| `verify.timeoutMs` | Per-command bound for the `[verify]` gates, a positive integer of milliseconds up to 2147483647 (default 600000). A command still running at the bound is killed and its gate is `fail`. |
| `run.timeoutMs` | Wall-clock bound for a headless `kubic run` (and the bare `kubic "<prompt>"`), a positive integer of milliseconds up to 2147483647 (default 300000). `--timeout` wins over it. A run still going at the bound settles `status: timeout` and exits 1. |
| `run.maxTurns` | Turn bound for a headless `kubic run`: a positive integer (no bound by default). `--max-turns` wins over it. A run that reaches the bound exits 3 (`turn_limit`). |
| `policy.allowed_models` | The model gate: `provider/id`, `provider/*` (or `*` glob) patterns and bare model ids. A selection outside the list — `--model`, `[model]`, `KUBIC_MODEL`, a role pin, or the implicit first-available pick — exits 6 with a named policy refusal before any provider call; the implicit pick skips disallowed providers. It gates `kubic run`, `kubic tui` (boot and `/model` switches — a refused switch leaves the live model untouched) and the re-executing tiers of `kubic replay`. |
| `policy.allowed_providers` | The provider gate, applied with `allowed_models`: both lists intersect, so a provider the list omits is refused even when a pattern would name the model. |
| `policy.allowed_tools`, `policy.denied_tools` | The lane tool intersection: `kubic run`/`kubic tui` (and the re-executing tiers of `kubic replay`) activate only tools that survive it, and the system prompt's `tools:` line names exactly that set. A deny holds against every lower layer, a role document and the model — a role that declares a denied tool is refused by name, while a role that declares none of them is unaffected by a deny-only policy. With no allow list, only the deny list narrows; with one, anything outside it is refused. |
| `policy.network_policy`, `policy.allowed_domains` | Parsed and resolved into the effective policy: `"proxy"` is carried as the engine's allowlist mode. **Not enforced:** Kubic has no proxy-mediated enforcement, so these keys protect nothing; `kubic config` lists them (`kept`) rather than the section being silently ignored. `kubic doctor` says so: any configured `network_policy` fails `policy:enterprise-network` as not enforced, and `policy:enterprise-enforceability` with it. The engine mode names (`none`, `allowlist`, `full`) are accepted too. |
| `policy.filesystem_policy` | Parsed and resolved (`workspace-only` is the engine's `workspace-write`; the engine level names are accepted). The lane derives filesystem reach from the `[permissions]` classes, so this value is **not enforced** as a gate of its own; `kubic config` lists it (`kept`), `kubic doctor` does not report it. |
| `policy.data_policy`, `policy.logging_policy` | Parsed and carried (for example `no-external-training`, `full-audit`); no local mechanism can promise a provider-side policy, so they are reported, never claimed as enforced. |
| `audit` (`[[audit]]`) | Sink tables (`sink` = `syslog` \| `file` \| `memory`, `level` = `privileged` \| `all`, optional `target`/`facility`). Parsed and validated fail-closed (an unknown kind, level or key is named); every audit row fans out to the configured sinks plus the mandatory repo ledger (see [Audit sinks](enterprise.md#audit-sinks-audit)). |
| `skills` | Settings skills: files or directories loaded with source `settings` on every lane a command boots — `kubic run`, `kubic tui`, the suite runs of `kubic eval`/`kubic benchmark` and the re-executing tiers of `kubic replay` (see [Settings skills](#settings-skills)). Project-layer entries apply only for a trusted project; a non-string or blank entry is refused by name at load. |
<!-- /generated:config-keys -->

**Two keys, two windows.** `kubic journal prune` removes journal entries older
than `[journal] retentionDays`, read from the runtime load: the
`KUBIC_JOURNAL_RETENTION_DAYS` env var counts and beats the file key, and
`--keep-days` beats both. An append also trims past `[journal] retentionDays`.
The read-time self-heal of `kubic log --session <id>` deletes (it is not a dry
run) past `[session] retentionDays`, and only for a session that no live run is
attached to. A read (`kubic log --session`) applies only `[session]
retentionDays`, and `kubic journal prune` applies only `[journal]
retentionDays` (or `--keep-days`). To have one window, set both keys to the
same value.

### Settings skills

```toml
skills = ["./team", "/opt/shared/skills"]
```

A top-level array of skill files or directories. Each entry
loads with source `settings` — like an explicit `--skill`, it applies even
under `--no-skills` — on every lane a command boots: `kubic run`, `kubic tui`,
the suite runs of `kubic eval`/`kubic benchmark` and the re-executing tiers
of `kubic replay` (which discover skills at the pinned worktree). Relative entries resolve against the directory of
the config file that declared them — a project config's `"../shared"`
names the project's sibling wherever the run was invoked from — never the
cwd; absolute entries pass through as written. `~` and env vars are not
expanded. The first layer that sets the key wins the whole array
(enterprise > product > global > project), and project-layer entries apply
only for a trusted project: an untrusted project file is refused before it
is read, exactly like every other project key. `kubic config` reports the
resolved (absolute) list with its layer.

The user discovery roots are `~/.pi/agent/skills` and `~/.agents/skills`
(Pi-compatible) plus `~/.kubic/skills`: the Kubic-native root
is read last, so it wins a same-name conflict with a Pi-carried skill.

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
the project do (see the trust gate above). Each command a run executes is
announced on stderr when it starts — `verify: running the tests gate: npm
test`, and `… at the base revision: …` for the baseline checkout — and
recorded as a `verify:<gate>` row in the workspace's audit ledger
(`.kubic/audit/audit.jsonl`, a privileged action) with its verdict.
`kubic config` lists the commands that will run, with their layer.
Verification adds the commands' run time to every `kubic run`.

Each trigger, what it detects and the detection heuristics are on
[approvals](approvals.md#autoapprove-capabilities).

## What lives where

`.kubic/` is a **mixed** directory: configuration is committed, run state is
not. The split, exactly as shipped:

- **Committed**: `.kubic/config.toml`, `.kubic/roles/*.md`.
- **Runtime state (never committed)**: `.kubic/audit/`, the approval audit
  ledger. Sessions and their journals live outside the workspace, under the
  sessions root (`~/.kubic/sessions`).
- **How a user repo gets the rules**: every `kubic run` and `kubic tui`
  invocation (before it creates any state) writes that runtime
  prefix into the repository's **local, uncommitted**
  exclude file (`.git/info/exclude`), in a marked block it rewrites in
  place on later runs — so nothing of Kubic's own appears in `git status`,
  and your committed `.gitignore` is never touched by the tool. `kubic doctor`
  checks the same file the writer writes: it resolves the repository with
  `git rev-parse --show-toplevel` and the exclude with `git rev-parse
  --git-path info/exclude`, so a linked worktree (whose `.git` is a file
  pointing at the common dir) checks the common dir's exclude, and a run
  from a subdirectory checks the root files. Outside a git repository the
  check does not apply. `.kubic/` itself is deliberately **not** ignored: `config.toml` and `roles/*.md`
  stay committable. Outside a git repository the write is a no-op (runtime
  state is local wherever it is written), and the write never fails a run.
  This repository's own `.gitignore` ignores its whole `.kubic/` directory
  (`/.kubic/`) and also lists the same rule, because `kubic doctor` checks
  for that literal line.
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
  [models.json](models.md#modelsjson) above). A model without `contextWindow`/`maxTokens` gets
  fail-safe defaults `8192`/`2048` (small local servers overflow above
  them). The compaction reserve (`[session] reserveTokens`, default 16384) is
  clamped to a quarter of the model's window (an 8192-token model reserves
  2048), and the kept window (`[session] keepRecentTokens`, default 20000) to
  a quarter of the room below that reserve, so a small-window model compacts
  only near its limit. The system prompt and the default tool set take about
  2800 tokens of every request, so the room a compaction leaves is smaller
  than the window suggests: about 360 to 1060 tokens on an 8192-token window
  (roughly one exchange, so agent work needs a larger window), about 5000 on
  16384, about 14300 on 32768 and about 91000 on 131072. These are estimates:
  the threshold minus those 2800 tokens and the kept window, with a summary of
  700 to 1400 tokens. `kubic doctor` warns (`context-room`) when a model you
  can configure, one defined in `models.json` or your default model, keeps less
  than 4096 estimated tokens of room. The same three `[session]` keys (`autoCompact`, `reserveTokens`,
  `keepRecentTokens`) drive `kubic run` and `kubic tui` alike — see the
  key-effect table — and `kubic config` / `kubic doctor`
  print the effective reserve after the clamp.
- **Sessions store**: `~/.kubic/sessions` by default. Retention is opt-in
  and manual: `kubic sessions prune` lists candidates by default and
  deletes only with `--yes`, and `[session] retentionDays` (above) supplies
  the default keep-window — a live-locked session is never pruned.
- **Journal**: each run journals into its session, at
  `<sessions-root>/<id>/journal`. With the store's default
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
  `kubic journal prune` removes entries older than the keep window on
  request, a dry run unless `--yes`.

Honest limits, stated plainly: Kubic runs in-process with your
user authority — no isolation, no containment; approval policy is an
offer for routing, not enforcement; the journal is a review/undo log,
not a backup. `kubic doctor` reports each of these as an informational
`warn` — see [doctor and debug](doctor-and-debug.md).

Back to the [docs index](../README.md). See also
[commands](commands.md).
