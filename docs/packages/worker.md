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
| `lane/solo.ts` | `SOLO_LANE_NAME` (`'main'`), `SOLO_ROLE`, `assembleSoloPrompt`, `SoloPromptInput`, `defaultSoloModelId`, `defaultSoloPrompt`, `SoloPolicyOptions`, `SOLO_KEEP_RECENT_TOKENS`, `SoloCompactionOptions`, `SoloBootOptions` (`modelPolicy`/`onModelNotice`: a resumed lane keeps its stored model unless the selection is an explicit pin, which switches it; an unregistered stored model fails closed with `ModelSelectError` — #148), `SoloLane` (`model`: the model the lane actually runs), `splitSoloModelId`, `escalateSoloModel`, `SoloCompactionCheck`, `SoloCompactionDecision`, `maybeCompactSoloLane`, `LaneDriver`, `DriveLoopOptions`, `RoutableOutcome`, `SettledDrive`, `LaneDriveError` |
| `lane/events.ts` | `KubicLaneEvent`, `LaneEventSink`, `EventSource`, `toKubicLaneEvent`, `attachLaneEvents`, `watchLane` |
| `lane/failures.ts` | `FailureCode`, `FAILURE_CODES`, `RetryStrategy`, `RETRY_STRATEGIES`, `RetryDecisionKind`, `ClassifiedFailure`, `classifyFailure`, `RetryHints`, `RetryDecision`, `RetryBudget`, `chooseRetry` |
| `lane/tools-adapter.ts` | `KubicToolContext`, `kubicToolsToPiTools` (registry schemas + json_schema/`prefer` constrained sampling — #168), `renderToolText`, `renderReadText`, `renderGrepText`, `renderBashText` (plain-text results with a header; [tools](../cli/tools.md)) |
| `lane/interceptors.ts` | `PolicyTrigger`, `PolicyInterceptorOptions`, `ApprovalCall`, `ApprovalAskVerdict`, `defaultIsDestructive`, `isNetworkCommand`, `confinePath`, `redactReason`, `registerPolicyInterceptors` |
| `lane/policy.ts` | `PermissionClasses` (re-export), `PolicyRefusedError` |
| `lane/session-store.ts` | `SessionStore`, `openSessionStore`, `createSession`, `attachSession`, `SessionAttachError`, `SessionLockError`, `acquireSessionLock`, `releaseSessionLock`, `sessionLockIsLive`, `sessionsTouchingWorkspace`, `listSessions` |
| `lane/session-fs.ts` | `bridgeToPiFileSystem` |
| `lane/settle.ts` | `OperationErrorLike`, `SettledResult`, `classifyHarnessError`, `settleTerminalStatus` |
| `lane/pending.ts` | `PendingPolicy`, `PendingSettlement`, `PendingLane`, `PendingDriver`, `settlePendingOperation`, `pendingHead`, `describePendingOperation`, `describeSettlement`, `inspectOpenOperations`, `lastUserPromptText` — settle a turn a crashed process left open (#147: resume or durable abort) |
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
| `approval-client.ts`, `session.ts`, `tools.ts` | Pointer | Approvals decider in `@kubic/host` `approvals.ts` (#16) + `lane/interceptors.ts`; sessions in `lane/session-store.ts` (#14); tools in `lane/tools-adapter.ts` (#11) |
| `ops/` | Implemented | Operation implementations (read/write/edit/bash/git/…) + registry |

### Output bounds (issue #121)

Child output is capped at two independent layers, both keeping the **tail**
(endings usually carry the error) and naming exactly what was dropped:

- **Seam (memory):** `NodeShell` accumulates at most `MAX_CHILD_OUTPUT_BYTES`
  (10 MiB) per stream — `env.ts`, overridable per spawn via
  `SpawnOptions.maxOutputBytes` so the orchestrator can size worker-child
  capture independently. A chatty child (`yes`, a verbose build) can no
  longer OOM the run; the settled stream gains a
  `[kubic: output truncated — dropped N leading bytes, kept the last M]`
  header.
- **Op (context window):** `bash` clips each stream to
  `BASH_RESULT_MAX_CHARS` (64 K chars) in the result the model sees, with a
  `[kubic: N leading chars dropped]` header and `truncated: true` on
  `BashResult` — the model knows it saw a slice. The registry's
  never-replay memoization stores the clipped result, so retries are
  consistent.
| `index.ts` | Pointer | No barrel — import per-module paths |

### Bash op: bash-preferred, sh fallback (issue #123)

The `bash` op runs **bash when the system has it** — not `sh`, so
bashisms (`[[ ]]`, `local`, arrays) work wherever bash exists. Resolution
is lazy and cached per process: the first command attempts `bash`, and a
spawn that settles exit 127 with Node's `spawn <name> ENOENT` message
line (the `env.ts` ENOENT hardening from issue #85 is what puts that
message in stderr — user output never matches) degrades once to `sh` and
remembers — a single detect-and-retry inside
`execute()`, before the registry memoizes under `op-result-bash`, so a
retried command memoizes exactly once. Detection and execution both go
through `ctx.env.shell` — no `child_process` in ops, `FakeExecutionEnv`
scripts the answer. The Windows `cmd /d /s /c` path is unchanged.

`BashResult.shell: 'bash' | 'sh' | 'cmd'` names what actually ran. The
retry handle is re-registered via `ctx.trackHandle` so
timeout/abort kill whichever handle is live. The test seam
`__setResolvedShellForTests` (exported from `ops/bash.ts`, never
re-exported) pins or resets the per-process resolution.

### Read/edit bounds (issue #122)

Two hard bounds keep one tool call from costing the whole file in memory
(the journal has hashed bounded since #107; the ops now match):

- **`read` — `READ_MAX_BYTES` (8 MiB) of I/O, `READ_CHUNK_BYTES` (512 KiB)
  per buffer:** with a ranged-read seam (`FileSystem.readFileRange` — #107's
  file-bridge seam extended to `ExecutionEnv`), `readWindowed` seeks to the
  `offset` line by counting newlines chunk by chunk and collects the window
  with one `StringDecoder` across chunks — the window costs the window, not
  the file. Seams without `readFileRange` fall back to a whole read
  (correct but unbounded) and the result shape never changes. The result's
  honesty contract: `truncated: false` guarantees `totalLines` is exact
  AND `content` is complete for the requested region. `truncated: true`
  whenever the scan stopped before EOF — byte budget, line cap, or
  limit-stopped region collection — and `totalLines` is then only a lower
  bound ("lines confirmed so far"): a line that starts within the scanned
  bytes but extends beyond the stop still counts (a 9 MiB single line cut
  off by the budget reports `totalLines: 1`), while a line that never
  started does not. That is distinct from an offset whose line lies beyond
  the budget — the empty-region case, which returns empty content with
  `truncated: true`. When the scan did reach EOF, `truncated` reflects
  only output cutting (the line window, `READ_MAX_LINES`, and the 51200B
  output cap) — an explicit `limit` is the requested region, not
  truncation. `readWindowed` calls
  `fs.readFileRange` as a method (the real `NodeFileSystem` reads
  `this.cwd`; #199), and `read` names the actual failure: a missing path
  is `not_found`, a directory `is_directory`, an unreadable file
  `permission_denied`, a cwd-confinement escape `invalid_args`; any other
  error propagates as a fault instead of masquerading as a missing file.
- **`edit` — `EDIT_MAX_BYTES` (8 MiB):** `stat` first and refuse above the
  bound with a named `file_too_large` OpError (op failure-code vocabulary,
  `ops/types.ts`) naming the size — before any content allocation, journal
  untouched. The boundary is exact: 8 MiB edits fine, 8 MiB + 1 refuses.
- **`read` output bounds (issue #176; §27.5):** the scan bound above is
  not a context bound. `READ_RESULT_MAX_BYTES` (51200B — Pi's
  `DEFAULT_MAX_BYTES`) caps what the model sees, whole lines only: a window
  past the cap keeps the lines that fit and adds
  `output clipped at 51200B` (the last kept line still drives
  `more: offset=`); a line that alone exceeds the cap is left out whole —
  a partial line could poison an exact-match `edit` — with a
  `line K is NB …` notice carrying a shell-quoted `sed -n 'Kp' < … | head
  -c 51200` continuation (the path goes through stdin, never an operand:
  GNU sed would read a leading-dash name as `-e`/`-f`/`-w` options) and
  `more: offset=K+1` when further lines exist. An
  offset past the last line, known exactly only when the scan reached EOF,
  carries `offset K is past the last line (N lines total)`; when the budget
  stopped the scan instead, the offset is only past the CONFIRMED lines and
  the old `no lines at offset K (file has at least N lines)` header stays.
  The first chunk is sniffed for NUL and for invalid UTF-8 (strict decode
  with stream semantics, so a codepoint straddling the 512 KiB read
  boundary is not a false positive); binary content returns an empty
  `content`, a structured `binary: { reason, bytes }`, and a `binary file
  (NB, …)` notice — the sniff only MARKS the window, so the #122 scan
  contract is unchanged. `ReadResult` only gains fields; nothing is
  renamed.

The reason for both: `read` capped only its output and `edit` capped
nothing, so `read` with `limit: 1` or one `edit` on a multi-GB file cost the
whole file in memory (plus its UTF-8 decode) on a path the model triggers
with a single tool call. Text ops stay text; for oversized files the
refusal names targeted shell tooling as the actionable alternative.

### Session locking (issue #118)

One live attachment per session, fail-closed. `createSession` (after the
session dir exists) and `attachSession` (before the transcript is read)
acquire `<sessions-root>/<session-id>/lock.json` — a `{pid, startedAt}`
record of the attaching process — through the exec-owned lock-file
primitive (`exec/lock-file.ts`; I/O confinement, §9): an O_EXCL
(`writeFileSync(…, {flag: 'wx'})`) create is the atomic test-and-set, and
the primitive makes the session dir eagerly as the lock's parent.
`session.close(…)` releases the lock (best-effort remove), so the file
exists only while a session is actually attached.

- **Refusal** is `SessionLockError`; its message names the session and
  the holder's pid + start time. Host maps it to `workspace_unavailable`
  (exit 5) on `kubic run`; `kubic sessions attach` prints it and exits 1
  without reading the transcript.
- **Stale steal** (never a steal of a live lock): a holder whose process
  is gone (`process.kill(pid, 0)` fails) is stale immediately — crash
  recovery works same-day; a lock file older than a day is stale
  regardless (pid reuse); an unparseable/torn `lock.json` is a stale
  candidate. A steal that loses its re-create race surfaces as
  `SessionLockError`, never a crash.
- **Local filesystem only.** O_EXCL atomicity is claimed on local
  filesystems only — no network/shared-disk (NFS/SMB) locking semantics
  are provided or tested.
- **Read-only liveness view** (issue #119): `sessionLockIsLive(sessionDir)`
  reports `{pid, startedAt}` while the holder pid is alive — the rail
  `kubic sessions prune` reads before it would ever delete a session. It is
  deliberately stronger than the steal rule above (any live holder pid
  protects, regardless of the lock's age): deletion is unrecoverable, so a
  reused pid costs at most a skipped prune. A dead holder — or a
  torn/absent payload — never protects. Liveness is this machine's process
  table, local filesystem only, like every lock read here.
- **Repo-level overlap — warning only** (issue #118; §42.5 blind spot). A
  session lock is per session; **different** sessions on one workspace are
  legal. `sessionsTouchingWorkspace` lists the sessions recorded against a
  workspace (local-store view; it cannot prove one is *running*), and that
  probe feeds two warning surfaces: the run path emits one
  `reconcile: another run may be live in this workspace …` line on its
  debug channel, and `kubic doctor` reports `session:overlap` (warn when
  two or more sessions are recorded). The reason it warns: each run's
  end-of-run sweep compares against its own boot baseline, so a sibling
  session's in-flight changes land in this run's journal as unattributed,
  non-reversible entries. Never a block.

The lock covers the session's journal too (it lives under the session
dir) — the journal store is not locked separately.

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

### Live spawn path (issue #94: `launch.ts`, `shell.ts`, `rows.ts`)

`kubic orchestrate` starts every worker through `launchWorker`, so the
lifecycle is enforced on the path that actually spawns: the
stale-generation guard refuses before any side effect, the row is
registered before the child runs (`created → spawning → ready → running`
via `assertTransition`), the readiness marker is awaited under a timeout,
and `launched.perf()` reports the §61 sample against
`LIFECYCLE_BUDGETS_MS`
(worktree 300 / spawn 200 / attach 50 / teardown 1000 ms). The §3.8
allowlist reaches the OS through `allowlistedShell` (`env -i …`, since
the exec Shell seam carries no env field); `KUBIC_WORKER_ID` is on the
allowlist so a worker announces itself, and an ordinary `kubic run`
prints no marker. Registry rows persist to
`<repo>/.kubic/orchestrator/workers.json` (§35 keeps that out of git) and
`kubic workers` reads them back — one shared record, never a fresh empty
registry.

Failure taxonomy on that path: a worker that never becomes ready is
terminal `SPAWN_FAILED` and the run reports the §78 code `spawn_failed`
(the §52 code `process_spawn_failed`); a worker that ran and failed keeps
`worker_failed`, with its §52 code named inline (a provider-less child
exits 6 → `provider_transient`, as
[exit-codes](../cli/exit-codes.md) documents). Both map to exit 1; a
worker whose launch never becomes ready also records no `startupMs` — an
unfinished launch never claims a budget pass it did not measure.

## Dep-direction neighbours

- May import: [@kubic/core](core.md), [@kubic/exec](exec.md),
  [@kubic/agents](agents-pkg.md) (+ trajectory/eval shapes as
  snapshots where pinned) — never host/tui.
- Imported by: [@kubic/host](host.md) (runtime wiring).
- Never imported by [@kubic/trajectory](trajectory.md): trajectory imports
  nothing from any package (dep-lint FORBIDDEN) — it records only string
  stump fields plus a structural result snapshot pinned by the golden
  fixture test, never a live import.
- Pi seam: `pi-boundary.ts` only (§65).

```text
core + exec + agents ──→ @kubic/worker ──→ host
                              ↑
                    pi-boundary.ts (sole Pi choke point)
```

Back to the [docs index](../README.md).
