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

data_policy = "redact-model"
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
- `network_policy` — `"proxy"` (the engine's `allowlist` mode) with
  `allowed_domains` starts the egress proxy: see
  [The egress proxy](#the-egress-proxy). The engine names (`none`,
  `allowlist`, `full`) are accepted too. Any other configured value is
  **not enforced**: `kubic config` lists it (`kept`), and `kubic doctor`
  fails `policy:enterprise-network` for it and
  `policy:enterprise-enforceability` with it. The bash network guard is the
  `[permissions] network` class, a lexical detector.
- `filesystem_policy` — `"workspace-only"` is the engine's
  `workspace-write`; the engine level names are accepted too.
- `data_policy` — `"redact"` and `"redact-model"` are enforced; any other
  value is carried and reported. See
  [Data loss prevention](#data-loss-prevention).
- `logging_policy` — parsed into the effective policy and listed by
  `kubic config`; its enforcement status is the key-effect row above, never
  a claim. `kubic doctor` does not report it, nor `filesystem_policy`.
- `project_policy` — `"restricted"` bounds what a repository may set for
  itself; see [Restricting project configuration](#restricting-project-configuration).
- `[[audit]]` — repeatable sink tables (`sink`, `level`, optional `target`
  and `facility`). Unknown kinds, levels and keys are refused by name.
  See [Audit sinks](#audit-sinks-audit).
- `[[hooks]]` — the organization's scripts before and after each tool call
  and at run end; see [Admin hooks](#admin-hooks).

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

## OpenTelemetry

```toml
[telemetry]
enabled = true
endpoint = "https://otel.example.com:4318"
```

With `enabled = true`, Kubic sends every `kubic run` — and every settled
`kubic tui` turn — to an OpenTelemetry collector over OTLP/HTTP (JSON), once,
when it settles:

- **Traces.** One trace per run: the `kubic.agent.run` span, the lane phases
  under it (`kubic.lane.accept`, `kubic.lane.drive`) and one
  `pi.tool.execute` span per tool call, with its error status. The run span
  carries the GenAI attributes — `gen_ai.provider.name`,
  `gen_ai.request.model`, `gen_ai.usage.input_tokens`,
  `gen_ai.usage.output_tokens` — and `kubic.cost.usd`, `kubic.run.status`,
  `kubic.session.id`, the cache counters, the tool errors and the approval
  asks; a tool span carries `gen_ai.tool.name`.
- **Metrics.** Delta sums for the run: `gen_ai.client.token.usage` by
  `gen_ai.token.type` (`input`, `output`, `cache_read`, `cache_write`),
  `kubic.cost` (USD), `kubic.tool.errors` and `kubic.approvals` by
  `kubic.approval.outcome` (`approved`, `denied`).

The standard variables apply: `OTEL_EXPORTER_OTLP_ENDPOINT` (when `endpoint`
is unset; the default is `http://localhost:4318`), the per-signal
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`,
`OTEL_EXPORTER_OTLP_HEADERS` (`key=value` pairs, for a collector's API key),
`OTEL_SERVICE_NAME` (default `kubic`) and `OTEL_SDK_DISABLED=true`, which
turns the export off again. Headers are refused over plain http to another
host, so a key never travels unencrypted; the command then runs without
telemetry and says why.

**No content leaves by default**: the spans and metrics carry names,
timing, the model, token counts and cost — never a prompt, a tool argument
or an output. `content = true` adds the prompt and the final answer to the
run span, secret shapes redacted. A collector that does not answer within
three seconds costs the run a `telemetry: not exported: …` warning and
nothing else; nothing is retried or spooled (the audit sinks are the
delivery-guaranteed channel).

## Data loss prevention

```toml
[policy]
data_policy = "redact-model"
```

A secret a tool reads — a key in a config file, a token in a test fixture,
a private key — reaches the model's context and the session store unless a
policy says otherwise. `data_policy` says otherwise:

- `"redact"` runs the secret scanner over everything a session stores: its
  transcript, the run trajectory and the spans. A secret a tool read is
  stored as `[redacted-secret]`, a resumed session never sees it again, and
  `kubic run` names the count when it ends (`data policy: 2 secret value(s)
  kept out of what the session stored`). The raw transcript
  `kubic sessions attach` prints (`--json` included) is scanned the same
  way. The change journal is left verbatim — it holds the file content
  `kubic undo` puts back, and an undo must restore a file as it was.
- `"redact-model"` does all of that and also scans each tool result after
  the tool runs and before the model reads it, so the model never sees the
  value; each redaction is named (on stderr for `kubic run`, in the
  transcript for `kubic tui`).

The scanner finds PEM private-key blocks, the key shapes Kubic redacts
everywhere (sk- keys, AWS access key ids, GitHub and Slack tokens, bearer
tokens), secret-named assignments whose value looks random
(`AWS_SECRET_ACCESS_KEY=…`, `"client_secret": "…"` — but not
`password: string`), passwords in URLs and Basic credentials. It is a
pattern scanner, not a guarantee: a secret with no recognizable name or
shape passes through. `kubic sessions export` and `kubic export` redact
whatever the policy says.

Any other `data_policy` value (`"no-external-training"`, …) is carried and
reported, never enforced — no local mechanism can promise what a provider
does with a request. `kubic doctor` reports the value as `policy:data`: a
pass naming what is enforced, or a warning that it is not.

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

## The egress proxy

```toml
[policy]
network_policy = "proxy"
allowed_domains = ["github.com", "registry.npmjs.org", "*.pythonhosted.org"]
```

With `network_policy = "proxy"` and `allowed_domains`, each `kubic run` and
`kubic tui` boot starts a local HTTP proxy on `127.0.0.1` and points the bash
tool's environment at it (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` and their
lowercase forms). A request to a host off the list — a CONNECT tunnel or a
plain HTTP request — is refused with 403; an allowed one goes through, never
decrypted. Every connection is a `network:egress` row in the audit ledger
with the host, the port, the decision and the bytes it carried. An entry
like `github.com` covers the domain and its subdomains, `*.github.com` only
the subdomains, and an IP matches itself. A proxy that cannot start refuses
the run: the organization mandated it.

Only clients that honour the proxy variables use it (curl, git, npm, pip
and most others do). With `[sandbox]` on macOS the proxy's port is the one
connection a sandboxed command can open, so a client that ignores the
variables reaches nothing; under bubblewrap on Linux the network stays
shared so the proxy is reachable, and the variables are the control.
Loopback (`localhost`, `127.0.0.1`) is left out of the proxy (`NO_PROXY`).
Kubic's own model traffic goes to its provider directly, not through the
proxy. `kubic doctor` passes `policy:enterprise-network` when the proxy
enforces the policy.

## The bash sandbox

```toml
[sandbox]
mode = "auto"                    # off (default) | auto | required
writable = ["~/.npm", "~/.cache"]
```

With `mode = "auto"`, each command the bash tool runs is wrapped in the
operating system's sandbox when the machine has one: Seatbelt
(`sandbox-exec`) on macOS, bubblewrap (`bwrap`) on Linux. `"required"`
refuses to start `kubic run` or `kubic tui` without one; `"off"`, the
default, runs bash commands as your user. The strictest mode any layer sets
wins, so a repository can tighten it but never loosen it. Inside the
sandbox a command:

- writes only to the workspace, the temporary directories and `writable`
  (read from the enterprise, product and global layers only), or anywhere
  under `filesystem = "full"`;
- opens no network connection — interpreters included — unless the network
  class is `full`;
- cannot read the credential paths: `~/.ssh`, `~/.aws`, `~/.azure`,
  `~/.config/gcloud`, `~/.kube`, `~/.docker`, `~/.gnupg`, `~/.netrc`,
  `~/.git-credentials`, `~/.config/gh`, `~/.npmrc`, `~/.pypirc`,
  `~/.cargo/credentials.toml`, `~/.terraform.d/credentials.tfrc.json` and
  `~/.pi`.

Approvals stay: a call the approval ask approved for `network` runs with the
network, and one approved for `credentials` can read the credential paths —
exactly that call, nothing else. `kubic doctor` reports the sandbox in use as
`sandbox`, or why bash runs unconfined.

What the sandbox does not cover, stated plainly: only the bash tool's
commands are wrapped. Kubic's own process, its file tools (`write`, `edit`,
which the lexical confinement and the approvals guard), the git tools, the
gate commands, admin hooks and MCP servers run with your authority. On Linux
the sandbox needs bubblewrap and unprivileged user namespaces; Landlock is
not used, so a Linux machine without bubblewrap has no sandbox. A command
that needs to write outside the allowed paths (a global package cache) fails
inside the sandbox until `writable` names the path.

## MCP servers

```toml
# the managed config (enterprise or product layer)
[mcp.github]
command = "/opt/mcp/github-mcp-server"
args = ["stdio"]
version = "0.9.1"
tools = ["get_issue", "list_pull_requests", "create_issue"]
approve = ["create_issue"]
env = ["GITHUB_TOKEN"]

[mcp.docs]
url = "https://mcp.corp.example/docs"
version = "2.1.0"
```

Kubic runs an MCP server only when the managed config allowlists it: a
`[mcp.<name>]` table in the enterprise or product layer names a stdio
server's pinned `command` (an absolute path) and `args`, or a streamable HTTP
server's `url`, and the `version` it must report. A server named by any other
layer is refused by name, and a server that reports another version, cannot
start or does not answer is left out with a stderr line naming why; the run
goes on without it.

`kubic run` and `kubic tui` connect each allowlisted server at boot and offer
its tools beside the built-ins as `mcp__<name>__<tool>` — only the ones
`tools` lists, when it lists any. The enterprise tool gate
(`allowed_tools`, `denied_tools`) and a role's or `--tools` set narrow them
like any tool. Every call goes through the same pipeline as a built-in: the
approval ask (a tool `approve` lists always asks), the admin hooks, the
secret scan of its output, and one `mcp:<name>/<tool>` audit row with its
result. A stdio server runs in the workspace with the tool environment —
no provider key — plus the variables `env` names; its stderr goes to the
debug channel. What a server does with its own network and files is the
server's: Kubic approves and audits each call, not the server's own reach
(`kubic doctor` lists this as `limit:mcp-servers`).

## Keys and workload identity

Provider keys need not live in shell profiles or in long-lived CI secrets:

- **On a workstation**, `kubic keys set <provider>` stores the key in the
  operating system's keychain (see [models](models.md#kubic-keys-setlistremove)).
- **In CI**, the job's OIDC token is the credential:

```toml
[oidc]
provider = "github"     # or "env", with tokenEnv naming the variable
awsRoleArn = "arn:aws:iam::123456789012:role/kubic-ci"
gcpAudience = "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/ci/providers/github"
gcpServiceAccount = "kubic-ci@my-project.iam.gserviceaccount.com"
gatewayAudience = "https://llm-gateway.corp.example"
```

With `provider = "github"`, `kubic run` and `kubic tui` request the job's
token from GitHub Actions (the job needs `permissions: id-token: write`);
with `provider = "env"` they read it from the variable `tokenEnv` names, the
way GitLab's `id_tokens` provide one. Then:

- `awsRoleArn`: Amazon Bedrock assumes the role with the token — Kubic writes
  it to a private file and sets `AWS_WEB_IDENTITY_TOKEN_FILE` and
  `AWS_ROLE_ARN`, which the AWS SDK reads; the role's trust policy names the
  repository it trusts.
- `gcpAudience`: Vertex AI exchanges the token through workload identity
  federation — Kubic writes the external account configuration and sets
  `GOOGLE_APPLICATION_CREDENTIALS`, impersonating `gcpServiceAccount` when
  set. Set `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` as usual.
- `gatewayAudience`: a token for that audience is offered to models.json as
  `$KUBIC_OIDC_TOKEN`, so a gateway that accepts the job's token takes it as
  the provider's key (`"apiKey": "$KUBIC_OIDC_TOKEN"`).

On GitHub the token files and the gateway token are refreshed every four
minutes; the files live in a private temporary directory removed when the
command ends, and every token is scrubbed from what a run prints and keeps.
A job with no token to request stops before the catalogue is built, naming
what it lacks. `[oidc]` is read from the enterprise, product and global
layers only: a repository must not choose where the job's token goes, so a
project config setting it is refused.

## Regions and fallbacks

```toml
[policy]
allowed_regions = ["eu-*", "europe-*", "westeurope"]

[providers.azure-openai-responses]
region = "westeurope"

[model]
provider = "amazon-bedrock"
id = "anthropic.claude-sonnet-5-5"
fallback = ["google-vertex/claude-sonnet-5-5", "azure-openai-responses/gpt-5"]
```

`allowed_regions` lists the regions a model endpoint may run in, as region
ids or `*` globs. Kubic reads the region from the environment where the
provider selects it: the AWS region for Amazon Bedrock (`AWS_REGION`,
`AWS_DEFAULT_REGION` or the profile) and `GOOGLE_CLOUD_LOCATION` for Vertex
AI. The testing provider and a `models.json` provider on this machine are
`local`. Any other provider (Azure OpenAI, a gateway, a direct API) has the
region the managed config declares under `[providers.<id>] region`; a region
is the organization's declaration, so only the enterprise and product layers
may set one. A model whose region is unknown or unlisted is refused before
any request — at selection, on a resumed session and on a `/model` switch:

```
error: model 'amazon-bedrock/anthropic.claude-sonnet-5-5' refused: provider 'amazon-bedrock' runs in us-east-1, outside [policy] allowed_regions (eu-*, europe-*, westeurope)
```

`[model] fallback` lists the models tried, in order, when the selected one
cannot be used. At boot, a model whose provider has no credentials, is not
registered or is refused by the policy or the regions gives way to the first
rung that can be selected. During a `kubic run`, a turn that fails with a
provider error — unreachable, overloaded or rate-limited after the retries,
out of quota, or refusing the credentials — runs again on the next rung.
Each move is named on stderr
(`model: primary/big is unavailable (…); using backup/small`), listed as
`fallbacks` in the `--json` envelope, and recorded as an escalation on the
trajectory with the error that caused it. A rung outside the policy or the
regions is skipped. `kubic tui` takes the fallback at boot; during a session,
`/model` switches.

`kubic doctor` and `kubic models` name what a cloud provider still lacks:
an AWS region for Bedrock, the resource (`AZURE_OPENAI_RESOURCE_NAME` or
`AZURE_OPENAI_BASE_URL`) for Azure OpenAI — with
`AZURE_OPENAI_DEPLOYMENT_NAME_MAP` when a deployment is not named after its
model — and `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` for Vertex AI
after `gcloud auth application-default login`.

## Corporate networks

Three settings make Kubic work behind TLS inspection and LLM gateways:

- **The system certificate store.** `[tls] systemCa = true` (or
  `KUBIC_SYSTEM_CA=1` for one invocation) trusts the operating system's
  certificate store beside Node's bundled roots: the macOS keychain, the
  Windows store, the Linux system bundle. A TLS-inspecting proxy whose root
  your device management installed is then trusted for model traffic, the
  approval broker and the audit and telemetry collectors, without
  `NODE_EXTRA_CA_CERTS`. It is applied when a command starts; a Node that
  cannot add the store while running says so on stderr, and
  `NODE_OPTIONS=--use-system-ca` does the same from the start.
- **Gateway headers.** A `models.json` provider's `headers` ride every
  request: a literal value, or a `$VAR` / `!command` resolved per request
  (see [models](models.md)).
- **Client certificates.** A `models.json` provider's `tls` names the client
  certificate and key its requests present, and optionally the CA its
  gateway's certificate chains to:

```json
{
  "providers": {
    "gateway": {
      "baseUrl": "https://llm-gateway.corp.example/v1",
      "api": "openai-completions",
      "apiKey": "$KUBIC_GATEWAY_API_KEY",
      "headers": {"x-portkey-config": "team-a"},
      "tls": {
        "cert": "/etc/kubic/client.pem",
        "key": "/etc/kubic/client.key",
        "ca": "/etc/kubic/gateway-ca.pem"
      },
      "models": [{"id": "gpt-5", "contextWindow": 400000}]
    }
  }
}
```

Proxy variables (`HTTPS_PROXY`, `NO_PROXY`) are honoured as described in
[Proxies](models.md#proxies).

## Headless approvals

`kubic run` has no terminal to ask on. Two sources let a run in CI or
automation get an approval instead of a refusal:

```toml
[approvals]
broker = "https://approvals.example.com/kubic"
brokerTokenEnv = "KUBIC_BROKER_TOKEN"
maxPendingMs = 600000
preApprovalKey = "/etc/kubic/approvals.pub"
```

### The approval broker

With `broker` set, each challenged call is posted to the broker as one ask,
and the run waits for a person's answer, at most `maxPendingMs`. An ask
nobody answered in time is denied, and the run ends `approval_timed_out`
(exit 4). The bearer token comes from the variable `brokerTokenEnv` names; a
run whose variable is unset is refused before it starts. The broker URL is
https, or plain http to this machine only. A Slack, Teams or GitHub-check
bridge implements this protocol on its side:

```
POST <broker>   {"kind": "kubic.approval", "version": 1, "id": "…",
                 "sessionId": "…", "workspace": "/repo", "tool": "bash",
                 "capability": "destructive-shell",
                 "summary": "bash: rm -rf build", "command": "rm -rf build",
                 "deadline": "2026-10-21T12:10:00.000Z"}
answer          {"decision": "allow-once" | "allow-session" | "deny" | "pending",
                 "by": "alice", "reason": "…", "poll": "/asks/…"}
GET <poll>      the same answer, polled every two seconds until it is not
                "pending"
```

`poll` is resolved against the broker URL, must stay on its origin, and
defaults to `<broker>/<id>`. The ask carries what the TUI's approval card
shows, the summary and the redacted command, never the raw arguments.
`allow-once` approves this call only; `allow-session` approves the same
operation for the rest of the session; `deny` refuses it, and the model reads
`denied by <by> through the approval broker: <reason>`. Every answer is
recorded in the audit ledger like a TUI answer, with `broker:<by>` as the
approver. A broker that cannot take the ask (an error status, a malformed
answer) denies the call, named. A poll that fails is retried until the bound
passes.

### Pre-approval files

A job can carry its own list of what it may run, signed by the organization:

```json
{
  "version": 1,
  "job": "nightly-deps",
  "reason": "the nightly dependency refresh",
  "expires": "2026-11-01T00:00:00Z",
  "grants": [
    {"capability": "install", "tools": ["bash"], "commands": ["npm ci", "npm install *"]},
    {"capability": "network", "tools": ["bash"], "commands": ["npm ci"]}
  ]
}
```

`kubic run --pre-approvals job.json` (or `KUBIC_PRE_APPROVALS=job.json`)
verifies the file against `<file>.sig` and `preApprovalKey` before the run
starts: an unsigned file, a file changed after it was signed or signed with
another key, an expired file and an unknown key are refused (exit 2). A grant
approves its capability for the tools it names (any tool when `tools` is
absent) and, when it lists `commands`, only for a command that matches one of
them. A `*` stands for any text without a shell operator (`;`, `&`, `|`, a
backtick, `$`, `<`, `>`, a parenthesis or a newline), so `npm install *`
never covers `npm install x; curl …`. The file is checked on every call and
never latched; `kubic-state-write` always asks and no file grants it. Each
granted call is recorded as approved by `pre-approval:<job>`.

Sign the file like a managed policy, with
`kubic policy sign --key <private.pem> job.json` or OpenSSL (see
[Signed managed files](#signed-managed-files)). `broker`, `brokerTokenEnv`
and `preApprovalKey` are read from the enterprise, product and global layers
only: a project config setting any of them is refused, because a repository
must not route a run's asks to a broker of its own or bless its own
pre-approvals.

## Admin hooks

```toml
[[hooks]]
event = "beforeTool"
command = "/opt/acme/kubic-check"
tools = ["bash", "write", "edit"]
timeoutMs = 5000

[[hooks]]
event = "runEnd"
command = "/opt/acme/kubic-report"
```

An organization, or a user for their own machine, runs its own scripts at
three points:

- `beforeTool`: before each tool call, once the approval ask allowed it,
  with the arguments that will run (an operator's edit included). A hook
  that exits non-zero refuses the call: the model reads `Tool call blocked:
  refused by the hook "<command>": <reason>`, where the reason is the first
  line the hook printed (stdout, else stderr). A hook that runs past
  `timeoutMs` is killed and refuses the call too, and so does one that
  cannot start: a before-tool hook fails closed.
- `afterTool`: after each tool call, with its result. It observes: its exit
  never changes what the model reads.
- `runEnd`: when a `kubic run` settles, with its status and final answer.
  In `kubic tui` each settled turn is a run end, with no answer.

`tools` narrows a tool hook to the tools it names; absent, it runs for every
tool. The hooks run in order (the enterprise layer's first, then the product
and global layers'), and the first refusal wins.

Each hook runs as `sh -c <command>` in the workspace, with the event as JSON
on stdin:

```json
{"event": "beforeTool", "sessionId": "…", "workspace": "/repo", "model": "anthropic/claude-sonnet-5-5",
 "tool": {"name": "bash", "arguments": {"command": "npm test"}}}
```

An `afterTool` payload adds `isError` and `output` (at most 64 KiB) under
`tool`; a `runEnd` payload carries `status` and `summary` instead of `tool`.
`KUBIC_HOOK_EVENT` names the event. The environment is the one the tools
get, so a hook never sees a provider key, and a hook keeps at most 64 KiB of
what it prints.

Every hook run is a `hook:<event>` row in the audit ledger, with the command,
the tool and the result: `ok`, `deny` (a refused call) or `error` (an
after-tool or run-end hook that failed or timed out). The hooks come from the
enterprise, product and global layers only: a project's `.kubic/config.toml`
that declares `[[hooks]]` is refused by name, because a repository must not
run commands of its own around every tool call.

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
  undo restores (`undo-restore`), gate commands (`verify:<gate>`) and
  admin hook runs (`hook:<event>`), dropping everything else (the per-request credential rows); `all` keeps
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
