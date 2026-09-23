# `@kubic/worker`

> Design ref: worker runtime; Pi boundary (§65, CODEOWNERS-gated
> `src/pi-boundary.ts`).
> Owner: issue
> [#63](https://github.com/konic-labs/kubic/issues/63).
> Source: `packages/worker/src` (read-only — this page quotes it, never moves it).

`@kubic/worker` is the agent runtime: solo lane, tool adaptation, Pi
harness wiring, budgets, compaction, and the worker → host result
payload. All Pi imports flow through the single choke point
`src/pi-boundary.ts` (§65) — `scripts/dep-lint.mjs` rejects
`@earendil-works/*` imports everywhere else, and CODEOWNERS flags every
diff touching the boundary for maintainer review.

## Public API (`packages/worker/src`)

| Module | Exports |
| --- | --- |
| `result.ts` | `AgentResult`, `RESULT_FIELDS`, `ResultStatus`, `RESULT_STATUSES`, `ResultError`, `ResultErrorKind`, `ERROR_KINDS`, `TestResult`, `ArtifactRef`, `WorkspaceDiffRef`, `WorkerProvenance`, `ApprovalRecord`, `EscalationRecord`, `ResultMetrics`, `ResultValidation`, `validateAgentResult`, `JsonValue` |
| `pi-boundary.ts` | Sole Pi seam: harness types (`AgentLane`, `AgentHarnessTool`, `Context`, `DriveOutcome`, `Events`, `HarnessEvent`, `Session`, `SessionRepo`, `UsageRow`, …) + values (`AgentHarness`, `BACKGROUND_CONTEXT`, `MemorySessionRepo`, `JsonlSessionRepo`, `ok`, `err`, `FileError`); model layer (`Model`, `MutableModels`, `Usage`, `DeferredHandle`, `ModelThinkingLevel`, thinking clamp, providers, `Type`) — each re-export carries a JUSTIFICATION block naming seam, user, why-Pi, and review |
| `lane/solo.ts` | `SOLO_LANE_NAME` (`'main'`), `defaultSoloPrompt`, `SoloPolicyOptions`, `SoloBootOptions`, `SoloLane`, `LaneDriver`, `DriveLoopOptions`, `RoutableOutcome`, `SettledDrive`, `LaneDriveError` |
| `lane/events.ts` | `KubicLaneEvent`, `LaneEventSink`, `EventSource`, `toKubicLaneEvent`, `attachLaneEvents`, `watchLane` |
| `lane/failures.ts` | `FailureCode`, `FAILURE_CODES`, `RetryStrategy`, `RETRY_STRATEGIES`, `RetryDecisionKind`, `ClassifiedFailure`, `classifyFailure`, `RetryHints`, `RetryDecision`, `RetryBudget`, `chooseRetry` |
| `lane/tools-adapter.ts` | `KubicToolContext`, `kubicToolsToPiTools` |
| `lane/interceptors.ts` | `PolicyTrigger`, `PolicyInterceptorOptions`, `ApprovalCall`, `ApprovalAskVerdict`, `defaultIsDestructive`, `isNetworkCommand`, `confinePath`, `redactReason`, `registerPolicyInterceptors` |
| `lane/policy.ts` | `PermissionClasses` (re-export), `PolicyRefusedError` |
| `lane/session-store.ts` | `SessionStore`, `openSessionStore`, `createSession`, `SessionAttachError`, `listSessions` |
| `lane/session-fs.ts` | `bridgeToPiFileSystem` |
| `lane/settle.ts` | `OperationErrorLike`, `SettledResult`, `classifyHarnessError`, `settleTerminalStatus` |
| `lane/abort.ts` | `KillFn`, `OperationKillRegistry`, `LaneAborter`, `LaneAbortResult` |
| `lane/wrap.ts` | `ExecuteFn`, `ToolContribution`, `composeTools`, `compositionOrder`, `PolicyDeniedError`, `withPermissionCheck`, `TelemetryRecord`, `withTelemetry` |
| `lifecycle/registry.ts` | `WorkerRegistration`, `WorkerRow`, `WorkerRegistry` |
| `lifecycle/env.ts` | `ENV_ALLOWLIST`, `filterSpawnEnv`, `roleCredentialEnv`, `buildSpawnEnv`, `redactEnvForLog` |
| `lifecycle/reap.ts` | `RawExit`, `ExitReport`, `reportExit`, `ReapTarget`, `ReapDeps`, `DetachedReap`, `TEARDOWN_BUDGET_MS`, `reapDetached` |
| `lifecycle/budgets.ts` | `LIFECYCLE_BUDGETS_MS`, `PerfSample`, `PerfGateResult`, `checkPerfGate` |
| `usage.ts` | `KubicUsageRow`, `ModelUsageSummary`, `UsageSummary`, `summarizeUsage`, `formatCost`, `formatUsageLine` |
| `model-select.ts` | `ModelSelectError`, `ModelSelection`, `AnyModel`, `selectModel`, `parseModelFlag`, `EscalationRecord`, `EscalationLadder`, `EscalationError`, `createLadder`, `escalateModel`, `supportedThinking`, `clampThinking`, `saveThinkingLevel`, `loadThinkingLevel` |
| `models-config.ts` | `CustomApi`, `CUSTOM_APIS`, `CustomModelSpec`, `CustomProviderSpec`, `ModelsJsonError`, `THINKING_LEVELS`, `isThinkingLevel`, `parseModelsJson`, `LOCAL_MODELS_EXAMPLE`, `registerCustomProviders` |
| `prompts.ts` | `PromptCacheError`, `PROMPT_CACHE_RULES`, `SystemPromptInput`, `assembleSystemPrompt`, `sortedToolNames`, `serializeMetadata`, `appendTurnContent`, `LaneBinding`, `LaneRegistry`, `AffinityEscalation`, `TaskAffinity`, `pinModelForTask`, `taskModelForTurn`, `assertSingleModelId`, `ModelEscalationEvent`, `escalatePinnedModel`, `CompactionRoute`, `buildCompactionRoute`, `SessionCacheCounters`, `emptyCacheCounters`, `recordCacheUsage`, `cacheHitRate`, `SessionCacheStats` |
| `compaction.ts` | `CompactionThreshold`, `compactionThreshold`, `shouldCompact`, `DEFAULT_RESERVE_TOKENS`, `CompactionCheckpoint`, `COMPACTION_CHECKPOINTS`, `CheckpointContext`, `shouldCheckAt`, `parseCompactCommand`, `CompactionError`, `CompactPromptInput`, `buildCompactPrompt`, `BranchSummaryEntry`, `BranchSummaryStore`, `FileOpKind`, `FileOp`, `CumulativeFileOps`, `emptyFileOps`, `accumulateFileOps`, `StructuredSummary`, `formatStructuredSummary`, `TruncatedToolOutput`, `SpillArtifact`, `resolveTruncatedOutput`, `buildSpillArtifact`, `passThroughOutput`, `CompactedState`, `buildCompactedState` |
| `approval-client.ts`, `session.ts`, `tools.ts`, `ops/` | Approval client, session wiring, tool surface, ops helpers |
| `index.ts` | Reserved stub (`export {}`) — import per-module paths |

## Contracts

### `AgentResult` (`result.ts`, §68)

The only worker → host payload. Provenance is required on EVERY result,
including failures; results never carry transcripts (§69).

| Field | Type | Required |
| --- | --- | --- |
| `status` | `ResultStatus` (see below) | yes |
| `summary` | `string` (non-empty) | yes |
| `filesChanged` | `string[]` | yes |
| `tests` | `TestResult[]` | no |
| `findings` | `string[]` | no |
| `artifacts` | `ArtifactRef[]` | no |
| `diff` | `WorkspaceDiffRef` | no |
| `provenance` | `WorkerProvenance` | yes |
| `approvals` | `ApprovalRecord[]` | no |
| `escalations` | `EscalationRecord[]` | no |
| `metrics` | `ResultMetrics` | yes |
| `error` | `ResultError` | on `failed` |

`RESULT_FIELDS` pins all 12 keys via
`satisfies Record<keyof AgentResult, true>`. `RESULT_STATUSES` is
`['completed', 'failed', 'cancelled', 'timeout', 'budget_exhausted',
'spawn_failed']` (`'budget_exhausted'` is spelled the same as
`BudgetTermination` in [@kubic/agents](agents-pkg.md) by pinned test, each
contract owning its literal). `ERROR_KINDS` is `['model', 'provider',
'tool', 'process', 'workspace', 'context', 'budget', 'approval']`.

| Interface | Fields |
| --- | --- |
| `ResultMetrics` | `inputTokens`, `outputTokens`, `cachedTokens`, `toolCalls`, `latencyMs`, `wallMs` (finite numbers), `costUsd?: number` |
| `ResultError` | `kind: ResultErrorKind`, `message: string` (non-empty), `details?: JsonValue` |
| `TestResult` | `name: string`, `passed: boolean`, `output?: string` |
| `ArtifactRef` | `artifactId: string` |
| `WorkspaceDiffRef` | `diffId: string` |
| `WorkerProvenance` | `workerId: string` |
| `ApprovalRecord` | `approvalId: string` |
| `EscalationRecord` | `reason: string` |

Stub types refined by their owners: `TestResult`/`ArtifactRef`/
`WorkspaceDiffRef` in #52–#53, `WorkerProvenance` in #42,
`ApprovalRecord` in #48, `EscalationRecord` in #8.

### Lane events + failures (`lane/events.ts`, `lane/failures.ts`)

Exactly one consumer subscribes to the harness, only to the §15 groups
Kubic routes (run status, tool status, usage, faults). `KubicLaneEvent`
variants: `run-start` (`lane`, `runId`, `startedAt`), `run-end` (`lane`,
`runId`, `status: completed|aborted|failed`, `endedAt`, `error?`),
`tool-start`/`tool-end` (`lane`, `runId`, `turnId`, `toolCallId`,
`toolName`, + `args` / `isError` + `terminate`), `usage` (`lane`, `row`,
`totals`), `fault` (`code`, `message`).

`FAILURE_CODES` (§52, 16 codes): `model_failed`, `model_refused`,
`provider_transient`, `provider_auth`, `tool_failed`,
`tool_invalid_args`, `tool_timeout`, `tool_unavailable`,
`process_crashed`, `process_spawn_failed`, `workspace_failed`,
`context_overflow`, `context_polluted`, `budget_exhausted`,
`approval_denied`, `approval_timed_out` — pinned equal with the
[trajectory](trajectory.md) snapshot by test. `RETRY_STRATEGIES` (§53, 6):
`retry_same`, `retry_with_new_context`, `retry_with_new_agent`,
`retry_with_stronger_model`, `retry_with_different_tool`,
`retry_with_wider_capability`; decisions add `escalate`/`abandon`, and
retry spend lands on `RetryBudget`, never the task budget.

### Usage (`usage.ts`, §39)

`KubicUsageRow` is `{ model, provider, usage: Usage (Pi type),
ttftMs?, latencyMs?, toolCallId?, entryId? }`. `summarizeUsage` folds
rows into `UsageSummary` (`requests`, `input`, `output`, `cacheRead`,
`cacheWrite`, `costTotal`, plus `byModel` per model) — pure, so cost
tests use fixture rows, never network or paid tokens.

### Worker lifecycle (`lifecycle/`)

`WorkerRegistration` (`workerId`, `sessionId`, `generation`, `owner`,
`resources?`, `pid?`, `status?`); `WorkerRow` adds `startedAtMs`,
`ageMs` (+ `startupMs?`). Spawn env is allowlist-filtered
(`ENV_ALLOWLIST`, `filterSpawnEnv`, `roleCredentialEnv`,
`buildSpawnEnv`, `redactEnvForLog`); detached exits are reaped with a
1s teardown budget (`TEARDOWN_BUDGET_MS`).

## Dep-direction neighbours

- May import: [@kubic/core](core.md), [@kubic/exec](exec.md),
  [@kubic/agents](agents-pkg.md) (+ trajectory/eval shapes as
  snapshots where pinned) — never host/tui.
- Imported by: [@kubic/host](host.md) (runtime wiring),
  [@kubic/trajectory](trajectory.md) (result snapshot, pinned by test).
- Pi seam: `pi-boundary.ts` only (§65).

```text
core + exec + agents ──→ @kubic/worker ──→ host
                              ↑
                    pi-boundary.ts (sole Pi choke point)
```

Back to the [docs index](../README.md).
