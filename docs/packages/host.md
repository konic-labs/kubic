# `@kubic/host`

> The host runtime: approvals, config, roles, doctor and the command
> implementations.
> Source: `packages/host/src`.

`@kubic/host` is everything around the agent lane that decides, records
and reports: the approval safety model, layered config and project trust,
role resolution, `kubic doctor`, the audit ledger, spans and the debug
channel, and the implementations behind the CLI commands. Kubic has
no isolation — docs and code must never imply otherwise.

## Layout (`packages/host/src`)

The package is a set of concern folders. Each folder's `index.ts` is its
public entry and the package export `@kubic/host/<folder>`; a module in one
folder reaches another folder only through that entry (`npm run lint:deps`
rejects a deep import into another folder's modules). Tests import the
modules of their own folder directly; entry exports that exist only for the
composition-root tests are tagged `@internal`.

| Folder | Owns |
| --- | --- |
| `approvals/` | The approval system: `installPolicy` and its posture, capabilities and `validatePolicy`, the stores, the decider service, full access, the trigger detectors over the shell lexer, git, `cd` and glob helpers (`shell/`), control-plane refusal, the credential-path detector and what an approval dialog shows |
| `audit/` | The audit ledger (`ledger.ts`: location, the redacting append, reads), its records (`records.ts`, `audit.ts`), the configured sinks and the syslog transport (`sinks.ts`, `syslog-transport.ts`), the provider-key audit record, and `kubic audit` |
| `cli/` | Shared command plumbing: the output channels and theme (`cli-io.ts`) and project-root discovery |
| `config/` | Layered TOML config and its validation (`config.ts`), the runtime load every command runs on (`runtime.ts`), comment-preserving edits (`toml-model.ts`), project trust (`trust-store.ts`), the MCP and ACP stances, and `kubic config`, `kubic setup` and `kubic trust` |
| `cost/` | `kubic cost`: per-session cost rows, the prompt-cache hit rate and the usage a headless run reports |
| `doctor/` | `kubic doctor`: the checks (`checks/`) collected in report order (`collect.ts`), the command (`command.ts`), the grouped summary, the honest-limit checks, the no-isolation notice and the live full-access session list |
| `git/` | `kubic git` (status, log, stage, commit) over the agent git operations |
| `journal/` | `kubic diff`, `undo`, `log`, `status` and `journal prune` |
| `models/` | The model catalogue (built-ins plus `models.json`), provider probes, the `KUBIC_PROVIDER=faux` testing provider, provider key hints and `kubic models` |
| `policy/` | The enterprise policy: layer validation (`validate.ts`), resolution of the effective policy (`resolve.ts`), the tool, model and provider gates (`gates.ts`), its doctor checks, and `kubic policy` |
| `presentation/` | Folds lane events and approval facts into the `KubicPresentationState` the TUI renders |
| `replay/` | `kubic replay` over trajectory exports, and the re-execution runner |
| `roles/` | The five built-in roles, role documents and their layer merge, and role loading from `.kubic/roles/*.md` |
| `run/` | `kubic run`: argument parsing, the result envelope and exit-code mapping (`run-cli.ts`), the span recorder and run and turn spans, the run trajectory assembler, and the `[verify]` gates whose results become the trajectory's `signal:<gate>` labels |
| `secret-refs/` | Request-time secret references (`$ENV_VAR`, `!command`), the model key resolver and the redaction of resolved secrets |
| `sessions/` | `kubic sessions` and its pruning, read-only session access for listings and cost, and per-session summaries and usage |
| `skills/` | The skills boot the lane runs and `kubic skills` |
| `test-support/` | Fixtures for tests only (the dependency lint keeps them out of production code) |

`config/` and `approvals/` stay folders rather than packages of their own:
`config/` validates the `[approvals]` table with the approval policy and
reads enterprise policy, and `approvals/` writes the audit ledger, so
either package would depend back on the rest of the host.

## Contracts

### Spans and the debug channel (`run/spans.ts`, `run/run-spans.ts`)

`spans.ts` is the span recorder (`SpanRecorder` over `SPAN_NAMES`), the
`--debug` vocabulary (seven classes) and the transcript
sinks. `run-spans.ts` maps what the lane and the harness actually
do onto it and `apps/kubic/src/run/` drives it, so a real
`kubic run` records `kubic.agent.run` → `kubic.lane.accept` /
`kubic.lane.drive` → `pi.tool.execute`, with parent linkage and per-span
ms. `accept` covers admitting this run's work (settling a pending turn
first) and `drive` the durable turn itself (`conversation.submit()` →
`submission.wait()` → settlement). The tool spans come from
`runSpanHooks`, installed as the `kubic.spans` extension's `ToolTask`
hooks after `kubic.policy`, so a blocked call opens no span —
`beforeTool` opens the span, `afterTool` closes it and returns the result
unchanged (the hook never fails a call).

Two destinations, both documented on the
[commands page](../cli/commands.md#where-the-spans-go):

1. **stderr, behind `kubic run --debug`** — each span close emits one
   classed line through the shared `DebugSink`. Off by default, so stdout
   stays consumable and the exit contract is unchanged.
2. **the session artifact** — the same spans are serialized to
   `spans.jsonl` under the session directory (`<sessionsRoot>/<id>/`), one
   JSON object per closed span: `kubic run` writes the lane accept/drive
   steps plus one `pi.tool.execute` span per tool call, and `kubic tui`
   one `kubic.agent.run` span per settled turn plus that turn's tool spans
   (`TurnSpans`, fed from the committed lane events).

A tool span whose call never settled before the run ended is closed by
`endRun` (`error=run ended before the call settled`) instead of being
serialized with `endMs: null`.

### Approvals (`approvals/`)

`CAPABILITIES` (9): `network`, `credentials`, `git-push`,
`destructive-shell`, `install`, `deploy`, `outside-write`,
`privilege-escalation`, `kubic-state-write`. `kubic-state-write` always
asks, and `controlPlaneRefusal` refuses writes into
`.kubic/journal|audit|sessions` outright — the workspace's, an
ancestor's or `~/.kubic`'s — plus the session root in use
(`installPolicy({ home, sessionsRoot })`).

| Interface | Fields |
| --- | --- |
| `ApprovalPolicy` | `route: 'ask-user' \| 'deny'`, `autoApprove: Capability[]` (explicit-only, defaults empty), `sessionScoped: boolean` (default true), `maxPendingMs: number` (default 60_000), `requireJustification: boolean` (default false) |
| `ApprovalRequest` | `key: string`, `capability: Capability`, `toolName: string`, `summary: string`, `justification?: string` |
| `ApprovalVerdict` | `{ approved: true, by: string, justified?: boolean } \| { approved: false, reason: string }` |

`ApprovalStore` (`load`/`save`) has memory and file backings;
the installed ask (`installPolicy`) over `ApprovalService` serves the lane interception
point; `detectTriggers` maps tool calls to capabilities via
`TriggerContext`. The lane awaits the ask inside its pi-durable
`ToolTask.beforeTool` hook, which runs before the tool's intent is
committed — so the service's `maxPendingMs` bound still denies a seat
that never answers, and a crash mid-ask re-raises the ask on resume
instead of resuming the call unapproved. The bash detectors are
literal-pattern heuristics with two documented shapes: a
`tee`/`cp`/`mv`/`install` write target is the last argument of the
command segment, and `sudo` matches by word anywhere in the raw command —
deliberately over-triggering, since a raised capability becomes an ask,
never a silent grant. Both heuristics and the remaining bypasses are
documented on the [configuration](../cli/configuration.md) page.

### Config (`config/`)

Layered TOML config (`CONFIG_LAYERS`) parsed by `parseTomlConfig` and
round-tripped by `serializeTomlConfig`; `mergeLayered` merges
`LayerInput`s into `MergeResult`; the committed-vs-ignored split is
enforced by `COMMITTED_CONFIG_FILES`, `GITIGNORE_REQUIRED_ENTRIES`,
`isCommittedConfigPath` and `checkGitignoreSplit`. An `[mcp]` table fails
closed (`McpUnsupportedError`).

The ship-vs-ignore split is not kept by hand twice:
`GITIGNORE_REQUIRED_ENTRIES` is derived from `@kubic/exec`
`runtime-exclude.ts` — the entries `kubic run` and `kubic tui` write into
a user repo's local `.git/info/exclude` under a rewritable marker block.
`.kubic/` itself is never ignored, so `config.toml` and `roles/*.md` stay
committable.

### Doctor (`doctor/`)

Exit codes: 0 ok, 1 fail, 2 usage, 6 provider. `DoctorStatus` is
`pass|warn|fail|skip`; `collectDoctorChecks` folds `DoctorDeps` (provider
and dep probes) into a report of `DoctorCheck`s.
`probeSessionOverlap` adds the repo-level `session:overlap` note: warn
when two or more sessions are recorded against the workspace — a
disclosure of the end-of-run sweep's blind spot, never a block and never
exit-flipping. `probeStatePermissions` adds `state:permissions`: a `warn`
naming a group- or world-accessible sessions root (its mode and the
`chmod 700` that closes it), a `pass` when it is private or absent, and
`state permissions unverified` when the probe itself throws.

### Session retention (`sessions/`)

`kubic sessions prune` is the only thing that deletes whole session state
dirs, and it is opt-in twice over: dry-run is the default (deletion needs
`--yes`), and the keep window must come from `--keep-days` or config
`session.retentionDays` — with neither, the command exits 1 naming both
rather than inventing a window (`--keep-days 0` / `retentionDays = 0`
means retention is off: nothing is pruned, exit 0). `planSessionPrune`
owns the planning rails: a session holding a live lock is never a
candidate (`sessionLockIsLive`, a read-only view deliberately stronger
than the steal rule), a session whose state dir mtime is at or before the
cutoff is a candidate (a recently attached session survives even with old
inner files), `--keep-session` names are protected, and
non-session-shaped entries (plain files, a stray `lock.json`, names
outside `[A-Za-z0-9_-]`, Pi's `--<cwd>--` transcript dirs) are never
touched. A session that cannot be inspected is skipped, never guessed at.
`deleteSessionPruneCandidates` re-checks `sessionLockIsLive` immediately
before each `bridge.remove`, so a lock acquired between plan and delete is
skipped and reported exactly like a planning-time lock — never counted as
pruned. Scope is `<sessions-root>/<id>/` state dirs only — the workspace
journal belongs to `kubic undo`/`kubic log`, and the same retention window
also self-heals session journal entries at read time via
`kubic log --session`.

## Dep-direction neighbours

- May import: core, exec, [agent](agent.md),
  [trajectory](trajectory.md), [eval](eval.md) — never [tui](tui.md).
- Imported by: `apps/kubic` (the composition root wires host + tui).

```text
core + exec ──→ agent ──→ @kubic/host ──→ apps/kubic
                                     ↑   ↑
                               trajectory eval (read)
```

Back to the [docs index](../README.md).
