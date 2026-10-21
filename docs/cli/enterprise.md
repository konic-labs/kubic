# Enterprise policy

> The managed `[policy]` layer an organization deploys, and the audit sinks it
> requires. Back to [configuration](configuration.md).

An enterprise admin can put a `[policy]` section in the managed
`config.toml` — `/etc/kubic/config.toml`, or the platform's
device-management path (see [Managed configuration](#managed-configuration))
— or in the managed `product.toml` for a product/vertical profile. It is the highest-precedence layer: a lower
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
(the `[[audit]]` sinks are present, the first is a collector — syslog,
https or otlp — and syslog is available),
`policy:enterprise-network` (a configured `network_policy` fails as not
enforced) and `policy:enterprise-enforceability` (passes only when both of
the others do). With no `[policy]` section none of them is emitted.

## Managed configuration

Device management (Jamf, Intune, Ansible, …) installs Kubic's managed files
where Kubic looks for them, first match per file:

| Platform | Directories searched |
| --- | --- |
| macOS | `/Library/Application Support/Kubic/`, then `/etc/kubic/` |
| Windows | `%ProgramData%\Kubic\` |
| Linux and the rest | `/etc/kubic/` |

`config.toml` there is the enterprise layer and `product.toml` the product
layer.

### Signed managed files

A `policy.pub` in that directory — an Ed25519 public key in PEM form — makes
a signature mandatory for every managed file loaded from it: `<file>.sig`
beside the file, the base64 Ed25519 signature of the file's exact bytes. An
unsigned file, a file changed after it was signed and a file signed with
another key are refused by name, and the command stops (exit 1) — nothing
runs on a managed layer the organization did not sign:

```
error: managed config /etc/kubic/config.toml does not match its signature /etc/kubic/config.toml.sig — it changed after it was signed, or was signed with another key than /etc/kubic/policy.pub
```

Sign with `kubic policy sign --key <private.pem> <file>`, which writes
`<file>.sig` and says whether the directory's `policy.pub` accepts it, or
with OpenSSL 3:

```sh
openssl genpkey -algorithm ed25519 -out policy.key
openssl pkey -in policy.key -pubout -out policy.pub
openssl pkeyutl -sign -inkey policy.key -rawin -in config.toml | base64 > config.toml.sig
```

Keep the private key off the managed machines; ship `policy.pub`, the files
and their signatures.

### A remote policy

The managed config can point at a policy the organization serves:

```toml
[managed]
url = "https://policy.example.com/kubic/config.toml"
refreshHours = 24
```

The document at `url` is a Kubic config (any section but `[managed]`) with
its signature at `<url>.sig`, and it needs the `policy.pub` beside the
managed config. A command that runs on the config (`run`, `tui`, `replay`,
`eval`, `benchmark`, `policy`) fetches it first when the cached copy is
missing or older than `refreshHours`, verifies it, and keeps it in
`~/.kubic/managed/` (`0600` files in a `0700` directory). A copy that does
not verify is never cached. Every load verifies the cached copy again, so
an edited cache is refused by name, and an unreachable server only warns:
the last verified copy stays in force offline. Before the first successful
fetch the load is refused (`the managed policy from <url> has not been
fetched yet — run 'kubic policy pull' …`). The remote policy is merged into
the enterprise layer above the local file: where both set a key, the remote
value wins. `kubic policy pull` fetches it now. `[managed]` is read only
from the managed `config.toml`; any other layer setting it is refused.

### `kubic policy explain`

Prints the effective policy with the layer behind each value: every
`[policy]` key (`(not set)` when nothing sets it; each denied tool with the
layer that denied it), the audit sinks, every config key the enterprise and
product layers set — they hold against every lower layer, the environment
and the flags — and where the managed config came from (its file, whether
its signature verified, and the remote policy's URL and fetch time).
`--json` prints the same as one document.

```
$ kubic policy explain
policy:
  allowed_models     ["local/*"]  (enterprise)
  allowed_providers  (not set)
  …
  denied_tools       ["bash", "network_fetch"]  (bash: global, network_fetch: enterprise)
  …
audit sinks:
  audit[0]  { sink = "syslog", level = "privileged" }  (enterprise)
set by the enterprise and product layers (no lower layer or override changes them):
  model.id        "small"  (enterprise)
  model.provider  "local"  (enterprise)
managed config: /etc/kubic/config.toml (signature verified)
remote policy: https://policy.example.com/kubic/config.toml (fetched 2026-10-21T09:00:00.000Z, signature verified; cached at /Users/you/.kubic/managed/policy.toml)
```

## Spend caps

```toml
[policy]
max_run_cost_usd = 5
max_daily_cost_usd = 50

[cost]
team = "platform"
```

Two caps bound what Kubic spends, from the cost the providers report on each
model response:

- `max_run_cost_usd` stops a `kubic run` once its own spend reaches the cap.
  `kubic tui` counts its spend since the process started: the turn that
  reaches the cap is cancelled and no prompt is sent again.
- `max_daily_cost_usd` bounds this machine's spend for the UTC day, read from
  the session store when the run starts: a run on a day already spent is
  refused before a session exists, and a run that reaches the cap stops.

A stopped `kubic run` exits 3 with status `spend_limit` and names the spend,
the cap and the layer that set it (`spend limit reached: this run cost
$5.02, and [policy] max_run_cost_usd allows $5.00 (set by the enterprise
layer)`). Every layer may set a cap and the **lowest** wins, so a user can
tighten the organization's cap but never loosen it; `kubic policy explain`
names the winning value and its layer.

What the caps cannot do, stated plainly: the check runs after each response,
so the response that crosses a cap is already spent; a provider that reports
no cost spends nothing as far as the caps can see; and a session another live
run holds is counted toward the day only once it ends, so two runs started at
the same moment can each pass a cap the other has not reported yet.

`kubic cost` reports the spend: `--by user`, `--by team` (the `[cost] team`
each session was created under), `--by model` and `--by day`, and
`--format csv` for a spreadsheet — see [kubic cost](analysis.md).

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
target = "tls://logs.example.com:6514"

[[audit]]
sink = "https"
level = "all"
target = "https://audit.example.com/kubic"
tokenEnv = "KUBIC_AUDIT_TOKEN"

[[audit]]
sink = "file"
level = "all"
target = "/var/log/kubic.jsonl"
```

- `sink`: `syslog` (one message per record, the record JSON as its
  body; severity notice for an `ok` result, warning for `deny` and
  `error`), `https` (a POST of `{"records": [...]}` per batch to the
  `target` URL), `otlp` (an OpenTelemetry collector's OTLP/HTTP logs
  endpoint, one log record per audit record with its `what`, `result`,
  `posture`, session and pid as attributes), `file` (one JSON line per
  record appended at the exact `target` path), or `memory`
  (process-scoped, for embedders and tests).
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
  build. A UDP destination receives one RFC 5424 datagram per record;
  delivery is best-effort by protocol design: a failed send is recorded on
  the sink, noted once per process, and reported by `kubic doctor`.
  `tcp://host[:port]` (514) and `tls://host[:port]` (6514, RFC 5425)
  deliver RFC 5424 lines in octet-counted frames through the sink's spool
  (below). `target` (https, otlp): the collector URL — https, or plain http
  to this machine only. `target` (file): the
  exact file path (required); each record is appended and fsynced, and a
  new file is created `0600` (new directories `0700`) while an existing
  one keeps its mode — pre-create it to give a log collector group read
  access. `memory` takes no target.
- `ca` (TLS syslog, https, otlp): a PEM file of the certificates the
  collector's certificate must chain to, in place of the system store.
- `tokenEnv` (https, otlp): the environment variable whose value is sent as
  `Authorization: Bearer <token>`; an unset variable refuses the table by
  name.
- `facility` (syslog): an RFC 5424 facility name (`local0`–`local7`,
  `user`, `authpriv`, …) or number 0–23; default `local0`. Unknown
  facilities and malformed targets are refused by name when the sinks
  build — the table is skipped (named on stderr and in `kubic doctor`)
  while the repo ledger keeps recording.
- A sink that fails at runtime records the failure and notes it on
  stderr once per process; the repo write is never blocked. `kubic doctor`
  lists every configured sink with a reachability probe (`audit:sink:*`)
  plus any runtime failure the process recorded.

### Collectors: the spool

A collector over the network — `tcp://` or `tls://` syslog, `https`,
`otlp` — never holds up the command and never loses a record. Each record is
first appended to the sink's spool, `~/.kubic/audit-spool/<sink>.jsonl`
(`0600` in a `0700` directory, fsynced): the record is safe from that moment.
The spool is then delivered in order, in batches, and what the collector
accepted is removed. A collector that is down keeps its records in the
spool; the next record, the end of the command (one short try) or
`kubic audit flush` delivers them when it answers. Delivery is at least once:
two commands draining one spool can send a batch twice, never lose one.
`kubic doctor` warns while records wait (`audit[2] https …: 3 record(s) wait
in the spool`).

### A tamper-evident ledger

Every line of the repo ledger — and of a `file` sink — carries a link to
the line before it: `"chain": {"prev": "sha256:…", "hash": "sha256:…"}`,
where `hash` covers `prev` and the record. Editing a line breaks its hash,
removing one breaks the next line's `prev`, and a head file beside the
ledger (`audit.jsonl.head`: the last hash and the ledger's size) catches
records removed from the end. A ledger begun before the chain keeps its older
lines; the first chained record links to the digest of all of them. Appends
run under a lock, so two processes writing one ledger never fork the chain.
`kubic audit verify` walks it:

```
$ kubic audit verify
audit ledger /repo/.kubic/audit/audit.jsonl: intact — 214 record(s), head sha256:5f1c…
$ kubic audit verify
error: audit ledger /repo/.kubic/audit/audit.jsonl: line 37 was changed after it was written
```

The chain proves the ledger was not changed after the fact; it cannot stop a
process with write access from deleting the whole file and its head. Send
the records to a collector the developer cannot write to — syslog, https or
otlp — for a copy that holds.

Unknown keys inside `[policy]` fail closed and are named. `kubic policy
--tool <name>` answers from the merged enterprise and installed policy and
names the deciding layer (`deny bash (enterprise)`), so the offer and
`kubic run` cannot disagree.
