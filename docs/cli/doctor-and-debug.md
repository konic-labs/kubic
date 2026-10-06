# Doctor and debug

> Design ref: `kubic doctor` diagnostics (`packages/host/src/doctor.ts`,
> issue #29; honest-limits registration in
> `packages/host/src/limits/doctor-limits.ts`, issue #58).
> Presentation only: providers are listed, never dialled (faux-only
> probes, zero network); deps check the live node runtime.

## Running it

```
kubic doctor [--skip <id[,id…]>]... [--json] [--verbose] [--session <id>]
```

`kubic doctor --help` prints the generated help. **On an interactive colour
terminal** (issue #448) the report is a grouped summary: a totals line, the
checks grouped by area (RUNTIME, PROVIDERS, PROJECT, POLICY, LIMITS, ROLES,
SKILLS, and OTHER for anything new) with `✓` / `▲` / `✕` / `○`, passing
checks packed onto shared lines, every warning on its own short line, a
failure always in full, and the six honest-limit warnings folded into one
`▲ honest limits: …` line:

```
■ kubic doctor · 28 checks · 19 ok · 9 warnings · 0 failed

RUNTIME     ✓ node 24.13.0   ✓ config   ✓ models.json   ✓ extensions 1 loaded, 2 refused
PROVIDERS   ✓ anthropic  23 models  key from ANTHROPIC_API_KEY   ✓ provider available
PROJECT     ▲ overlap — 5 sessions recorded against /repo
POLICY      ✓ approvals ask-user   ✓ workspace-write · network none · 18 tools   ✓ routing policy
            ▲ guards are detection-only (lexical), not a sandbox
LIMITS      ▲ memory and disk caps are not enforced; wall clock is
            ▲ honest limits: solo no isolation · worktrees writers only · …
ROLES       ✓ role credentials   ✓ debugger   ✓ implementer   ✓ planner   ✓ reviewer
SKILLS      ✓ skills 0 loaded

9 warnings, nothing blocking · kubic doctor --verbose for the full report
```

`--verbose` prints the full report below on a terminal too. Off a terminal
(a pipe, a file, CI, `NO_COLOR`) the full report is always what prints.
Each check prints one human line on stdout (the status word coloured on a
colour terminal; plain text under a pipe or `NO_COLOR`); notes such as a
`models.json` load go to stderr as `info:` lines, so stdout — and `--json`
— carry only the report:

```
PASS provider:local (ok): listed, not dialled, 1 model(s) registered — from /repo/models.json
PASS provider:anthropic (ok): listed, not dialled, 23 model(s) registered — built-in, auth from ANTHROPIC_API_KEY
doctor: 4 pass, 6 warn, 0 fail, 0 skip
```

Provider lines are explicit about what was measured: `listed, not dialled`
means the provider is registered in the catalog but nothing contacted it
(the default probe — zero network). A probe that really dialled reports
`dialled and reachable`; the line never claims reachability it did not
observe. Each line names where the provider came from (`built-in` with its
auth source, or the `models.json` path). Only **usable** providers are
listed: Pi's built-ins whose env key / ambient credentials are not set
are left out (they are not available to a run — `kubic models` names
them).

`--json` emits `{ok, exitCode, checks}` with the same checks and the
same exit code. Exit contract: 0 clean, 6 provider-down, 1 any other
fail, 2 usage error — full table on the
[exit-codes page](exit-codes.md).

Under `KUBIC_PROVIDER=faux` the `faux` testing provider is listed like
any other and a `warn:` line on stderr names it — a clean doctor under the
switch says nothing about a real provider.

On a fresh clone with no provider configured, doctor exits 6 with
exactly one failure — `FAIL limit:provider-availability (provider-down)` —
and everything else passing (`warn` never flips the exit). Configure a
provider (see [configuration](configuration.md)) for a fully clean matrix.

## What each check means

Statuses: `pass` / `warn` / `fail` / `skip`. Reasons: `ok`,
`provider-down`, `policy-mismatch`, `deps-missing`,
`extension-posture`, `full-access`, `unsupported-level`,
`detection-only`, `skipped`. `warn` is informational only — it never flips
the exit code.

| Check id | Meaning | Red means → look at |
| --- | --- | --- |
| `provider:<id>` | Is the provider reachable, and how many models are registered? (`listed, not dialled` when nothing contacted it.) | `reason: provider-down` → configure the provider (see [configuration](configuration.md)); note `kubic run` exits 6 on provider failure. |
| `dep:<id>` | Is the dependency present? (Today: `node`, needs >= 22.19.) | `reason: deps-missing` → install/upgrade the dep; the detail line says what was found. |
| `dep:models-json` | Which `models.json` files were found, their scope (`global`/`project`) and state: `loaded <ids>`, `ignored, untrusted` (a project file before `kubic trust` / `KUBIC_TRUST_PROJECT=1`) or `invalid — <reason>`. Fails only on an invalid file. | Fix or remove the named file — see [configuration](configuration.md#modelsjson). |
| `dep:credentials:roles` | Which provider each role's workers get credentials for (issue #200), over the same default delegation set a bare `kubic orchestrate` assigns and the same resolution the orchestrate credential preflight uses — provider **names only** (`implementer→gw`; when one role resolves to several providers — per-agent `--agents <id>:<role>:<provider/id>` pins — the agent id qualifies the entry, `a(implementer)→gw, b(implementer)→anthropic`). Fails when a role's provider key is not in this environment — or its credential cannot reach a worker at all (`amazon-bedrock`, `azure-openai-responses` and `google-vertex` on application default credentials read process-level configuration the worker env allowlist does not carry) — naming the provider: the run itself would fail closed with exit 6 before creating a worktree. Roles the manager would refuse under the enterprise tool policy (see `role:<name>`) get no worker, so they are left out of the line; under a frozen enterprise `[model]` the provider named is the enterprise model's, not the one a `KUBIC_MODEL` the freeze dropped would name. | Run `kubic orchestrate` on a repo whose role expects a provider key: set the provider's env key (see [configuration](configuration.md)) or point the role/operator model at a configured provider. |
| `policy:approvals` | Does the approval policy validate? Unknown `autoApprove` capabilities (outside the known set plus `requires:<tool>` triggers), `autoApprove` entries under `route=deny` (they can never apply), or an outright invalid shape. An always-ask capability in `autoApprove` (`kubic-state-write`) is a `warn` (exit-neutral) naming it as ignored, and the line's `N auto-approved` count leaves it out. | Your `[approvals]` config — see [configuration](configuration.md). |
| `policy:installed` | What does a run from this directory actually install? Prints the **installed** posture — `source=` (`config` or `default`), the five permission classes, the derived tool allowlist, and the named guards (`permission-wrapper`, `destructive-guard`, `network-guard`, `confine-guard`, `approval`), plus `route=`. A posture that contradicts itself (no interceptors, `ask-user` without an approval interceptor) fails with `policy-mismatch`: the line can never describe a policy no run enforces. | A `policy-mismatch` here is an install bug, not a config typo — the classes come from `[permissions]` when the config supplies them and from the documented solo defaults otherwise. |
| `policy:detection-only` | Which installed classes are **lexical detection, not enforcement** (issue #289, §58/§59.1): `network=none` is a bash command detector (a script the agent writes and runs can reach the network), `filesystem=…` is lexical path confinement (symlinks are not resolved), `credentials=none` is a lexical credential-path detector (only the listed paths are challenged). Always `warn` (exit-neutral); omitted entirely when nothing is detection-only. | Nothing to fix — it is a disclosure. If it matters for your threat model, the run needs OS-level isolation, which solo mode does not have (§59.1). |
| `policy:enterprise-sinks` | Audit-sink posture from the resolved `[policy]`: syslog-first order and availability. Fails when no sink is configured, when syslog is not first, or when the syslog target is unreachable (the target is probed for real now). Only appears when a `[policy]` section is configured. | Add/fix the `[[audit]]` tables — see [configuration](configuration.md#enterprise-policy-policy-58). |
| `audit:sink:<kind>-<n>` | One check per configured `[[audit]]` table: reachable sinks pass naming target and level; a missing unix socket, an unbuilt table, or a runtime failure the process recorded fails with `sink-unreachable`. Only appears when `[[audit]]` tables are configured. | Fix the target the detail names, or remove the table — see [configuration](configuration.md#audit-sinks-audit). |
| `policy:enterprise-network` | The resolved `[policy]` network mode: fails when it is `allowlist` with no domains, which allows nothing and is unenforceable. Only appears when a `[policy]` section is configured. | Give the allowlist its domains, or use `none`/`full` — see [configuration](configuration.md#enterprise-policy-policy-58). |
| `policy:enterprise-enforceability` | Aggregate over the two enterprise items above: `fail` when any of them is unenforceable, `pass` when the configured policy is enforceable on this host. Only appears when a `[policy]` section is configured. | Fix the named failing item. |
| `role:<name>` | One check per role — the five §12 presets embedded in the binary (issue [#203](https://github.com/konic-labs/kubic/issues/203)) plus any `.kubic/roles/<name>.md` document, which replaces its preset of the same name — judged the way `kubic run --role <name>` resolves it: the winning document merged under the config `[roles.<name>]` layers. `pass` names the layer the role came from and lists the resolved tool set (`builtin role — 15 tool(s): …`, `repo role — …`). Fails (`policy-mismatch`) with the resolver's named reason for a contradictory document (§40.3) and, under an enterprise `[policy]` tool gate (§58), for a role that declares a denied tool or one outside `allowed_tools` — `role 'implementer' refused: tool 'bash' denied … enterprise denial holds`; a `[roles.<name>]` layer that narrows the denied tool away keeps it green. `kubic orchestrate` refuses the same assignment (`role_refused`) before anything spawns. A document that fails to parse fails as `role:<file-stem>` naming the file and the parse error (issue #236) — it never blocks the other roles; two documents declaring the same name fail as `role:<name>` listing both files. An unreadable role directory still reports as `role:documents`; an absent one is not a failure — the embedded presets report instead. | Fix the document (or the layer) the detail names; a denial is the enterprise policy working — see [configuration](configuration.md#enterprise-policy-policy-58). |
| `session:overlap` | How many sessions are recorded against this cwd in the local session store? Two or more prints `warn` with the session ids (issue #118): concurrent **different**-session runs stay legal, but each run's end-of-run sweep compares against its own boot baseline, so a live sibling's in-flight changes are recorded as unattributed, non-reversible journal entries. The store lists sessions, so the note is a possible overlap, never a verified one. | Nothing to fix — the overlap is disclosed, not blocked (`warn` never flips the exit). If the journal accounting matters, run the sessions one at a time. |
| `session:full-access:<id>` | Is a live session in this workspace running with approvals off? One `warn` per session whose `posture.json` records `fullAccess` (§41.4, issue #310) — the detail names the grant (`enabled <time> by <operator>`, when the posture recorded it) and the way back (`end the session or switch approvals back on; new sessions start enforced`). Only live sessions are listed (a released session's grant expired with it), so a quiet matrix means no live session has approvals off — an unlistable store warns once as `session:full-access` instead of crashing. `doctor --session <id>` checks exactly one session (workspace filter bypassed) and its `policy:installed` line reads that session's `posture.json`, so a full-access session reports `FULL ACCESS recorded for this session`. The same sessions appear under `doctor --json` as `session:full-access:<id>` checks. | Nothing to fix unless the access is unintended — `warn` never flips the exit. Full access is operator intent (`--dangerously-skip-approvals` or the in-session toggle); to revoke it, end the session or switch approvals back on. |
| `extension:bundle` | Did the first-party bundle (`kubic/budget`, under `skills/budget/`) load through the trust gates? Reports `loaded N (…)` plus `refused M (…)` — the two live bypass probes (owned-path traversal, truthy remote flag) are refused on every run. | `reason: extension-posture` → the bundle dir is missing/unreadable, the manifest failed the trust gates, or (tripwire) a bypass was admitted: fix the install (`skills/budget/manifest.json`), never `--skip` it into silence. A fail exits 1. |
| `license:kubic` | License identity (`MIT`). Always passes; reported, never skipped implicitly (explicit `--skip license:kubic` still works). | Nothing — informational. |
| `policy:enforceability` | Can v1 actually honor the policy? `[mcp]` keys and `mcp:`/`extensions:`/`third-party:` autoApprove values fail here with the refusal. Invalid shapes are **not** double-failed — they point at `policy:approvals`. | Remove the v1-unsupported key (MCP arrives in Phase 4). |
| `limit:provider-availability` | Is at least one provider available? (`listed, not dialled` unless a probe really dialled.) | Same as `provider:<id>` — configure a provider. |
| `limit:deps-present` | Are all dep probes present? | Same as `dep:<id>`. |
| `limit:<…>` (six static notices) | Honest §59.1 limits, always `warn`: solo has no isolation, worktrees separate writers only, no injection prevention, policy is an offer not enforcement, journal is not a backup, no third-party MCP. | Nothing to fix — they are disclosures, not failures. If your matrix is all-green except warns, you are healthy (exit 0). |

## Debugging with `--skip`

`--skip` marks checks skipped (comma-separated, e.g.
`--skip license:kubic,limit:solo-no-isolation`) — useful to isolate a
red check from noise. Skipping an id that matches no check exits 2, so
a typo fails closed instead of silently passing.
`--skip extension:bundle` is an explicit operator override for a
known-broken install, not a recovery — the bundle stays unloaded while
skipped.

Skipping a failing item also clears the aggregate over it: each probe
runs once per `doctor` call and the `limit:` aggregates derive from the
post-skip items, so `--skip dep:config-load` leaves
`limit:deps-present` skipped (exit 0 when nothing else fails) instead of
still failing it. Skipping every input of a section reports that
aggregate as skipped, never as a failure.

## What each path emits on `--debug` (§50, issue #246)

The §50 vocabulary is eight line classes (`[policy]`, `[worker]`,
`[session]`, `[tool]`, `[model]`, `[agent]`, `[exit]`, `handler_error`):

- **`kubic run --debug`** (stderr): the boot `[session] id=<id>
  parent=<id|none>` and `[policy] role=<name> tools=<…>` lines (a stock
  run names `role=solo (default)`), then per turn the `[agent]` run/lane
  spans, one `[tool] in/out` pair per tool call, one `[model]
  in=<n> out=<n> cached=<n> <provider>/<model>` line per committed
  response, and retry/compaction `[lane]` lines. A faulted harness task
  (pi-durable `task_failed` — Pi 1.0 has no `handler_error` event)
  surfaces as `handler_error hook=<kind> error=<message> verdict=deny`.
- **`kubic orchestrate --debug`** (stderr): one `[agent] worker start
  session=<worker-session>` line per launch plus the worker end line,
  alongside the existing `[worker] spawn …` rows. The per-launch
  `kubic.worker.start` span (with its nested `kubic.worker.startup`
  span, pinned to the registry's `startupMs`) is appended per settled
  worker to `<repo>/.kubic/orchestrator/<session>.spans.jsonl`; the
  worker child itself writes its session's `spans.jsonl` like a headless
  run, so both traces join on the worker session id.
- **`kubic tui`** has no `--debug` flag, so its lines are dropped — with
  two exceptions that always surface: a lane fault renders as a
  transcript notice (the `handler_error …` line; the TUI has no other
  failure channel), and every settled turn appends its spans to the
  session's `spans.jsonl` exactly like a headless run. The per-response
  spend stays on the status bar; the boot's `[session]`/`[policy]` lines
  and the per-response `[model]` line go to the (currently unwired)
  debug sink a test boot injects.
- **Dropped by design** (see [design drift](../design-drift.md)): the
  `(0 leaked handles)` count (nothing ever measured it) and `[tool]
  allowed` verdict lines (admission is enforced by the policy
  interceptor, which reports on the approval surface).

## When a command dies unexpectedly (`KUBIC_DEBUG`)

An unexpected failure — a bug in a command's wiring, an unshaped IO error —
reports one `error: <message>` line on **stderr** and exits **1**. There is
no stack dump and no stdout noise (`--json` consumers stay parseable); the
named paths the commands own — `kubic run`'s per-run failures, an
`ExtensionStartupError` from a lane boot — keep their own exit codes on the
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

The variable is the same one the worker spawn env forwards
(`packages/worker/src/lifecycle/env.ts`), so a spawned worker child inherits
it and its own failures print the same way. The launcher carries a first
check of its own: below Node 22.19 `./bin/kubic.js` refuses before loading
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
