# Configuration

> Design ref: §33–§36 config/secrets. Implementation:
> `packages/host/src/config/config.ts` (layers, TOML, merge),
> `secrets.ts` (request-time secrets), `stances.ts` (refusals).
> This table matches that implementation exactly.

## Precedence: first layer wins

Six layers, highest first. Merge is per leaf path: the first (highest)
layer to set a key owns it — a lower layer attempting to override a set
key is reported in `overriddenAttempts`, never applied. Enterprise keys
are frozen against every override attempt.

| # | Layer | Source file | Notes |
| --- | --- | --- | --- |
| 1 | `enterprise` | `/etc/kubic/config.toml` (or an explicit `enterprisePath` override) | Highest. Never overridden. |
| 2 | `global` | `~/.kubic/config.toml` | Your machine-wide defaults. |
| 3 | `project` | `<projectRoot>/.kubic/config.toml` | **Trust-gated**: refused before you accept the workspace trust prompt (`ProjectUntrustedError`); absent file counts as an empty layer. |
| 4 | `workspace` | `<workspaceRoot>/.kubic/config.toml` | Only when a workspace root is set — otherwise the layer does not exist. |
| 5 | `session` | Supplied programmatically | Never a file. |
| 6 | `agent` | Supplied programmatically | Never a file. Lowest. |

## Shape (canonical sections)

`[agent]` name · `[model]` provider/id/thinking (`off`, `minimal`,
`low`, `medium`, `high`, `xhigh`, `max`) · `[modes]` solo/orchestrator ·
`[approvals]` route (`ask-user` or `deny`), maxPendingMs, autoApprove,
sessionScoped, requireJustification · `[journal]` retentionDays ·
`[roles.<name>]` model/tools · `[orchestrator]` root/maxWorkers ·
`[ui]` theme/statusBar · `[session]` store/dir. The canonical example is
`packages/host/src/config/example.toml` (pinned by test — copy it to
start). Unknown sections or keys are rejected (`ConfigError`).

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

- **Committed**: `.kubic/config.toml`, `.kubic/roles/*.md`.
- **Never committed (gitignored)**: `.kubic/sessions/`,
  `.kubic/journal/`, `.kubic/artifacts/`, `.kubic/wt/` — runtime state.
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
