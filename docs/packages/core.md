# `@kubic/core`

> EPIC A scaffold: the shared contracts every package builds on.
> Owner: issue
> [#63](https://github.com/konic-labs/kubic/issues/63).
> Source: `packages/core/src` (read-only — this page quotes it, never moves it).

`@kubic/core` is the bottom of the dependency tree: shared presentation
contracts and license constants with zero implementation imports. It
imports nothing internal — `scripts/dep-lint.mjs` rejects any
`core → exec/worker/host/agents/trajectory/eval/tui` edge structurally.

## Public API (`packages/core/src`)

| Module | Status | Exports |
| --- | --- | --- |
| `presentation.ts` | Implemented | `KubicPresentationState` + sub-interfaces (session/agent/budget/lane/tool/worker/approval/usage/connection), `PRESENTATION_STATE_FIELDS`, `PRESENTATION_COMMANDS`, `isPresentationCommand` |
| `license.ts` | Implemented | `KUBIC_LICENSE`, `KUBIC_LICENSE_FILE`, `formatVersionLine`, `formatLicenseDetail` |
| `protocol.ts` | Pointer | Owner module open — reserves the contract location (no wire protocol yet) |
| `secret-keys.ts` | Implemented | `isSecretEnvKey`, `redactSecretEnv`, `REDACTED_ENV_VALUE` — the one secret env-key classifier shared by the worker spawn env and the trajectory exporter (#359) |
| `secret-shapes.ts` | Implemented | `containsSecretShape`, `findSecretShapes`, `redactSecretShapes`, `REDACTED_SECRET` — the shared secret-shape table (sk-/AKIA/ghp_/xox-/PEM/bearer) composed by the host audit backstop and the worker's `redactSecrets` (#57, #192) |
| `policy.ts` | Pointer | Permission-policy model lives in `@kubic/agents` `policy.ts` (#15) |
| `session.ts` | Pointer | Session shapes live in `@kubic/worker` `lane/session-store.ts` (#14) |
| `index.ts` | Pointer | No barrel — import `presentation.js` / `license.js` directly |

## Contracts

### `KubicPresentationState` (`presentation.ts`)

The event/presentation contract (issue #5; §66, §3.1). Pure types: every
field is a replicated value or a keyed service instance — no field
requires the presentation to hold authority, and commands are narrow and
typed. Deliberately absent: no `eval`-style command channel, no raw
event stream, no path from the presentation to the harness or worker
manager.

| Field | Type |
| --- | --- |
| `session` | `SessionSnapshot` |
| `agents` | `ReadonlyMap<string, AgentSummary>` |
| `lanes` | `ReadonlyMap<string, LaneSnapshot>` |
| `workers` | `ReadonlyMap<string, WorkerSummary>` |
| `approvals` | `readonly ApprovalRequest[]` |
| `usage` | `UsageTotals` |
| `connection` | `ConnectionState` |

`PRESENTATION_STATE_FIELDS` pins exactly those seven keys via
`satisfies Record<keyof KubicPresentationState, true>` — adding or
removing a field breaks compilation, and the projector re-checks the same
list at runtime before every hand-out.

Sub-interfaces, field-for-field (issue #333 fleshed out the stubs):

| Interface | Fields |
| --- | --- |
| `SessionSnapshot` | `sessionId: string`, `model?: string`, `thinking?: string`, `mode: 'solo' \| 'orchestrator'`, `approvalsSkipped: boolean`, `runPhases?: RunPhaseState[]` (issue #464: the orchestrator run's timeline, in run order) |
| `RunPhaseState` | `phase: 'plan' \| 'implement' \| 'review' \| 'merge' \| 'verify'` (`RUN_PHASES`), `state: 'running' \| 'done' \| 'failed' \| 'skipped'`, `at` |
| `AgentSummary` | `agentId`, `role`, `status`, `workspace?`, `budget?: BudgetSummary` |
| `BudgetSummary` | `inputTokens`, `outputTokens`, `costUsd`, `limitUsd?` |
| `LaneSnapshot` | `laneId`, `agentId`, `status: 'idle'\|'running'\|'done'`, `tools: LaneToolSnapshot[]`, `queued: string[]`, `compacting: boolean`, `fault?`, `retrying?` |
| `LaneToolSnapshot` | `toolCallId`, `toolName`, `status: 'running'\|'done'`, `isError`, `args?`, `entry?`, `durationMs?` |
| `WorkerSummary` | `workerId`, `role?`, `status?`, `workspace?`, `budget?`, `generation?`, `model?`, `inputTokens?`, `outputTokens?`, `costUsd?` (issue #342: the orchestrator view's per-agent facts); `task?`, `activity?`, `toolCount?`, `recentTools?` (the last eight calls), `diffStat?`, `awaiting?: { approvalKey, summary }` (issue #464: the dashboard's facts) |
| `WorkerToolActivity` | `id`, `tool`, `target?`, `state: 'running' \| 'done' \| 'error'`, `outcome?`, `diff?: { text, firstChangedLine? }`, `at` — a redacted summary, never the raw arguments; the projector keeps at most 20 KB of diff text |
| `WorkerDiffStat` | `files`, `added`, `removed` |
| `ApprovalRequest` | `requestId`, `toolName?`, `capability?`, `detail?` |
| `UsageTotals` | `inputTokens`, `outputTokens`, `costUsd`, `requests?`, `cacheReadTokens?`, `cacheWriteTokens?` |
| `ConnectionState` | `status: 'connected' \| 'disconnected' \| 'reconnecting'`, `detail?` |

The state is produced by the host-side projector
(`packages/host/src/presentation/projector.ts`), which folds the lane event
stream (#398's `subscribeLaneEvents`) plus the worker and approval facts the
host feeds it into the state; `apps/kubic/src/tui-run.ts` feeds the TUI from
it, and `packages/tui/src/tui-app.ts` renders it (`applyPresentation`) — the
presentation never folds raw events itself (§15.2, §66). The projector also
exposes `revision()`, its monotonic fold counter (0 at the seed, +1 per
applied fact): a consumer can tell a fresh state from the one it last
rendered without diffing. It is deliberately NOT a state field.

### `PRESENTATION_COMMANDS` (`presentation.ts`)

The closed command vocabulary (`isPresentationCommand` narrows `string`
into it):

`agent.spawn`, `agent.send`, `agent.cancel`, `approval.respond`,
`session.attach`, `session.detach`, `session.fork`, `session.navigate`,
`lane.prompt`, `lane.steer`, `lane.followUp`, `lane.abort`,
`lane.compact`, `lane.resume`, `model.select`, `thinking.cycle`,
`worker.inspect`, `worker.terminate`.

### Task / result / handoff / budget live elsewhere

The shared agent contracts are owned by their packages, not by core:

- `AgentTask`, `AgentBudget` — [@kubic/agents](agents-pkg.md)
- `AgentResult` — [@kubic/worker](worker.md)
- `Handoff` — [@kubic/host](host.md)

## Dep-direction neighbours

- May import: nothing internal (external deps only).
- Imported by: every package may import core ([tui](tui.md) takes its
  contracts from core only).

```text
@kubic/core            ← imported by all; imports nothing internal
```

Back to the [docs index](../README.md).
