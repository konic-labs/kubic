# `@kubic/core`

> Design ref: EPIC A scaffold; contracts from design §3.1.
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
| `presentation.ts` | Implemented | `KubicPresentationState` + sub-interfaces, `PRESENTATION_STATE_FIELDS`, `PRESENTATION_COMMANDS`, `isPresentationCommand` |
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

`PRESENTATION_STATE_FIELDS` pins the same seven keys (`session`,
`agents`, `lanes`, `workers`, `approvals`, `usage`, `connection`) via
`satisfies Record<keyof KubicPresentationState, true>` — adding or
removing a field breaks compilation.

Sub-interfaces, field-for-field:

| Interface | Fields |
| --- | --- |
| `SessionSnapshot` | `sessionId: string` |
| `AgentSummary` | `agentId: string`, `role: string`, `status: string` |
| `LaneSnapshot` | `laneId: string` |
| `WorkerSummary` | `workerId: string` |
| `ApprovalRequest` | `requestId: string` |
| `UsageTotals` | `inputTokens: number`, `outputTokens: number`, `costUsd: number` |
| `ConnectionState` | `status: 'connected' \| 'disconnected' \| 'reconnecting'` |

Snapshot/summary shapes are stubs refined by their owners: session and
connection in #14, agents in #41, lanes in #11, workers in #42,
approvals in #16, usage in #20.

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
