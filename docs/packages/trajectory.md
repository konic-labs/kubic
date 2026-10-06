# `@kubic/trajectory`

> Export fields; source:
> `packages/trajectory/CONTRACT.md` (quoted, not copied).
> Owner: issue
> [#63](https://github.com/konic-labs/kubic/issues/63).
> Source: `packages/trajectory/src` (read-only — this page quotes it, never moves it).

`@kubic/trajectory` publishes the versioned export record (issue #51):
every autonomous run may emit one JSON record sufficient for
replay/bench/SFT/RL/debug — never claiming unrun config. Stability is
`stable` (major 1): additive-only within the major; replay (#52) and
eval (#53) pinned to major 1 keep parsing — same-major records parse
with no shim, unknown fields are preserved, unknown majors are refused
with `unknown-major` (exit 3). Breaking changes mint major 2.

Quoted from `packages/trajectory/CONTRACT.md`: the §46 fields are
`schema_version`, `task`, `identity` (+`parentSessionId`, `role`),
`model` (+`escalations`: `reason`/`at`/`fromModel`/`toModel`/`thinking`),
`prompt`, `resources`, `transfer`, `actions` (+args), `observations`
(truncated), `state` (durable: `phase`, `snapshot`, `operations[]`
`{id, kind}`, `memos[]`), `provenance` (pid/generation/worktree/model),
`environment` (USED snapshot), `worktree` (+baseRevision), `diff`,
`approvals` (+`requested` redacted summary, `justification`),
`timestamps`, `usage` (+cost), `result` (+`tests`, `artifacts` refs),
`eval` (slot). The 1.1 additions are optional on read (1.0 records still
parse) and always written by the exporter: absent parent → `null`, absent
role → `task.role`, absent leaves/memos/evidence → `[]`, absent approval
details → `null`.
Fail-closed, never silent drop: missing/incomplete provenance →
`missing-provenance`/`invalid-provenance` (exit 2); `pid` is an explicit
`null` for process-less (faux) runs, never omitted; a missing
used-`ExecutionEnv` snapshot → `missing-environment`, anything but
`capturedFrom: 'used'` → `untrusted-environment`, and the used env keeps
every key but redacts each secret-classified value (`*_KEY`, `*_TOKEN`,
`*_SECRET`, `*_PASSWORD`, `*_CREDENTIALS`, `KUBIC_ROLE_*`) to `<redacted>`
— the shared classifier in `packages/core/src/secret-keys.ts` that the
worker spawn env uses too (#359: role grants ride in the spawn env, so it is
not secret-free); every
non-`completed` result carries a §52 `failureCategory` (else
`missing-failure-category`), while a `completed` result carrying one is
`contradictory-result`; bad `usage.byModel` rows → `invalid-usage` (a
caller that omits the rollup gets `byModel: {}`); observations over 8 KiB
truncate on a UTF-8 boundary with
`bytesOriginal` kept. Every §46 section is type-checked with its required
nested keys (`model.provider`/`model`, `result.status` in
`RESULT_STATUSES`, the `actions`/`observations`/`approvals` arrays, the
`usage` numbers): a null or mistyped section/key is `malformed` (exit 3)
naming the JSON path (`trajectory.actions must be an array`) — never a raw
`TypeError` downstream — and unknown extra keys are preserved. Consumers
read via `parseTrajectoryExport` /
`parseTrajectoryExportJSON` — no shim. The `eval` slot (`{ suite,
caseId, labels }`, null-labelled until #53 fills it) is reserved.

## Public API (`packages/trajectory/src`)

| Module | Exports |
| --- | --- |
| `schema.ts` | `TrajectoryExport` + all section interfaces, `TRAJECTORY_FIELDS`, `SCHEMA_VERSION/MAJOR/MINOR`, `TRAJECTORY_STABILITY`, `TRAJECTORY_CHANGELOG`, `TRAJECTORY_FAILURE_CODES`, `isTrajectoryFailureCode`, `RESULT_STATUSES`, `TrajectorySchemaError`, `TrajectorySchemaErrorCode`, `parseTrajectoryExport`, `parseTrajectoryExportJSON` |
| `export.ts` | `BuildTrajectoryInput`, `RawObservation`, `buildTrajectoryExport`, `MAX_OBSERVATION_BYTES`, `TrajectoryExportError`, `TrajectoryExportErrorCode` |
| `index.ts` | Re-exports the full surface above (a §64 skeleton path; live callers import `export.ts`/`schema.ts` per module) |

## Producers (issue #383)

The shipped binary writes one record per settled run at
`<sessions-root>/<id>/trajectory.json`. The file holds the session's
latest settled run, and the `trajectory` ref `kubic run` prints is its
absolute path. The producers are:

- `kubic run -p` (solo)
- each `kubic orchestrate` worker child (a `kubic run` under its worker
  session)
- each settled `kubic tui` turn

The pure assembler is `packages/host/src/trajectory/run-trajectory.ts`
(`assembleRunTrajectory`, `trajectoryResultFor`, `taskIdForPrompt`,
`writeRunTrajectory`). The composition root gathers the I/O evidence in
`apps/kubic/src/run-trajectory.ts` (`persistRunTrajectory`,
`resolveSessionTrajectory`). What each section is built from:

| Section | Source |
| --- | --- |
| `actions` / `observations` | This run's session entries, in `seq` order: assistant `toolCall` parts and their `toolResult` messages. Entries older than the run's start (a resumed session) are left out. |
| `usage` | The per-request `usage` on this run's assistant messages; `byModel` is keyed `provider/model`. |
| `diff` | This session's journal changes since the run started (`unifiedHunks`). An omitted after-side keeps its path with no hunks. |
| `approvals` | This session's audit-ledger records since the run started: `ok` becomes approved, a timeout reason becomes timed-out, anything else denied. |
| `provenance` | Session and agent ids; `pid` = the process; `generation` = `KUBIC_WORKER_GENERATION` (set by the lifecycle layer for a worker, 0 solo); `worktree` = the run's cwd; `model` = `provider/id`, or `none/none` when the run ended before a model was selected. |
| `worktree` | `git rev-parse HEAD` and the branch (null when detached); `no-vcs` outside a git checkout. |
| `environment` | `toolSpawnEnv()`: exactly the env the lane spawns tools with, so no secrets. |
| `task` / `transfer` | `taskId` is `prompt:<sha256 prefix>`, stable per prompt text, so two runs of one prompt can form a §74 pair. `grantRef` is `role:<role>` (`role:solo` without `--role`). |
| `result` | The §78 terminus mapped to a §46 status and §52 category. Lane failures go through `classifyFailure`, a guard timeout is `timeout`, and a boot failure or interrupt is `process_crashed` (an interrupt is `cancelled`). |

## Contracts

### `TrajectoryExport` (`schema.ts`, §46 — 19 sections)

| Field | Type |
| --- | --- |
| `schema_version` | `string` (`"1.1"`; `SCHEMA_MAJOR` 1, `SCHEMA_MINOR` 1) |
| `task` | `TrajectoryTask` |
| `identity` | `TrajectoryIdentity` |
| `model` | `TrajectoryModel` |
| `prompt` | `TrajectoryPrompt` |
| `resources` | `TrajectoryResources` |
| `transfer` | `TrajectoryTransfer \| null` |
| `actions` | `TrajectoryAction[]` |
| `observations` | `TrajectoryObservation[]` |
| `state` | `TrajectoryDurableState` |
| `provenance` | `TrajectoryProvenance` |
| `environment` | `TrajectoryEnvironment` |
| `worktree` | `TrajectoryWorktree` |
| `diff` | `TrajectoryDiff` |
| `approvals` | `TrajectoryApproval[]` |
| `timestamps` | `TrajectoryTimestamps` |
| `usage` | `TrajectoryUsage` |
| `result` | `TrajectoryResult` |
| `eval` | `TrajectoryEvalSlot` |

`TRAJECTORY_FIELDS` pins all 19 keys via
`satisfies Record<keyof TrajectoryExport, true>`. Section shapes,
field-for-field:

| Interface | Fields |
| --- | --- |
| `TrajectoryTask` | `taskId`, `objective`, `role: string` |
| `TrajectoryIdentity` | `sessionId`, `agentId`, `workerId: string \| null`, `parentSessionId?: string \| null`, `role?: string` (1.1) |
| `TrajectoryModel` | `provider`, `model`, `thinking: string \| null`, `escalations: TrajectoryEscalation[]` (`{ reason, at, fromModel?, toModel?, thinking? }` — 1.1; `toModel` required on write) |
| `TrajectoryPrompt` | `text: string`, `constraints: string[]` |
| `TrajectoryResources` | `skills: string[]`, `promptTemplates: string[]` |
| `TrajectoryTransfer` | `taskId`, `worktree`, `grantRef: string` |
| `TrajectoryAction` | `seq: number`, `tool: string`, `args: JsonValue` |
| `TrajectoryObservation` | `seq`, `actionSeq: number`, `output: string`, `truncated: boolean`, `bytesOriginal: number` |
| `TrajectoryDurableState` | `phase: string`, `snapshot: JsonValue`, `operations?: TrajectoryOperation[]` (`{ id, kind }` — 1.1), `memos?: string[]` (1.1) |
| `TrajectoryProvenance` | `sessionId`, `agentId`, `pid: number \| null`, `generation: number`, `worktree`, `model: string` |
| `TrajectoryEnvironment` | `capturedFrom: 'used'`, `cwd: string`, `env: Record<string, string>` |
| `TrajectoryWorktree` | `path`, `baseRevision: string`, `branch: string \| null` |
| `TrajectoryDiff` | `filesChanged: string[]`, `files: TrajectoryDiffFile[]` (`{ path, hunks: string[] }`) |
| `TrajectoryApproval` | `approvalId`, `capability: string`, `verdict: 'approved' \| 'denied' \| 'timed-out'`, `by: string \| null`, `requested?: string \| null`, `justification?: string \| null` (1.1) |
| `TrajectoryTimestamps` | `startedAt`, `endedAt: string`, `durationMs: number` |
| `TrajectoryUsage` | `inputTokens`, `outputTokens`, `cachedTokens`, `requests: number`, `costUsd: number`, `byModel: Record<string, TrajectoryModelUsage>` (`{ requests, input, output, costTotal }` — non-negative, else `invalid-usage`) |
| `TrajectoryResult` | `status: TrajectoryResultStatus`, `summary: string`, `failureCategory: TrajectoryFailureCode \| null`, `error: TrajectoryResultError \| null` (`{ kind, message }`), `tests?: string[]`, `artifacts?: string[]` (1.1, refs only) |
| `TrajectoryEvalSlot` | `suite: string \| null`, `caseId: string \| null`, `labels: Record<string, string>` |

`TRAJECTORY_FAILURE_CODES` snapshots the 16 §52 codes owned by
`packages/worker/src/lane/failures.ts` (pinned equal by test):
`model_failed`, `model_refused`, `provider_transient`, `provider_auth`,
`tool_failed`, `tool_invalid_args`, `tool_timeout`, `tool_unavailable`,
`process_crashed`, `process_spawn_failed`, `workspace_failed`,
`context_overflow`, `context_polluted`, `budget_exhausted`,
`approval_denied`, `approval_timed_out`.

### Build + parse (`export.ts`, `schema.ts`)

`BuildTrajectoryInput` takes `task`, `identity`, `model`, `prompt`,
`resources`, `transfer?`, `actions`, `observations: RawObservation[]`
(`{ seq, actionSeq, output }`), `state`, `provenance`, `environment`,
`worktree`, `diff`, `approvals`, `timestamps: { startedAt, endedAt }`,
`usage`, `result`, `eval?`. `MAX_OBSERVATION_BYTES` is 8 KiB.
Build failures throw `TrajectoryExportError` (exit 2) with
`TrajectoryExportErrorCode`: `missing-provenance`,
`invalid-provenance`, `missing-environment`, `untrusted-environment`,
`missing-failure-category`, `contradictory-result`,
`invalid-timestamps`, `invalid-usage`, `invalid-escalation` (1.1: an
escalation without a non-empty `toModel`). Parse failures throw
`TrajectorySchemaError` (exit 3): `unknown-major` | `malformed`.

Shape ownership (this package imports none of them — structural
snapshots pinned by the golden fixture test): Provenance/ExecutionEnv in
[@kubic/exec](exec.md) `env.ts`, `AgentResult` in
[@kubic/worker](worker.md) `result.ts`, `AgentTask`/transfer in
[@kubic/agents](agents-pkg.md) `task.ts`, FileChange diffs
in `exec` `journal-diff.ts`, ApprovalPolicy/verdicts in
[@kubic/host](host.md) `approvals.ts`, `KubicUsageRow` in `worker`
`usage.ts`, §52 codes in `worker` `lane/failures.ts`.

## Dep-direction neighbours

- May import: [@kubic/core](core.md) only — never
  exec/worker/host/agents/eval/tui.
- Read by: replay (#52) and [@kubic/eval](eval.md) (#53) via
  `parseTrajectoryExport` — no shim, no adapter.

```text
core ──→ @kubic/trajectory ──→ replay (#52), eval (#53)
(snapshots exec/worker/agents/host shapes — imports none)
```

Back to the [docs index](../README.md).
