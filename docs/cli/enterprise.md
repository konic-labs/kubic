# Enterprise policy

> The managed `[policy]` layer an organization deploys, and the audit sinks it
> requires. Back to [configuration](configuration.md).

An enterprise admin can put a `[policy]` section in
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

data_policy = "no-external-training"
logging_policy = "full-audit"

project_policy = "restricted"

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
  Kubic has no proxy-mediated or socket-level enforcement, so the value is
  **not enforced**: `kubic config` lists it (`kept`) instead of the section
  being silently ignored, and `kubic doctor` fails
  `policy:enterprise-network` for any configured value — `allowed_domains`
  or not — and `policy:enterprise-enforceability` with it. The bash
  network guard is the `[permissions] network` class, a lexical detector.
- `filesystem_policy` — `"workspace-only"` is the engine's
  `workspace-write`; the engine level names are accepted too.
- `data_policy`, `logging_policy` — parsed into the effective policy and
  listed by `kubic config`; each one's enforcement status is the key-effect
  row above, never a claim. `kubic doctor` does not report these two, nor
  `filesystem_policy`.
- `project_policy` — `"restricted"` bounds what a repository may set for
  itself; see [Restricting project configuration](#restricting-project-configuration).
- `[[audit]]` — repeatable sink tables (`sink`, `level`, optional `target`
  and `facility`). Unknown kinds, levels and keys are refused by name.
  See [Audit sinks](#audit-sinks-audit).

`kubic doctor` reports the rest whenever a `[policy]` section is configured
(see [doctor and debug](doctor-and-debug.md)): `policy:enterprise-sinks`
(the `[[audit]]` sinks are present, syslog-first, and syslog is available),
`policy:enterprise-network` (a configured `network_policy` fails as not
enforced) and `policy:enterprise-enforceability` (passes only when both of
the others do). With no `[policy]` section none of them is emitted.

## Restricting project configuration

A developer who trusts a repository lets its `.kubic/config.toml` and
`models.json` take effect (see [project trust](trust.md)). An organization
can bound what that grant may change:

```toml
[policy]
project_policy = "restricted"
```

Set in the enterprise, product or global layer (the first that sets
`project_policy` wins, so an enterprise `"open"` holds against a global
`"restricted"`; a project's own value is ignored), it refuses a trusted
project config that:

- sets `[approvals] autoApprove` — a repository cannot pre-approve its own
  commands;
- widens a `[permissions]` class past the layers above, or past the defaults
  where no layer above sets the class (`network = "full"` when nothing above
  allows more than `none`);
- declares `[verify]` gate commands, which run as shell after each run
  outside approvals (`timeoutMs` alone is allowed).

The load names every such key and the layer that set the restriction, before
anything runs:

```
error: project config /repo/.kubic/config.toml sets 'approvals.autoApprove', 'verify.tests', which the enterprise policy forbids ([policy] project_policy = "restricted": a project may narrow approvals and permissions, never widen them, and may not run [verify] commands) — remove them from the project config
```

The project's `models.json` providers stay out of the catalog even when the
project is trusted: `kubic models`, `kubic doctor` and the run's warning
line name the file (`models.json ignored: <path> (project, forbidden by the
enterprise policy ([policy] project_policy = "restricted"))`). A project may
still narrow: a stricter permission class, `route = "deny"`, a smaller tool
set. The default is `"open"`.

## Audit sinks (`[[audit]]`)

Enterprises expect audit records to reach syslog or another org sink — a
JSONL file inside a repo the agent can write to is not tamper-evident.
Every audit row (decisions and privileged actions alike) fans out to each
configured sink **plus** the mandatory repo ledger
(`.kubic/audit/audit.jsonl`, read by `kubic audit`):

```toml
[[audit]]
sink = "syslog"
level = "privileged"

[[audit]]
sink = "file"
level = "all"
target = "/var/log/kubic.jsonl"
```

- `sink`: `syslog` (one message per record, the record JSON as its
  body; severity notice for an `ok` result, warning for `deny` and
  `error`), `file` (one JSON line per record appended at the exact
  `target` path), or `memory` (process-scoped, for embedders and tests).
- `level`: `privileged` keeps approval decisions (`tool:<name>`), run
  starts (`run:start`), posture changes — the full-access grant
  (`posture:full-access`), its revoke (`posture:approvals`) and a refused
  mid-session change to `posture.json` (`posture:changed-mid-session`) —
  undo restores (`undo-restore`) and gate commands (`verify:<gate>`),
  dropping everything else (the per-request credential rows); `all` keeps
  every row. The repo ledger always keeps everything regardless of level.
- `target` (syslog): a unix socket path (bare `/dev/log` or
  `unix:/path`; the default is `/var/run/syslog` on macOS and `/dev/log`
  elsewhere) or a `host[:port]` UDP destination (port 514 when absent).
  Node has no unix datagram sockets, so a socket target is delivered
  through the system `logger` (found at `/usr/bin/logger`, `/bin/logger`
  or `/usr/sbin/logger`; never searched on `PATH`): the default socket
  works with any logger (on macOS it writes to the unified log), and any
  other socket path needs util-linux `logger`. A host with no logger, or a
  socket path its logger cannot reach, is refused by name when the sinks
  build. A UDP destination receives one RFC 5424 datagram per record.
  Delivery is best-effort by protocol design: a failed send is recorded on
  the sink, noted once per process, and reported by `kubic doctor`. `target` (file): the
  exact file path (required); each record is appended and fsynced, and a
  new file is created `0600` (new directories `0700`) while an existing
  one keeps its mode — pre-create it to give a log collector group read
  access. `memory` takes no target.
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
