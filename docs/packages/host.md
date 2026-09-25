# `@kubic/host`

> Design ref: host runtime wiring worker + agents.
> Owner: issue
> [#63](https://github.com/konic-labs/kubic/issues/63).
> Source: `packages/host/src` (read-only — this page quotes it, never moves it).

`@kubic/host` is the host runtime: handoff assembly, the approval
safety model, layered config, worker lifecycle wiring, the orchestrator,
and the headless/CLI command surfaces. Solo mode has no isolation —
docs and code must never imply otherwise (design §59.1).

## Public API (`packages/host/src`)

| Module | Exports |
| --- | --- |
| `approvals.ts` | `CAPABILITIES`, `Capability`, `ApprovalPolicy`, `PolicyValidationError`, `validatePolicy`, `ApprovalRequest`, `ApprovalVerdict`, `ApprovalStore`, `MemoryApprovalStore`, `FileApprovalStore`, `TriggerContext`, `detectTriggers`, `approvalKey`, `summarizeRequest`, `AccessPosture`, `ApprovalAsk`, `createApprovalAsk`, `enableFullAccess`, `ApprovalServiceOptions`, `ApprovalService` |
| `config/config.ts` | `CONFIG_LAYERS`, `ConfigLayer`, `ConfigError`, `ProjectUntrustedError`, `BudgetKeyError`, `AgentConfig`, `ModelConfig`, `ModesConfig`, `ApprovalsConfig`, `PermissionsConfig`, `JournalConfig`, `RoleConfig`, `OrchestratorConfig`, `UiConfig`, `SessionConfig`, `KubicConfig`, `KNOWN_CONFIG_SECTIONS`, `EXAMPLE_TOML`, `assertNoBudgetKeys`, `parseTomlConfig`, `serializeTomlConfig`, `parseLayerConfig`, `LayerInput`, `MergeResult`, `mergeLayered`, `defaultLayerPaths`, `COMMITTED_CONFIG_FILES`, `GITIGNORE_REQUIRED_ENTRIES`, `isCommittedConfigPath`, `checkGitignoreSplit`, `loadLayered` |
| `config/runtime.ts` | `loadRuntimeConfig`, `effectiveConfigView`, `renderEffectiveConfig`, `checkWorkspaceIgnoreSplit`, `RuntimeConfig`, `RuntimeConfigInputs`, `ConfigValueSource`, `EffectiveConfigView`, `RuntimeKeyEffect`, `RUNTIME_KEY_EFFECTS`, `RUNTIME_ENV_OVERRIDES`, `RUNTIME_DEFAULTS`, `MS_PER_DAY` — the load the binary actually runs on (#90) |
| `config/config-cli.ts` | `runConfigCommand`, `ConfigCommandDeps`, `CONFIG_EXIT_OK/FAIL` — `kubic config [--json]` (#90) |
| `config/config-doctor.ts` | `configDoctorProbe`, `buildConfigDoctorInput`, `CONFIG_DOCTOR_ID` — doctor's config check (#90) |
| `config/stances.ts` | `McpUnsupportedError`, `assertNoMcpConfig` (+ secrets in `config/secrets.ts`) |
| `doctor.ts` | `DOCTOR_EXIT_OK/FAIL/USAGE/PROVIDER` (0/1/2/6), `DoctorStatus`, `DoctorReason`, `DoctorCheck`, `DoctorReport`, `ProviderProbe`, `DepProbe`, `DoctorDeps`, `collectDoctorChecks` |
| `spans.ts` | `SPAN_NAMES`, `SpanName`, `SpanRecord`, `SpanRecorder`, `DEBUG_CLASSES`, `DebugSink`, `ToolPhase`, `DebugLog`, `HookDeps`, `HookResult`, `TranscriptSink`, `createTranscriptSink`, `makeWriteLogSink`. Live on the run path since #98 (see "Spans") |
| `ops/perf/` | `budgets.ts` (§61 ms constants + p50/p95 `evaluateBudget`), `perf-cli.ts` (`kubic perf`, `--measure` \| `--samples`), `measure.ts` (real spawn/worktree samples, #98), `run-spans.ts` (lane/tool spans on the run path, #98) |
| `ops/cost/` | `cost-cli.ts` (`kubic cost`), `per-agent-cost.ts` (rows + Σ(per-agent) task total), `cache.ts` (§62 lever 2 prefix hit-rate, live since #98) |
| `worker-manager.ts`, `dispatch.ts`, `root-agent.ts` | Pointer | Supervision state in `@kubic/worker` `lifecycle/registry.ts` (#42); dispatch in `orchestrator/manager.ts` (#40); root agent is the solo lane `@kubic/worker` `lane/solo.ts` (#11) |
| `orchestrator/` | Manager + worker-process orchestration (parallel limits, approval budgets) |
| `roles/` | Role presets and role data |
| `policy/` | Host-side policy wiring |
| `replay/` | Replay surfaces over trajectory exports |
| `limits/` | Honest-claims/skip-record guards, solo-warning + orchestrator notices |
| `run-cli.ts`, `sessions-cli.ts`, `workers-cli.ts`, `journal-cli.ts`, `models-cli.ts`, `git-cli.ts` | Headless/CLI command implementations |
| `credentials.ts` | Pointer | Request-time refs in `config/secrets.ts` (#38); model-layer store in `@kubic/worker` `pi-boundary.ts` |
| `index.ts` | Pointer | No barrel — import per-module paths |

## Contracts

### Spans and the debug channel (`spans.ts` + `ops/perf/run-spans.ts`, §29/§49.3/§50)

`spans.ts` is the §49.3 recorder (`SpanRecorder` over `SPAN_NAMES`), the
§50 debug vocabulary (`DEBUG_CLASSES`, nine classes) and the transcript
sinks. Since issue #98 it is **live on the run path**: `ops/perf/run-spans.ts`
maps what the lane and the harness actually do onto it and
`apps/kubic/src/headless-run.ts` drives it, so a real `kubic run` records
`kubic.agent.run` → `kubic.lane.accept` / `kubic.lane.drive` →
`pi.tool.execute`, with parent linkage and per-span ms.

Two destinations, both documented on the
[commands page](../cli/commands.md#where-the-spans-go):

1. **stderr, behind `kubic run --debug`** — each span close emits one
   §50-classed line through the shared `DebugSink`. Off by default, so
   stdout stays consumable and the exit contract is unchanged. The prod
   default sink is stderr inside `headless-run.ts` — the composition root
   wires nothing.
2. **the session artifact** — the same spans are serialized to
   `spans.jsonl` under the session directory (`<sessionsRoot>/<id>/`),
   one JSON object per closed span. Evidence only: nothing reads it back
   yet (aggregation is #95/#96).

A span that never settles stays open (`endMs: null`) rather than being
dropped, and a run with no spans behaves exactly as before — the wiring
is additive by construction.

### Approvals (`approvals.ts`, #48)

`CAPABILITIES` (9): `network`, `credentials`, `git-push`,
`destructive-shell`, `install`, `deploy`, `outside-write`,
`budget-overrun`, `spawn-agents`.

| Interface | Fields |
| --- | --- |
| `ApprovalPolicy` | `route: 'ask-user' \| 'deny'`, `autoApprove: Capability[]` (explicit-only, defaults empty), `sessionScoped: boolean` (default true), `maxPendingMs: number` (default 60_000), `requireJustification: boolean` (default false) |
| `ApprovalRequest` | `key: string`, `capability: Capability`, `toolName: string`, `summary: string`, `justification?: string` |
| `ApprovalVerdict` | `{ approved: true, by: string, justified?: boolean } \| { approved: false, reason: string }` |

`ApprovalStore` (`load`/`save`) has memory and file backings;
`ApprovalService` + `createApprovalAsk` serve the lane interception
point; `detectTriggers` maps tool calls to capabilities via
`TriggerContext`.

### Config (`config/`, #38)

Layered TOML config (`CONFIG_LAYERS`) parsed by `parseTomlConfig` and
round-tripped by `serializeTomlConfig`; `mergeLayered` merges
`LayerInput`s into `MergeResult`; committed-vs-secret split enforced by
`COMMITTED_CONFIG_FILES`, `GITIGNORE_REQUIRED_ENTRIES`,
`isCommittedConfigPath`, `checkGitignoreSplit`. Fail-closed stances:
`assertNoBudgetKeys` (budgets are opt-in, never smuggled via config) and
`assertNoMcpConfig` (MCP unsupported → `McpUnsupportedError`).

The ship-vs-ignore split (issue #91; §35, D34/D35) is not hand-kept twice:
`GITIGNORE_REQUIRED_ENTRIES` is derived from `@kubic/exec`
`runtime-exclude.ts` — the module `kubic run` / `kubic orchestrate`
actually ship into a user repo's local `.git/info/exclude` under a
rewritable marker block. `.kubic/` itself is never ignored, so
`config.toml` + `roles/*.md` stay committable. Pinned by `config.test.ts`
and gated repo-wide by `scripts/runtime-exclude.test.mjs`.

### Doctor (`doctor.ts`)

Exit codes: 0 ok, 1 fail, 2 usage, 6 provider. `DoctorStatus` is
`pass|warn|fail|skip`; `collectDoctorChecks` folds `DoctorDeps`
(provider + dep probes) into a `DoctorReport` of `DoctorCheck`s.

## Dep-direction neighbours

- May import: core, exec, [worker](worker.md), [agents](agents-pkg.md),
  [trajectory](trajectory.md), [eval](eval.md) — never [tui](tui.md).
- Imported by: `apps/kubic` (composition root wires host + tui).
- Consumes [worker](worker.md) `AgentResult` and
  [agents](agents-pkg.md) task/budget shapes; never reaches into tui
  implementation.

```text
core + exec + agents ──→ worker ──→ @kubic/host ──→ apps/kubic
                                     ↑   ↑
                               trajectory eval (read)
```

Back to the [docs index](../README.md).
