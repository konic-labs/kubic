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
- `data_policy`, `logging_policy` — parsed into the effective policy and
  listed by `kubic config`; each one's enforcement status is the key-effect
  row above, never a claim. `kubic doctor` does not report these keys yet:
  `enterpriseDoctorChecks` (audit-sink, network-allowlist and
  enforceability checks) has no caller, so a green doctor says
  nothing about them.
- `[[audit]]` — repeatable sink tables (`sink`, `level`, optional `target`
  and `facility`). Unknown kinds, levels and keys are refused by name.
  See [Audit sinks](#audit-sinks-audit).

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

- `sink`: `syslog` (one RFC 5424 line per record), `file` (one JSON line
  per record appended at the exact `target` path), or `memory`
  (process-scoped, for embedders and tests).
- `level`: `privileged` keeps approval decisions (`tool:<name>`), the
  seven privileged actions, and the full-access revoke
  (`posture:approvals` — the disable half of a privileged posture change travels with its grant review), dropping
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
