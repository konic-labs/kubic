# Doctor and debug

> `kubic doctor` checks what a run needs and states Kubic's limits. This page
> explains every check, and how to look into a run that misbehaves.

## Running it

```text
kubic doctor [--skip <id[,id…]>]... [--json] [--verbose] [--session <id>]
```

| Flag | Meaning |
| --- | --- |
| `--skip <id[,id…]>` | Mark checks skipped (comma-separated, repeatable). An id that matches no check exits 2 (`error: unknown check "<id>"` on stderr); `--skip` without a value exits 2. |
| `--json` | Emit `{ok, exitCode, checks}` as one pretty-printed JSON document instead of human lines. Same exit code either way. |
| `--verbose` | On an interactive colour terminal, print every check in full instead of the grouped summary. Off a terminal the full report always prints. |
| `--session <id>` | Check one session, whatever its workspace (see [`session:full-access:<id>`](#sessionfull-accessid)). |

Doctor only reads: providers are listed, never dialled (the probes are
faux-only, with no network), and the dependency checks look at the running
Node. `kubic doctor --help` prints the generated help, and an unknown option
exits 2.

**On an interactive colour terminal** the report is a grouped summary: a
totals line, the checks grouped by area (RUNTIME, PROVIDERS, PROJECT, POLICY,
LIMITS, ROLES, SKILLS, and OTHER for anything new) with `✓`, `▲`, `✕` or `○`,
passing checks packed onto shared lines, every warning on its own short line,
a failure always in full, and the five limit warnings folded into one
`▲ honest limits: …` line. For example:

```text
■ kubic doctor · 26 checks · 18 ok · 8 warnings · 0 failed

RUNTIME     ✓ node 24.13.0   ✓ config   ✓ models.json   ✓ shell guards read POSIX shell
PROVIDERS   ✓ anthropic  23 models  key from ANTHROPIC_API_KEY   ✓ provider available
PROJECT     ▲ overlap — 5 sessions recorded against /repo
POLICY      ✓ approvals ask-user   ✓ workspace-write · network none · 18 tools   ✓ routing policy
            ▲ guards are detection-only (lexical), not a sandbox
LIMITS      ▲ memory and disk caps are not enforced; wall clock is
            ▲ honest limits: no isolation · no injection prevention · …
ROLES       ✓ debugger   ✓ implementer   ✓ planner   ✓ reviewer
SKILLS      ✓ skills 0 loaded

8 warnings, nothing blocking · kubic doctor --verbose for the full report
```

`--verbose` prints the full report on a terminal too, and off a terminal (a
pipe, a file, CI, `NO_COLOR`) the full report is always what prints. Each
check is one line on stdout in the shape `STATUS id (reason): detail`, the
status coloured on a colour terminal (pass green, warn amber, fail red, skip
grey) and plain under a pipe or `NO_COLOR`. Notes such as a `models.json`
load go to stderr as `info:` lines, so stdout, and `--json`, carry only the
report. For example:

```text
PASS provider:local (ok): listed, not dialled, 1 model(s) registered — from /repo/models.json
PASS provider:anthropic (ok): listed, not dialled, 23 model(s) registered — built-in, auth from ANTHROPIC_API_KEY
doctor: 4 pass, 6 warn, 0 fail, 0 skip
```

Provider lines say what was measured: `listed, not dialled` means the provider
is registered in the catalogue but nothing contacted it (the default probe,
with no network). A probe that really dialled reports `dialled and
reachable`; the line never claims reachability it did not observe. Each line
names where the provider came from (`built-in` with its auth source, or the
`models.json` path). Only **usable** providers are listed: a built-in whose
key or ambient credentials are not set is left out, since a run cannot use it
(`kubic models` names them).

`--json` emits `{ok, exitCode, checks}` with the same checks and the same exit
code. The exits: 0 clean, 6 when no provider is available, 1 for any other
failure, and 2 for a usage error; the full table is on
[exit codes](exit-codes.md).

Under `KUBIC_PROVIDER=faux` the `faux` testing provider is listed like any
other, and a `warn:` line on stderr names it: a clean doctor under that switch
says nothing about a real provider.

On a fresh clone with no provider configured, doctor exits 6 with exactly one
failure, `FAIL limit:provider-availability (provider-down)`, and everything
else passing (`warn` never changes the exit). Configure a provider (see
[models and providers](models.md)) for a clean report.

## What each check means

Statuses: `pass` / `warn` / `fail` / `skip`. Reasons: `ok`,
`provider-down`, `policy-mismatch`, `deps-missing`,
`full-access`, `unsupported-level`, `unsupported-platform`,
`detection-only`, `skipped`. `warn` is informational only — it never flips
the exit code.

| Check | What it checks |
| --- | --- |
| [`provider:<id>`](#providerid) | Is the provider available, and how many models does it register? |
| [`dep:<id>`](#depid) | Is the dependency present? |
| [`dep:models-json`](#depmodels-json) | Which `models.json` files were found, and whether each loaded. |
| [`models-window:<provider>/<model>`](#models-windowprovidermodel) | A `models.json` model that declares no `contextWindow`. |
| [`models-transport:<provider>`](#models-transportprovider) | A `models.json` provider that sends its key over plain `http`. |
| [`context-room`](#context-room) | How much room a compaction leaves for the next exchange. |
| [`policy:approvals`](#policyapprovals) | Does the approval policy validate? |
| [`policy:installed`](#policyinstalled) | What a run from this directory actually installs. |
| [`policy:detection-only`](#policydetection-only) | Which installed classes are lexical detection, not enforcement. |
| [`policy:enterprise-sinks`](#policyenterprise-sinks) | Whether the audit sinks take records off the machine, under an enterprise `[policy]`. |
| [`audit:sink:<kind>-<n>`](#auditsinkkind-n) | Each configured `[[audit]]` sink. |
| [`policy:enterprise-network`](#policyenterprise-network) | Whether the `[policy]` network mode is enforced. |
| [`policy:data`](#policydata) | What the `[policy] data_policy` value enforces. |
| [`policy:enterprise-enforceability`](#policyenterprise-enforceability) | Whether the configured enterprise policy is enforceable on this host. |
| [`role:<name>`](#rolename) | Each role, resolved the way `kubic run --role` resolves it. |
| [`sandbox`](#sandbox) | Whether the bash tool runs its commands in the OS sandbox. |
| [`instructions`](#instructions) | Which `AGENTS.md` files a run from here would load. |
| [`session:overlap`](#sessionoverlap) | How many sessions are recorded against this directory. |
| [`session:full-access:<id>`](#sessionfull-accessid) | A live session here that runs with approvals off. |
| [`state:permissions`](#statepermissions) | Whether Kubic's private state is private. |
| [`journal:out-of-scope`](#journalout-of-scope) | The paths the journal leaves out. |
| [`platform:shell`](#platformshell) | Which shell the bash tool runs. |
| [`license:kubic`](#licensekubic) | The license identity. |
| [`policy:enforceability`](#policyenforceability) | Can this version honor the policy? |
| [`limit:provider-availability`](#limitprovider-availability) | Is at least one provider available? |
| [`limit:deps-present`](#limitdeps-present) | Are all the dependencies present? |
| [`limit:<…>` (five static notices)](#limit-five-static-notices) | The limits Kubic states, always as a warning. |

### `provider:<id>`

Is the provider reachable, and how many models are registered? (`listed, not dialled` when nothing contacted it.) A built-in whose credentials are present but incomplete — Bedrock with no AWS region — is a `warn` naming what to set, and it is not counted as available.

**What to do:** `reason: provider-down` → configure the provider (see [configuration](configuration.md)); note `kubic run` exits 6 on provider failure. `reason: auth-incomplete` → set what the detail names (`AWS_REGION` for Bedrock).

### `dep:<id>`

Is the dependency present? (`node`, which needs >= 22.19.)

**What to do:** `reason: deps-missing` → install/upgrade the dep; the detail line says what was found.

### `dep:models-json`

Which `models.json` files were found, their scope (`global`/`project`) and state: `loaded <ids>`, `ignored, untrusted` (a project file before `kubic trust` / `KUBIC_TRUST_PROJECT=1`) or `invalid — <reason>`. Fails only on an invalid file.

**What to do:** Fix or remove the named file — see [configuration](models.md#modelsjson).

### `models-window:<provider>/<model>`

Does a `models.json` model run on the 8192-token fallback because it declares no `contextWindow`? One `warn` per such model, which never flips the exit: the context gauge and compaction use that window.

**What to do:** `reason: window-default` → set `"contextWindow"` for the model in `models.json` (see [configuration](models.md#modelsjson)).

### `models-transport:<provider>`

Does a `models.json` provider send its key over plain `http` to a host other than this machine? One `warn` per such provider (local servers on `localhost`, `127.0.0.0/8` or `::1` are exempt). Never flips the exit.

**What to do:** `reason: plaintext-key` → give the provider an `https` `baseUrl` (see [models](models.md#modelsjson-schema)).

### `context-room`

How much room does a compaction leave for the next exchange? The estimate is the window, less the reserve, the system entry (about 2800 tokens with the default tools), the kept window and a typical 800-token summary. It covers only the models you can configure: the models in `models.json` (global, and the project file when trusted), and the default model that `[model]` or `KUBIC_MODEL` selects. A built-in model is never named, since `models.json` cannot resize it. One `warn` names each such model below 4096 tokens (for example `local/llama3 (window 8192, about 986 tokens of room)`): compaction then runs every turn or two. A check with nothing in scope is left out. Never flips the exit.

**What to do:** `reason: room-short` → for a `models.json` model, set `"contextWindow"` to the model's real window; for the default model, choose one with a larger window (`kubic setup`, or `[model]`), or offer it fewer tools (`[policy] denied_tools`). A smaller `[session] keepRecentTokens` also leaves more room (see [configuration](configuration.md)).

### `policy:approvals`

Does the approval policy validate? Unknown `autoApprove` capabilities (outside the known set plus `requires:<tool>` triggers), `autoApprove` entries under `route=deny` (they can never apply), or an outright invalid shape. An always-ask capability in `autoApprove` (`kubic-state-write`) is a `warn` (exit-neutral) naming it as ignored, and the line's `N auto-approved` count leaves it out.

**What to do:** Your `[approvals]` config — see [configuration](configuration.md).

### `policy:installed`

What does a run from this directory actually install? Prints the **installed** posture — `source=` (`config` or `default`), the five permission classes, the derived tool allowlist, and the named guards (`permission-wrapper`, `destructive-guard`, `network-guard`, `confine-guard`, `approval`), plus `route=`. A posture that contradicts itself (no interceptors, `ask-user` without an approval interceptor) fails with `policy-mismatch`: the line can never describe a policy no run enforces.

**What to do:** A `policy-mismatch` here is an install bug, not a config typo — the classes come from `[permissions]` when the config supplies them and from the documented defaults otherwise.

### `policy:detection-only`

Which installed classes are **lexical detection, not enforcement**: `network=none` is a bash command detector for the listed network clients (an interpreter, a script the agent writes and runs, or an unlisted tool can still reach the network; the list is under [`network`](approvals.md#what-asks)), `filesystem=…` is lexical path confinement (the file tools refuse a path a symlink leads outside the workspace; the shell does not), `credentials=none` is a lexical credential-path detector (only the listed paths are challenged). Always `warn` (exit-neutral); omitted entirely when nothing is detection-only.

**What to do:** Nothing to fix — it is a disclosure. If it matters for your threat model, the run needs OS-level isolation, which Kubic does not have.

### `policy:enterprise-sinks`

Audit-sink posture of the configured `[[audit]]` tables under a `[policy]`: the first sink must be a collector that takes records off the machine (syslog, https or otlp), and syslog must be available. Fails when no sink is configured, when the first is a `file` or `memory` sink, or when a syslog target is unreachable (a socket target must be a unix socket the system logger can reach; a UDP target needs a creatable socket; a `tcp://`/`tls://` target delivers through its spool). Only appears when a `[policy]` section is configured.

**What to do:** Add/fix the `[[audit]]` tables — see [configuration](enterprise.md).

### `audit:sink:<kind>-<n>`

One check per configured `[[audit]]` table: reachable sinks pass naming target and level; a missing unix socket, an unbuilt table, or a runtime failure the process recorded fails with `sink-unreachable`. A spooled collector (`tcp://`/`tls://` syslog, `https`, `otlp`) passes while its spool is empty and warns while records wait in it. Only appears when `[[audit]]` tables are configured.

**What to do:** Fix the target the detail names, or remove the table — see [configuration](enterprise.md#audit-sinks-audit).

### `policy:enterprise-network`

The resolved `[policy]` network mode: passes for `network_policy = "proxy"` with `allowed_domains`, which the egress proxy enforces for the bash tool, and when `network_policy` is unset; fails for any other configured value, which nothing enforces (the bash guard is the `[permissions] network` class, a lexical detector). Only appears when a `[policy]` section is configured.

**What to do:** Set `"proxy"` with `allowed_domains` — see [The egress proxy](enterprise.md#the-egress-proxy) — or remove `network_policy`.

### `policy:data`

The `[policy] data_policy` value, when one is set: `pass` naming what `redact` or `redact-model` enforces (secrets scanned out of what sessions store and out of the raw transcript attach prints; with `redact-model`, out of tool output before the model reads it), `warn` for any other value, which is carried, not enforced.

**What to do:** Set `redact` or `redact-model` — see [Data loss prevention](enterprise.md#data-loss-prevention).

### `policy:enterprise-enforceability`

Aggregate over the two enterprise items above: `fail` when any of them is unenforceable, `pass` when the configured policy is enforceable on this host. Only appears when a `[policy]` section is configured.

**What to do:** Fix the named failing item.

### `role:<name>`

One check per role — the five presets embedded in the binary plus any `.kubic/roles/<name>.md` document, which replaces its preset of the same name — judged the way `kubic run --role <name>` resolves it: the winning document merged under the config `[roles.<name>]` layers. `pass` names the layer the role came from and lists the resolved tool set (`builtin role — 15 tool(s): …`, `repo role — …`). Fails (`policy-mismatch`) with the resolver's named reason for a contradictory document and, under an enterprise `[policy]` tool gate, for a role that declares a denied tool or one outside `allowed_tools` — `role 'implementer' refused: tool 'bash' denied … enterprise denial holds`; a `[roles.<name>]` layer that narrows the denied tool away keeps it green. A document that fails to parse fails as `role:<file-stem>` naming the file and the parse error — it never blocks the other roles; two documents declaring the same name fail as `role:<name>` listing both files. An unreadable role directory still reports as `role:documents`; an absent one is not a failure — the embedded presets report instead.

**What to do:** Fix the document (or the layer) the detail names; a denial is the enterprise policy working — see [configuration](enterprise.md).

### `sandbox`

Whether the bash tool's commands run in the OS sandbox: `pass` naming Seatbelt or bubblewrap under `[sandbox] mode = "auto"` or `"required"`; `warn` when it is off (naming a sandbox the machine has) or `auto` finds none; `fail` when `required` finds none, since `kubic run` and `kubic tui` then refuse to start.

**What to do:** Install bubblewrap on Linux, or set the mode — see [The bash sandbox](enterprise.md#the-bash-sandbox).

### `instructions`

Which `AGENTS.md` files a run from this directory would add to its prompt — the repository root down to the cwd, each only when its directory is trusted. `pass` lists the loaded files (or `no AGENTS.md loaded`); `warn` when a file is cut at 32 KiB or left out because its directory is untrusted, naming each; `skip` when `[agent] projectInstructions = false`. Grouped under PROJECT.

**What to do:** Trust the directory the detail names (`kubic trust <dir>`), or shorten the file. See [Project instructions](configuration.md#project-instructions-agentsmd).

### `session:overlap`

How many sessions are recorded against this cwd in the local session store? Two or more prints `warn` with the session ids: concurrent **different**-session runs stay legal, but each run's end-of-run sweep compares against its own boot baseline, so a live sibling's in-flight changes are recorded as unattributed, non-reversible journal entries. The store lists sessions, so the note is a possible overlap, never a verified one.

**What to do:** Nothing to fix — the overlap is disclosed, not blocked (`warn` never flips the exit). If the journal accounting matters, run the sessions one at a time.

### `session:full-access:<id>`

Is a live session in this workspace running with approvals off? One `warn` per session whose `posture.json` records `fullAccess` — the detail names the grant (`enabled <time> by <operator>`, when the posture recorded it) and the way back (`end the session or switch approvals back on; new sessions start enforced`). Only live sessions are listed (a released session's grant expired with it), so a quiet matrix means no live session has approvals off — an unlistable store warns once as `session:full-access` instead of crashing. `doctor --session <id>` checks exactly one session (workspace filter bypassed) and its `policy:installed` line reads that session's `posture.json`, so a full-access session reports `FULL ACCESS recorded for this session`. The same sessions appear under `doctor --json` as `session:full-access:<id>` checks.

**What to do:** Nothing to fix unless the access is unintended — `warn` never flips the exit. Approvals off is the operator's choice (`--dangerously-skip-approvals` or the in-session toggle); to undo it, end the session or switch approvals back on.

### `state:permissions`

Whether Kubic's private state is private: `~/.kubic` and `trust.json`, this workspace's audit ledger (`.kubic/audit/` and `audit.jsonl`), the trust grants' snapshots (`~/.kubic/trust-snapshots/`), then the sessions root and everything under it — each session directory, its `journal/` and `blobs/`, and every file there. A directory should be `0700` and a file `0600`; a looser one is named with the mode it should have (`<path> is 755, expected 700`), the first three in full and the rest counted. The walk is bounded (4096 entries, newest sessions first) and says when it stopped early. Always `warn` when something is loose (exit-neutral); skipped on Windows.

**What to do:** `chmod 700` the directory or `chmod 600` the file it names.

### `journal:out-of-scope`

Present only when `journal.outOfScope` is set: names the paths the journal leaves out and the layer that set them. A change under them is never journaled, so `kubic undo` cannot restore it. Always `warn` (exit-neutral).

**What to do:** Drop the entry if those changes should be undoable; see [`journal.outOfScope`](configuration.md).

### `platform:shell`

Which shell the bash tool runs and the shell guards read. Every approval detector reads POSIX shell commands, so on Linux and macOS it runs bash, and on Windows a POSIX bash: Git Bash (Git for Windows), else WSL, or the bash `KUBIC_BASH` names — passing and naming it. On Windows without one it warns (`unsupported-platform`): the bash tool refuses to run there rather than run `cmd` commands no detector reads. Exit-neutral.

**What to do:** Install Git for Windows or WSL, or set `KUBIC_BASH`.

### `license:kubic`

License identity (`MIT`). Always passes; reported, never skipped implicitly (explicit `--skip license:kubic` still works).

**What to do:** Nothing — informational.

### `policy:enforceability`

Can this version actually honor the policy? `mcp:`/`extensions:`/`third-party:` autoApprove values name no capability and fail here (an MCP tool that asks is approved by its tool name). Invalid shapes are **not** double-failed — they point at `policy:approvals`.

**What to do:** Remove the unsupported key.

### `limit:provider-availability`

Is at least one provider available? (`listed, not dialled` unless a probe really dialled.)

**What to do:** Same as `provider:<id>` — configure a provider.

### `limit:deps-present`

Are all dep probes present?

**What to do:** Same as `dep:<id>`.

### `limit:<…>` (five static notices)

Always `warn`: no isolation, no injection prevention, policy is an offer not enforcement, journal is not a backup, an MCP server's own reach is outside Kubic's interceptors.

**What to do:** Nothing to fix — they are disclosures, not failures. If your matrix is all-green except warns, you are healthy (exit 0).

## Debugging with `--skip`

`--skip` marks checks skipped (comma-separated, e.g.
`--skip license:kubic,limit:no-isolation`) — useful to isolate a
red check from noise. Skipping an id that matches no check exits 2, so
a typo fails closed instead of silently passing.

Skipping a failing item also clears the aggregate over it: each probe
runs once per `doctor` call and the `limit:` aggregates derive from the
post-skip items, so `--skip dep:config-load` leaves
`limit:deps-present` skipped (exit 0 when nothing else fails) instead of
still failing it. Skipping every input of a section reports that
aggregate as skipped, never as a failure.

## What each path emits on `--debug`

The vocabulary is seven line classes (`[policy]`,
`[session]`, `[tool]`, `[model]`, `[agent]`, `[exit]`, `handler_error`):

- **`kubic run --debug`** (stderr): the boot `[session] id=<id>` and
  `[policy] role=<name> tools=<…>` lines (a stock
  run names `role=default (default)`), then per turn the `[agent]` run/lane
  spans, one `[tool] in/out` pair per tool call, one `[model]
  in=<n> out=<n> cached=<n> <provider>/<model>` line per committed
  response, and retry/compaction `[lane]` lines. A faulted harness task
  (pi-durable `task_failed` — Pi 1.0 has no `handler_error` event)
  surfaces as `handler_error hook=<kind> error=<message> verdict=deny`.
- **`kubic tui`** has no `--debug` flag, so its lines are dropped — with
  two exceptions that always surface: a fault in the session renders as a
  transcript notice (the `handler_error …` line; the TUI has no other
  failure channel), and every settled turn appends its spans to the
  session's `spans.jsonl` exactly like a headless run. The per-response
  spend stays on the status bar; the boot's `[session]`/`[policy]` lines
  and the per-response `[model]` line go to the (currently unwired)
  debug sink a test boot injects.
- **Dropped on purpose**: the
  `(0 leaked handles)` count (nothing ever measured it) and `[tool]
  allowed` verdict lines (admission is enforced by the policy
  interceptor, which reports on the approval surface).

## When a command dies unexpectedly (`KUBIC_DEBUG`)

An unexpected failure — a bug in a command's wiring, an unshaped IO error —
reports one `error: <message>` line on **stderr** and exits **1**. There is
no stack dump and no stdout noise (`--json` consumers stay parseable); the
named paths the commands own — `kubic run`'s per-run failures, a session
store refusal — keep their own exit codes on the
[exit-codes page](exit-codes.md).

`KUBIC_DEBUG=1` opts into the full error (message and stack) printed above
the named line; the exit code is unchanged:

```
$ kubic run -p 'hi'            # an unexpected wiring failure
error: <message>

$ KUBIC_DEBUG=1 kubic run -p 'hi'
Error: <message>
    at …            (full stack)
error: <message>
```

The launcher carries a first check of its own: below Node 22.19 `kubic` (`bin/kubic.js`) refuses before loading
anything — `kubic: node >= 22.19 required (running <version>) — see the
README install section`, exit 1 — because on an older runtime the entry
import could only fail as a raw parser error.

## Where to look next when something is red

1. **Provider red** → `kubic models` (is anything registered?) →
   `models.json` / provider env keys → [configuration](configuration.md).
2. **Dep red** → `node --version` (need >= 22.19).
3. **Policy red** → your `[approvals]` table → [configuration](configuration.md).
4. **Run fails but doctor is green** → the failure is per-run, not
   environmental: check the `error:` line and the
   [exit code](exit-codes.md), then `kubic sessions attach <id>` and
   the `journal:`/`trajectory:` refs the run printed.

Back to the [docs index](../README.md). See also
[exit codes](exit-codes.md) and [commands](commands.md).
