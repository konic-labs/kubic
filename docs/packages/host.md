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
| `handoff.ts` | `Handoff`, `HANDOFF_FIELDS`, `WriteScope`, `HandoffValidation`, `validateHandoff` |
| `approvals.ts` | `CAPABILITIES`, `Capability`, `ApprovalPolicy`, `PolicyValidationError`, `validatePolicy`, `ApprovalRequest`, `ApprovalVerdict`, `ApprovalStore`, `MemoryApprovalStore`, `FileApprovalStore`, `TriggerContext`, `detectTriggers`, `approvalKey`, `summarizeRequest`, `AccessPosture`, `ApprovalAsk`, `createApprovalAsk`, `enableFullAccess`, `ApprovalServiceOptions`, `ApprovalService` |
| `config/config.ts` | `CONFIG_LAYERS`, `ConfigLayer`, `ConfigError`, `ProjectUntrustedError`, `BudgetKeyError`, `AgentConfig`, `ModelConfig`, `ModesConfig`, `ApprovalsConfig`, `JournalConfig`, `RoleConfig`, `OrchestratorConfig`, `UiConfig`, `SessionConfig`, `KubicConfig`, `EXAMPLE_TOML`, `assertNoBudgetKeys`, `parseTomlConfig`, `serializeTomlConfig`, `LayerInput`, `MergeResult`, `mergeLayered`, `defaultLayerPaths`, `COMMITTED_CONFIG_FILES`, `GITIGNORE_REQUIRED_ENTRIES`, `isCommittedConfigPath`, `checkGitignoreSplit`, `loadLayered` |
| `config/stances.ts` | `McpUnsupportedError`, `assertNoMcpConfig` (+ secrets in `config/secrets.ts`) |
| `doctor.ts` | `DOCTOR_EXIT_OK/FAIL/USAGE/PROVIDER` (0/1/2/6), `DoctorStatus`, `DoctorReason`, `DoctorCheck`, `DoctorReport`, `ProviderProbe`, `DepProbe`, `DoctorDeps`, `collectDoctorChecks` |
| `spans.ts` | `SPAN_NAMES`, `SpanName`, `SpanRecord`, `SpanRecorder`, `DEBUG_CLASSES`, `DebugSink`, `ToolPhase`, `DebugLog`, `HookDeps`, `HookResult`, `TranscriptSink`, `createTranscriptSink`, `makeWriteLogSink` |
| `worker-manager.ts`, `dispatch.ts`, `root-agent.ts` | Pointer | Supervision state in `@kubic/worker` `lifecycle/registry.ts` (#42); dispatch in `orchestrator/manager.ts` (#40); root agent is the solo lane `@kubic/worker` `lane/solo.ts` (#11) |
| `orchestrator/` | Manager + worker-process orchestration (parallel limits, approval budgets) |
| `roles/` | Role presets and role data |
| `policy/` | Host-side policy wiring |
| `replay/` | Replay surfaces over trajectory exports |
| `ops/`, `limits/` | Perf budgets, honest-claims/skip-record guards, solo-warning + orchestrator notices |
| `run-cli.ts`, `sessions-cli.ts`, `workers-cli.ts`, `journal-cli.ts`, `models-cli.ts`, `git-cli.ts` | Headless/CLI command implementations |
| `credentials.ts` | Pointer | Request-time refs in `config/secrets.ts` (#38); model-layer store in `@kubic/worker` `pi-boundary.ts` |
| `index.ts` | Pointer | No barrel — import per-module paths |

## Contracts

### `Handoff` (`handoff.ts`, §69–§70)

A handoff carries the structured result, artifact REFERENCES (never
contents), a diff reference, the worktree, and the constraint list —
never a transcript, keeping a five-agent chain affordable (§69). Review
loop (§70): planner → implementer → tester → reviewer → root; failures
route to the debugger (tester failures NEVER re-plan); a `maxAttempts`
bound per chain precedes escalation; the reviewer is read-only
(`writeScope: 'none'`).

| Field | Type | Required |
| --- | --- | --- |
| `result` | `AgentResult` ([worker](worker.md)) | yes |
| `artifactIds` | `string[]` | yes |
| `diffId` | `string` | no |
| `worktree` | `string` (absolute path) | yes |
| `constraints` | `string[]` | yes |
| `writeScope` | `'none' \| 'worktree'` | yes |

`HANDOFF_FIELDS` pins all 6 keys via
`satisfies Record<keyof Handoff, true>`; `validateHandoff` additionally
refuses any `transcript` key (§69).

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
