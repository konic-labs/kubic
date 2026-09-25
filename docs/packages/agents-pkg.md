# `@kubic/agents`

> Design ref: agent definitions over the Pi harness.
> Owner: issue
> [#63](https://github.com/konic-labs/kubic/issues/63).
> Source: `packages/agents/src` (read-only — this page quotes it, never moves it).
>
> File name note: this page lives at `agents-pkg.md` (not `agents.md`)
> because the harness reserves the `agents.md` filename; it is still the
> canonical page for `packages/agents`.

`@kubic/agents` owns the spawn contract: the task and the capability
grant travel together — there is no way to hand an agent work without
also deciding what it may touch (issue #6; §67). Kubic ships with no
budgets by default: `createBudget` never injects limits (issue #9; §71).

## Public API (`packages/agents/src`)

| Module | Exports |
| --- | --- |
| `task.ts` | `AgentTask`, `AGENT_TASK_FIELDS`, `AgentRole`, `ModelSelection`, `ScopedModel`, `TaskResources`, `TaskArtifactRef`, `WorkspaceMode`, `WORKSPACE_MODES`, `TaskValidation`, `validateAgentTask` |
| `budget.ts` | `AgentBudget`, `RetryBudget`, `createBudget`, `BudgetLimit`, `BUDGET_LIMITS`, `BUDGET_OWNERSHIP`, `BudgetEnforcer`, `BudgetTermination`, `terminateForBudget`, `ReplayPin`, `REPLAY_PIN_FIELDS`, `REPLAY_PIN_DIMS`, `diffReplayPin`, `RunMode`, `BlockedSpawnOutcome`, `resolveBlockedSpawn` |
| `transfer.ts` | `TaskTransfer`, `TransferValidation`, `TransferError`, `TransferLogRecord`, `validateTransferSpawn`, `grantRefFor`, `buildTransferLog`, `isBudgetConfigured`, `serializeTransfer` |
| `spec.ts` | `SubagentSpec`, `SUBAGENT_SPEC_FIELDS`, `SpecValidation`, `validateSubagentSpec`, `SessionKey`, `specKeyOf`, `GenerationState`, `createGenerationState`, `allocateGeneration`, `GenerationCheck`, `validateGenerationSend`, `SpawnRequest`, `SpawnHandle`, `SpawnOutcome`, `spawnAgent`, `SessionSnapshot`, `SessionConfig`, `forkSessionConfig`, `ChildSession`, `openChildSession`, `WorkerProvenance`, `provenanceFor`, `SubagentResult`, `SubagentResultStatus`, `SUBAGENT_RESULT_STATUSES`, `buildSubagentResult`, `validateSubagentResult` |
| `policy.ts` | `PermissionClasses`, `FilesystemLevel`, `FILESYSTEM_LEVELS`, `ShellLevel`, `SHELL_LEVELS`, `NetworkLevel`, `NETWORK_LEVELS`, `GitLevel`, `GIT_LEVELS`, `CredentialLevel`, `CREDENTIAL_LEVELS`, `SOLO_DEFAULTS`, `toolsForClasses`, `AgreementCheck`, `checkAgreement`, `checkGrantable`, `validateClasses`, `PolicyValidationError` |
| `graph.ts` | `EdgeKind`, `EDGE_KINDS`, `AgentEdge`, `EDGE_FIELDS`, `GraphError`, `GraphStore`, `createGraph`, `addNode`, `addEdge`, `consumers`, `producers`, `topoOrder`, `subgraph`, `renderDag`, `CostRollup`, `rollupCost`, `serializeGraph`, `attachGraph`, `estimateEdgeTokens` |
| `artifacts.ts` | `ArtifactTest`, `TaskArtifact`, `ARTIFACT_FIELDS`, `ArtifactValidation`, `validateArtifact`, `sanitizeArtifact`, `SPAWN_DENY_FIELDS`, `SpawnIsolation`, `checkSpawnIsolation`, `ChildPromptInput`, `buildChildPrompt`, `assertPromptCarriesNoTranscript`, `ArtifactTranscriptEntry`, `renderArtifactTranscript`, `toTranscriptEntry`, `ArtifactTrajectoryRecord`, `toTrajectoryRecord`, `DebuggerHandoffInput`, `DebuggerHandoff`, `DebuggerHandoffBuild`, `buildDebuggerHandoff`, `freshDebuggerPrompt`, `estimateHandoffTokens`, `TOKEN_ECONOMICS_NOTE`, `containsCredential`, `redactArtifactText` |
| `skills/skills.ts`, `skills/templates.ts` | Skill + prompt-template registries |
| `memory.ts` | Agent memory surface |
| `roles.ts` | Pointer | Role presets live in `@kubic/host` `roles/roles-data.ts` over `.kubic/roles/*.md` (#44, closed) |
| `lifecycle.ts` | Pointer | Lifecycle owner is `@kubic/worker` `lifecycle/` (#42) |
| `index.ts` | Pointer | No barrel — import per-module paths |

## Contracts

### `AgentTask` (`task.ts`, §67)

| Field | Type | Required |
| --- | --- | --- |
| `taskId` | `string` (non-empty) | yes |
| `parentSessionId` | `string` (non-empty) | yes |
| `role` | `AgentRole` (`string`; closed union lands with #44) | yes |
| `objective` | `string` (non-empty) | yes |
| `worktree` | `string` (absolute path) | yes |
| `constraints` | `string[]` | no |
| `relevantFiles` | `string[]` | no |
| `previousFindings` | `string` | no |
| `expectedOutput` | `string` | no |
| `model` | `ModelSelection` | no |
| `scopedModels` | `ScopedModel[]` | no |
| `workspaceMode` | `'shared' \| 'worktree' \| 'copy'` | yes |
| `toolNames` | `string[]` (non-empty) | yes |
| `budget` | `AgentBudget` (key must be present; `{}` = no limits) | yes |
| `resources` | `TaskResources` | no |
| `artifacts` | `TaskArtifactRef[]` | no |

`AGENT_TASK_FIELDS` pins all 16 keys via
`satisfies Record<keyof AgentTask, true>`. Supporting shapes:

| Interface | Fields |
| --- | --- |
| `ModelSelection` | `provider: string`, `model: string`, `thinking?: string` |
| `ScopedModel` | `scope: string`, `provider: string`, `model: string` |
| `TaskResources` | `skills?: string[]`, `promptTemplates?: string[]` |
| `TaskArtifactRef` | `artifactId: string` |

### `AgentBudget` (`budget.ts`, §71–§72)

| Field | Type |
| --- | --- |
| `maxTokens` | `number` (optional) |
| `maxCostUsd` | `number` (optional) |
| `maxRuntimeMs` | `number` (optional) |
| `maxToolCalls` | `number` (optional) |
| `retryBudget` | `RetryBudget` (optional; `{ maxAttempts: number, maxCostUsd: number }`) |

`BUDGET_LIMITS` is `['tokens', 'cost', 'wallClock', 'toolCalls',
'retries']`, owned per `BUDGET_OWNERSHIP` (tokens → harness context
accounting; cost → host usage roll-up; wallClock → host watchdog;
toolCalls → `before_tool` per-call gate; retries → separate retry
budget). Exhaustion is `BudgetTermination` (`status:
'budget_exhausted'`, `limit: BudgetLimit`) — a distinct termination,
never a generic failure. `ReplayPin` has **8 fields** (`task`, `model`,
`thinking`, `toolSet`, `worktree`, `baseRevision`, `systemPrompt`,
`resources`), pinned closed-world by `REPLAY_PIN_FIELDS`
(`satisfies Record<keyof ReplayPin, true>`). `diffReplayPin` reports on
**6** comparability *dimensions* — `REPLAY_PIN_DIMS` is `task`,
`model+thinking` (the two fields are only meaningful together),
`toolSet`, `worktree`, `baseRevision`, `prompt+resources` — so a pin
diff names the dim that changed, not all eight raw fields.

### `TaskTransfer` (`transfer.ts`, §24)

`TaskTransfer` is `AgentTask` — no second schema, only spawn-time
enforcement: `validateTransferSpawn` rejects `transcript` carriage
(§24), defaults a missing budget key to `{}` (§71 opt-in), requires
worktree + grant (`workspaceMode` + non-empty `toolNames`) to arrive
together, then seals the transfer to the closed `AGENT_TASK_FIELDS`
list so only task + worktree + grant ever travel to the child.

### `SubagentSpec` (`spec.ts`, §6.2)

| Field | Type |
| --- | --- |
| `sessionId` | `string` |
| `parentSessionId` | `string` |
| `role` | `AgentRole` |
| `model` | `ModelSelection` |
| `systemPrompt` | `string` (optional) |
| `resources` | `TaskResources` (optional) |
| `toolNames` | `string[]` |
| `budget` | `AgentBudget` (optional) |
| `worktreePath` | `string` |
| `generation` | `number` |

`SUBAGENT_SPEC_FIELDS` pins all 10 keys. Related: `SpawnRequest`
(`task`, `sessionId`, `systemPrompt?`, `scopedModels`, `isGitWorktree`)
→ `spawnAgent` → `SpawnOutcome` (`ok: true` with `spec` +
`SpawnHandle{sessionId, generation, worktreePath}`, or `ok: false`
`SPAWN_FAILED`); `GenerationState` (`lastBySession`) with first-spawn-1
monotonic allocation; `SessionSnapshot`/`SessionConfig`
(`forkSessionConfig` deep-copies resources + nested `retryBudget`);
`ChildSession` (own empty transcript); `WorkerProvenance`
(`sessionId`, `generation`, `parentSessionId`); `SubagentResult`
(`status: 'completed' \| 'failed'`, `summary`, `provenance`, `error?` —
never a transcript, §69).

## Dep-direction neighbours

- May import: [@kubic/core](core.md), [@kubic/exec](exec.md) only — never
  host/worker/tui/trajectory/eval.
- Imported by: [@kubic/worker](worker.md), [@kubic/host](host.md),
  [@kubic/extensions](extensions.md) (budget bundle delegates to
  `createBudget` read-only).
- Never imported by [@kubic/trajectory](trajectory.md): trajectory imports
  nothing from any package (dep-lint FORBIDDEN) — it holds only string
  stump fields (e.g. `workerId`) and structural snapshots pinned by the
  golden fixture test, never a live import.

```text
core ──→ agents ←── exec
           ↑   ↑
        worker host …
```

Back to the [docs index](../README.md).
