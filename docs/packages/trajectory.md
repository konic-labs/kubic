# `@kubic/trajectory`

> Design ref: §46 export fields; source:
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
`schema_version`, `task`, `identity`, `model` (+`escalations`), `prompt`,
`resources`, `transfer`, `actions` (+args), `observations` (truncated),
`state` (durable), `provenance` (pid/generation/worktree/model),
`environment` (USED snapshot), `worktree` (+baseRevision), `diff`,
`approvals`, `timestamps`, `usage` (+cost), `result`, `eval` (slot).
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
`contradictory-result`; bad `usage.byModel` rows → `invalid-usage`;
observations over 8 KiB truncate on a UTF-8 boundary with
`bytesOriginal` kept. Consumers read via `parseTrajectoryExport` /
`parseTrajectoryExportJSON` — no shim. The `eval` slot (`{ suite,
caseId, labels }`, null-labelled until #53 fills it) is reserved.

## Public API (`packages/trajectory/src`)

| Module | Exports |
| --- | --- |
| `schema.ts` | `TrajectoryExport` + all section interfaces, `TRAJECTORY_FIELDS`, `SCHEMA_VERSION/MAJOR/MINOR`, `TRAJECTORY_STABILITY`, `TRAJECTORY_CHANGELOG`, `TRAJECTORY_FAILURE_CODES`, `isTrajectoryFailureCode`, `RESULT_STATUSES`, `TrajectorySchemaError`, `TrajectorySchemaErrorCode`, `parseTrajectoryExport`, `parseTrajectoryExportJSON` |
| `export.ts` | `BuildTrajectoryInput`, `RawObservation`, `buildTrajectoryExport`, `MAX_OBSERVATION_BYTES`, `TrajectoryExportError`, `TrajectoryExportErrorCode` |
| `index.ts` | Re-exports the full surface above |

## Contracts

### `TrajectoryExport` (`schema.ts`, §46 — 19 sections)

| Field | Type |
| --- | --- |
| `schema_version` | `string` (`"1.0"`; `SCHEMA_MAJOR` 1, `SCHEMA_MINOR` 0) |
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
| `TrajectoryIdentity` | `sessionId`, `agentId`, `workerId: string \| null` |
| `TrajectoryModel` | `provider`, `model`, `thinking: string \| null`, `escalations: TrajectoryEscalation[]` (`{ reason, at }`) |
| `TrajectoryPrompt` | `text: string`, `constraints: string[]` |
| `TrajectoryResources` | `skills: string[]`, `promptTemplates: string[]` |
| `TrajectoryTransfer` | `taskId`, `worktree`, `grantRef: string` |
| `TrajectoryAction` | `seq: number`, `tool: string`, `args: JsonValue` |
| `TrajectoryObservation` | `seq`, `actionSeq: number`, `output: string`, `truncated: boolean`, `bytesOriginal: number` |
| `TrajectoryDurableState` | `phase: string`, `snapshot: JsonValue` |
| `TrajectoryProvenance` | `sessionId`, `agentId`, `pid: number \| null`, `generation: number`, `worktree`, `model: string` |
| `TrajectoryEnvironment` | `capturedFrom: 'used'`, `cwd: string`, `env: Record<string, string>` |
| `TrajectoryWorktree` | `path`, `baseRevision: string`, `branch: string \| null` |
| `TrajectoryDiff` | `filesChanged: string[]`, `files: TrajectoryDiffFile[]` (`{ path, hunks: string[] }`) |
| `TrajectoryApproval` | `approvalId`, `capability: string`, `verdict: 'approved' \| 'denied' \| 'timed-out'`, `by: string \| null` |
| `TrajectoryTimestamps` | `startedAt`, `endedAt: string`, `durationMs: number` |
| `TrajectoryUsage` | `inputTokens`, `outputTokens`, `cachedTokens`, `requests: number`, `costUsd: number`, `byModel: Record<string, TrajectoryModelUsage>` (`{ requests, input, output, costTotal }` — non-negative, else `invalid-usage`) |
| `TrajectoryResult` | `status: TrajectoryResultStatus`, `summary: string`, `failureCategory: TrajectoryFailureCode \| null`, `error: TrajectoryResultError \| null` (`{ kind, message }`) |
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
`invalid-timestamps`, `invalid-usage`. Parse failures throw
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
