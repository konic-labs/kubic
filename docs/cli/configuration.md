# Configuration

> Design ref: §33–§36 config/secrets. Implementation:
> `packages/host/src/config/config.ts` (layers, TOML, merge),
> `runtime.ts` (the load the binary actually runs on), `config-cli.ts`
> (`kubic config`), `secrets.ts` (request-time secrets), `stances.ts`
> (refusals). This table matches that implementation exactly.

## Precedence: first layer wins

Six layers, highest first, then the documented environment overrides, then
an explicit CLI flag. Merge is per leaf path: the first (highest) layer to
set a key owns it — a lower layer attempting to override a set key is
reported in `overriddenAttempts`, never applied. Enterprise keys are frozen
against every override attempt, the environment and the CLI included.

| # | Layer | Source file | Notes |
| --- | --- | --- | --- |
| 1 | `enterprise` | `/etc/kubic/config.toml` (or an explicit `enterprisePath` override) | Highest. Never overridden — by a file, the environment, or a flag. |
| 2 | `global` | `~/.kubic/config.toml` | Your machine-wide defaults. |
| 3 | `project` | `<projectRoot>/.kubic/config.toml` | **Trust-gated**: refused before you accept the workspace trust prompt (`ProjectUntrustedError`); absent file counts as an empty layer. |
| 4 | `workspace` | `<workspaceRoot>/.kubic/config.toml` | Only when a workspace root is set — otherwise the layer does not exist. |
| 5 | `session` | Supplied programmatically | Never a file. |
| 6 | `agent` | Supplied programmatically | Never a file. Lowest. |
| — | `env` | The `KUBIC_*` overrides below | Above every file layer, below `enterprise`, below the CLI. |
| — | `cli` | e.g. `--model` | Highest, except against a frozen `enterprise` key. |

Trust is accepted per workspace: `KUBIC_TRUST_PROJECT=1` records the project
layer as trusted for that invocation. Anything else leaves it distrusted,
and a project `config.toml` that exists is then **refused by path** before it
is read — never half-applied.

### Environment overrides

| Variable | Effect |
| --- | --- |
| `KUBIC_MODEL` | `provider/id` model pin (same precedence as the file key, one step higher). |
| `KUBIC_MODEL_THINKING` | Thinking level for the selected model (`off`…`max`). |
| `KUBIC_APPROVALS_ROUTE` | `ask-user` or `deny`. |
| `KUBIC_JOURNAL_RETENTION_DAYS` | Journal age bound, in days (non-negative integer). |
| `KUBIC_TRUST_PROJECT` | `1`/`true` accepts the project layer for this invocation. |

A malformed value fails closed with the variable named — it never silently
falls back to a default.

`KUBIC_PROVIDER` is not a config key: `KUBIC_PROVIDER=faux` selects the
scripted **testing** provider for one invocation (no network, no model),
and any other non-empty value is refused by name — see
[the testing provider](commands.md#testing-provider-kubic_providerfaux).

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
plus the projections the run consumes (selected model, approvals,
permissions, journal retention and out-of-scope paths, modes, budgets).
`kubic config --json` emits
the same thing as one object — `values`: `{ key, value, layer }` per set
key, and one object per projection. A broken config (unknown key, refused
project layer, `[budgets]`, a secret ref) exits 1 with the named reason
instead of printing defaults. The agent-executing commands (`run`,
`orchestrate`, `tui`, `replay`) refuse a broken config the same way: one
`error: <reason>` line on stderr, exit 1, stdout empty (so a `--json`
consumer never parses the refusal as data).
`kubic config --help` (or `-h`) prints the generated help and exits 0
without loading anything; an unknown flag prints one `error: …` line on
stderr and exits 2.

A refusal also stops the modes that execute an agent: `kubic run`,
`kubic orchestrate` and `kubic tui` exit 1 with the named reason rather than
proceeding on built-in defaults while you believe your config file is in
force. `kubic config` and `kubic doctor` still run, so you can see what is
wrong (doctor reports the load as `dep:config-load (deps-missing)`).
Commands that consume no config projection (`git`, `diff`, `clean`, …) are
unaffected. `kubic sessions` reads exactly one projection —
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

`[agent]` name · `[model]` provider/id/thinking (`off`, `minimal`,
`low`, `medium`, `high`, `xhigh`, `max`) · `[modes]` solo/orchestrator ·
`[approvals]` route (`ask-user` or `deny`), maxPendingMs, autoApprove,
sessionScoped, requireJustification · `[permissions]` filesystem
(`none`, `read`, `workspace-write`, `full`), shell (boolean or
`read-only-allowlist`), network (`none`, `allowlist`, `full`), git
(boolean, `workspace`, `full`), credentials (`none`, `allowlist`) ·
`[journal]` retentionDays/outOfScope · `[roles.<name>]` model/tools ·
`[orchestrator]` root/maxWorkers · `[ui]` theme/statusBar ·
`[session]` store/dir/retentionDays. The canonical example is
`packages/host/src/config/example.toml` (pinned by test — copy it to
start). Unknown sections or keys are rejected (`ConfigError`).

Every one of those keys is in the key-effect table below: **consumed** keys
name the code path that reads them, **kept** keys are reserved with the
reason they are not consumed, and a key with no row at all fails `kubic
doctor`'s config check by name. `kubic config` prints the disposition of
every effective value (`(project, consumed)`), so a config file can never
quietly stop configuring anything.

| Key | Effect |
| --- | --- |
| `model.provider`, `model.id` | Selects the provider/model for `kubic run` (`selectModel`). |
| `model.thinking` | Default thinking level for the selected model. |
| `modes.solo`, `modes.orchestrator` | Selects the mode; both `true` is refused by name. |
| `approvals.route` | Approval routing (`ask-user` \| `deny`). |
| `approvals.maxPendingMs`, `autoApprove`, `sessionScoped`, `requireJustification` | Effective policy; a pending ask denies on timeout, `autoApprove` is explicit-only. Only real answers (user, route, autoApprove) persist to `approvals.json` — a timeout denies the call but stores nothing, so a later surface can still ask about the same operation. The same bound is the orchestrator's interactive merge gate (issue #130): an unanswered merge ask denies closed on elapse, naming the bound and the candidate. |
| `permissions.*` | Permission classes → the lane's derived tool allowlist (§40). |
| `journal.retentionDays` | Journal age bound, enforced on every append. |
| `journal.outOfScope` | Paths excluded from the §42.5 baseline and the end-of-run sweep (self + children): `outOfScope = ["dist"]` ⇒ `dist/`, `dist/**`. Path-boundary aware (`dist` never matches `dist-x`), plain paths only, empty entries refused by name. |
| `agent.name` | The solo lane's agent id: journal entries are attributed to it and `kubic diff --agent <name>` filters by it. Unset ⇒ `root`, unchanged. |
| `roles.<name>.model`, `roles.<name>.tools` | Per-role defaults layered under the role document for `kubic run --role <name>` (§12.1): `model` is a `provider/id` pin the run selects unless an explicit `--model`/`[model]` pin wins, `tools` replaces the document's own list. Each leaf is attributed to the layer that set it (enterprise > global > project > workspace > session > agent). A malformed model ref is refused by name at load. Scope: `kubic run --role` applies the whole layer (model pin + tools); `kubic tui --role` applies the `tools` layer and the `[agent].name` agent id only — the model pin is not yet applied on the interactive lane (pre-existing gap, disclosed rather than silent). |
| `orchestrator.root` | Parent directory for orchestrator worktrees: the spawned set is `<repo>/<root>/<agent>`, `kubic clean` plans the same set, and the §35 runtime exclude entries cover it (the derived entry is `/<root>/`, anchored to the repo root, so only that directory matches — a bare `worktrees` never hides `deep/worktrees/…`). Workspace-relative only — refused by name at load: an absolute path, a `..` segment, a trailing `/`, an empty value, a `.` segment (`.`, `./x`, `foo/.` — the entry would match nothing and the worktree set would stay unignored), a control character, a gitignore metacharacter (`*`, `?`, `[`, `]`, a leading `#`, a backslash), and the committed half (`.kubic`, `.kubic/roles` — case-insensitively, since git folds ignore patterns on a case-insensitive filesystem). Unset ⇒ `.kubic/wt`. |
| `orchestrator.maxWorkers` | Default admission cap for the orchestrator scheduler (§45): the concurrency a run starts with when nothing else caps it. A per-session override and an explicit limits cap still win; a value that is not a positive integer is refused by name. Unset ⇒ 4. |
| `ui.*` | Kept: pi-tui owns presentation; no theme engine exists — parsed and reported for forward-compat only. |
| `session.store` | Kept: `jsonl` is the only store implemented; `sqlite`/`memory` are a separate decision — parsed and reported for forward-compat only. |
| `session.dir` | Not yet implemented: sessions stay under `~/.kubic/sessions`; relocation is a named follow-up with no filed issue yet (session-lock placement and the runtime-exclude split must settle first). |
| `session.retentionDays` | Default keep-window (days) for `kubic sessions prune`: `--keep-days` overrides it. `0` means retention is off — prune exits 0 with `session retention is off (keep-days 0) — nothing is pruned`; unset, prune exits 1 naming both ways to set a window (`--keep-days`, or this key) rather than inventing one. Deletion stays explicit (`--yes`), dry-run is the default, and a session holding a live lock is never pruned — the lock is re-checked immediately before each delete, so a session locked between plan and delete is skipped too. The same window self-heals session journals at read time: `kubic log` (with `--session <id>` or the latest-session fallback) drops aged entries as it reads them — with retention unset, or `0`, the log path writes nothing. |

### `autoApprove` capabilities

`autoApprove` entries name capabilities — the strings `detectTriggers`
(`packages/host/src/approvals.ts`) raises on tool calls. The known set
(`CAPABILITIES`):

| Capability | Raised by |
| --- | --- |
| `network` | A network command under `network = "none"` (`curl`, `wget`, `ssh`, `scp`, …) — including one hidden inside `$(…)` (nested substitutions included), backticks, or after `eval`. |
| `credentials` | Credential-tool overreach — no detector yet; fires via `requires:<tool>` or its owning tool. |
| `git-push` | `git push`, `git remote add/set-url/remove/rename`. |
| `destructive-shell` | The destructive matcher (`rm -rf`, `mkfs`, `dd of=/dev/…`, `shred`, …), including a destructive verb unwrapped through `$(…)` (nested substitutions included), backticks, or after `eval`. |
| `install` | Package installs (`npm install`, `pip install`, `brew install`, `apt install`, `cargo install`, `go install`). |
| `deploy` | Deploy verbs (`kubectl apply/create/delete/rollout`, `docker push`, `terraform apply`, `gh release create`). |
| `outside-write` | A write outside the workspace: the `write`/`edit` tools, a `>`/`>>` redirect target, a `tee` target, or a `cp`/`mv`/`install` destination. |
| `budget-overrun` | The budget/concurrency overrun flag. |
| `spawn-agents` | Agent spawning (the orchestrator). |
| `privilege-escalation` | `sudo` anywhere in the command. |
| `kubic-state-write` | A write into Kubic's control plane — `<workspace>/.kubic/` (`config.toml`, `roles/`, …) and, for a target outside the workspace, any ancestor's `.kubic/` (a worker worktree's repo) or `~/.kubic/` (the global `config.toml`): the `write`/`edit` tools, any redirect target, a `tee` target, or a `cp`/`mv`/`install` destination. **Always asks**: `autoApprove` and `--full-access` never answer it. Writes into `.kubic/journal/`, `.kubic/orchestrator/` and `.kubic/sessions/` at any of those roots, and into the session root in use, are refused outright as a tool error (issue #324; see [journal and safety](../architecture/journal-and-safety.md)). |

`requires:<tool>` is accepted alongside them (the per-tool trigger). A name
outside this set is reported by `kubic doctor` (`policy:approvals`), never
silently ignored.

Detection is a literal-pattern heuristic over the command string, not
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

What remains out of scope — documented gaps, not silently handled:
interpreter-based verbs (`bash -c "rm -rf …"`, `python3 -c`, `node -e` —
the command is data to the literal patterns), network exfiltration via
`python -c`/`node -e`/`npm`, substitution nesting past ~2× the depth cap,
quoted or backslash-obfuscated verbs the literal patterns cannot see, and
whitespace tricks around redirection targets.

Two keys are forbidden outright, not defaulted: **`[budgets]`**
(`BudgetKeyError` — budgets are never defaulted by config) and
**`[mcp]`** (unsupported in v1; third-party tools/MCP arrive in Phase 4
— doctor surfaces these as `policy-mismatch` fails pointing at
[doctor and debug](doctor-and-debug.md)).

## Secrets (never in config)

Secrets never appear in config: a secret-shaped value or a secret ref in
`config.toml` is refused by name. What ships (issue #359):

- **Provider keys from `models.json` are resolved at request time.** A
  provider's `apiKeyEnv` names the environment variable holding its key; that
  is a `$ENV_VAR` ref, resolved through the request-time resolver on **every**
  model request (never cached; a missing or empty variable leaves the provider
  unconfigured). Availability checks (`kubic models`, the provider probe) read
  presence only and are not a use.
- **Every use is audited.** Each resolution appends one §60 record to the
  audit ledger (`.kubic/orchestrator/approvals/audit.jsonl`, read by
  `kubic audit`): `what: credential:<provider>`, the ref as a sentinel
  (`sentinel:$GW_API_KEY`), the role, and the purpose
  (`model-request:<provider>`) — **never the value**. A worker's uses are
  recorded in its own worktree's ledger with `mode: orchestrator`.
- **The value never persists.** Resolved values are redacted from the
  `--debug` channel, and a trajectory export redacts every secret-classified
  env key (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_CREDENTIALS`,
  `KUBIC_ROLE_*`) to `<redacted>` with the same classifier the worker spawn
  env uses.

Not implemented: `!command` and literal refs inside `models.json` (the
parser exists in `packages/host/src/config/secrets.ts`; wiring them is
#224), and **tool-credential brokering** — no budget-bounded scoped token is
issued to a worker or revoked at settle/exit (see
[design drift, item 22](../design-drift.md#item-22--363-tool-credential-brokering-is-not-implemented)).
Agent processes see the spawn allowlist plus their role grants.

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
  and your committed `.gitignore` is never touched by the tool. A
  configured `[orchestrator].root` joins that block as `/<root>/`, anchored
  to the repo root, so a worktree parent named `worktrees` never hides a
  `deep/worktrees/` or `src/worktrees/` you meant to keep. `.kubic/`
  itself is deliberately **not** ignored: `config.toml` and `roles/*.md`
  stay committable. Outside a git repository the write is a no-op (runtime
  state is local wherever it is written), and the write never fails a run.
  This repository ships the same five rules in its own `.gitignore` — the
  rules, the writer, and this page are pinned together by
  `scripts/runtime-exclude.test.mjs` and the config tests.
- **Models**: `./models.json` in the working directory (custom providers
  registered on top of built-ins; a `loaded models.json:` /
  `models.json ignored:` note is printed on `models`/`doctor`; `run`
  always prints `models.json ignored: …` on stderr and the `loaded` receipt
  only under `--debug`). A model without `contextWindow`/`maxTokens` gets
  fail-safe defaults `8192`/`2048` (small local servers overflow above
  them). The 16384-token compaction reserve is
  clamped to a quarter of the model's window (an 8192-token model reserves
  2048), so a small-window model compacts only near its limit, never every
  turn.
- **Sessions store**: `~/.kubic/sessions` by default. Retention is opt-in
  and manual: `kubic sessions prune` lists candidates by default and
  deletes only with `--yes`, and `[session] retentionDays` (above) supplies
  the default keep-window — a live-locked session is never pruned.
- **Journal**: `<root>/.kubic/journal` by default. Every index append is
  fsynced before it returns — one fsync per tool write is the price of
  "reversible" (store-level `JournalRetention.durable`, default `true`,
  trades it for a crash window of one truncated last line). That fsync
  covers the appended index line only: blob payloads and the retention
  compaction rewrite are renamed without one, so a crash right after a
  compaction can lose more than the last line (stated in
  [the journal and safety page](../architecture/journal-and-safety.md)).
  Growth is bounded by `[journal] retentionDays` and the 100 MiB default
  size cap.

Honest limits, stated plainly (§59.1): solo runs in-process with your
user authority — no isolation, no containment; approval policy is an
offer for routing, not enforcement; the journal is a review/undo log,
not a backup. `kubic doctor` reports each of these as an informational
`warn` — see [doctor and debug](doctor-and-debug.md).

Back to the [docs index](../README.md). See also
[commands](commands.md).
