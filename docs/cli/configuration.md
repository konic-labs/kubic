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

### Seeing the effective values

`kubic config` prints every value that is set, with the layer it came from,
plus the projections the run consumes (selected model, approvals,
permissions, journal retention, modes, budgets). `kubic config --json` emits
the same thing as one object — `values`: `{ key, value, layer }` per set
key, and one object per projection. A broken config (unknown key, refused
project layer, `[budgets]`, a secret ref) exits 1 with the named reason
instead of printing defaults.

A refusal also stops the modes that execute an agent: `kubic run`,
`kubic orchestrate` and `kubic tui` exit 1 with the named reason rather than
proceeding on built-in defaults while you believe your config file is in
force. `kubic config` and `kubic doctor` still run, so you can see what is
wrong (doctor reports the load as `dep:config-load (deps-missing)`).
Commands that consume no config projection (`sessions`, `git`, `diff`,
`journal`, `clean`, …) are unaffected.

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
```

## Shape (canonical sections)

`[agent]` name · `[model]` provider/id/thinking (`off`, `minimal`,
`low`, `medium`, `high`, `xhigh`, `max`) · `[modes]` solo/orchestrator ·
`[approvals]` route (`ask-user` or `deny`), maxPendingMs, autoApprove,
sessionScoped, requireJustification · `[permissions]` filesystem
(`none`, `read`, `workspace-write`, `full`), shell (boolean or
`read-only-allowlist`), network (`none`, `allowlist`, `full`), git
(boolean, `workspace`, `full`), credentials (`none`, `allowlist`) ·
`[journal]` retentionDays · `[roles.<name>]` model/tools ·
`[orchestrator]` root/maxWorkers · `[ui]` theme/statusBar ·
`[session]` store/dir. The canonical example is
`packages/host/src/config/example.toml` (pinned by test — copy it to
start). Unknown sections or keys are rejected (`ConfigError`).

Every one of those keys has a runtime effect or says so plainly:

| Key | Effect |
| --- | --- |
| `model.provider`, `model.id` | Selects the provider/model for `kubic run` (`selectModel`). |
| `model.thinking` | Default thinking level for the selected model. |
| `modes.solo`, `modes.orchestrator` | Selects the mode; both `true` is refused by name. |
| `approvals.route` | Approval routing (`ask-user` \| `deny`). |
| `approvals.maxPendingMs`, `autoApprove`, `sessionScoped`, `requireJustification` | Effective policy; a pending ask denies on timeout, `autoApprove` is explicit-only. Only real answers (user, route, autoApprove) persist to `approvals.json` — a timeout denies the call but stores nothing, so a later surface can still ask about the same operation. |
| `permissions.*` | Permission classes → the lane's derived tool allowlist (§40). |
| `journal.retentionDays` | Journal age bound, enforced on every append. |
| `agent.name` | Reported by `kubic config`; the solo lane names the agent from the session. |
| `roles.*` | Parsed and reported; role documents land with #99. |
| `orchestrator.*` | Parsed and reported; orchestrator wiring lands with #94/#95. |
| `ui.*` | Parsed and reported; TUI selection lands with #88/#96. |
| `session.store` | `jsonl` only today; `sqlite`/`memory` remain a separate decision. |
| `session.dir` | Parsed and reported; the sessions root is host-owned today. |

Two keys are forbidden outright, not defaulted: **`[budgets]`**
(`BudgetKeyError` — budgets are never defaulted by config) and
**`[mcp]`** (unsupported in v1; third-party tools/MCP arrive in Phase 4
— doctor surfaces these as `policy-mismatch` fails pointing at
[doctor and debug](doctor-and-debug.md)).

## Secrets (never in config)

Secrets live in `models.json` as **refs only**, resolved at request
time with one audit event per use — they never appear in config,
trajectories, or logs:

| Form | Meaning |
| --- | --- |
| `$ENV_VAR` | Read from the environment at request time. Missing/empty fails closed. |
| `!command args…` | Run the helper (injected by the host) and use its output. Re-run every time — no TTL. |
| `\$…` / `\!…` | Escaped literals (`\$FOO` means the text `$FOO`). |
| anything else | Plain literal value. |

Tool credentials travel as budget-bounded scoped tokens revoked at
settle/exit; agent processes see allowlisted env plus their role creds —
no ambient leak.

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
  and your committed `.gitignore` is never touched by the tool. `.kubic/`
  itself is deliberately **not** ignored: `config.toml` and `roles/*.md`
  stay committable. Outside a git repository the write is a no-op (runtime
  state is local wherever it is written), and the write never fails a run.
  This repository ships the same five rules in its own `.gitignore` — the
  rules, the writer, and this page are pinned together by
  `scripts/runtime-exclude.test.mjs` and the config tests.
- **Models**: `./models.json` in the working directory (custom providers
  registered on top of built-ins; a `loaded models.json:` /
  `models.json ignored:` note is printed on `models`/`doctor`/`run`).
- **Sessions store**: `~/.kubic/sessions` by default.
- **Journal**: `<root>/.kubic/journal` by default.

Honest limits, stated plainly (§59.1): solo runs in-process with your
user authority — no isolation, no containment; approval policy is an
offer for routing, not enforcement; the journal is a review/undo log,
not a backup. `kubic doctor` reports each of these as an informational
`warn` — see [doctor and debug](doctor-and-debug.md).

Back to the [docs index](../README.md). See also
[commands](commands.md).
