# `@kubic/core`

> The shared contracts every package builds on.
> Source: `packages/core/src`.

`@kubic/core` is the bottom of the dependency tree: the presentation
contract, the CLI output kit, the terminal design tokens, the secret
classifiers and the license constants. It imports nothing internal —
`scripts/dep-lint.mjs` rejects any
`core → exec/worker/host/agents/trajectory/eval/tui` edge structurally.

## Public API (`packages/core/src`)

| Module | Exports |
| --- | --- |
| `presentation.ts` | `KubicPresentationState` and its sub-interfaces, `PRESENTATION_STATE_FIELDS`, `PRESENTATION_COMMANDS`, `isPresentationCommand` |
| `license.ts` | `KUBIC_LICENSE`, `KUBIC_LICENSE_FILE`, `formatVersionLine`, `formatLicenseDetail` |
| `secret-keys.ts` | `isSecretEnvKey`, `redactSecretEnv`, `REDACTED_ENV_VALUE` — the secret env-key classifier the trajectory exporter records the run's environment through |
| `secret-shapes.ts` | `containsSecretShape`, `findSecretShapes`, `redactSecretShapes`, `REDACTED_SECRET` — the shared secret-shape table (`sk-`, `AKIA`, `ghp_`, `xox-`, PEM, bearer) used by the lane redactor and the audit backstop |
| `secret-refs.ts` | `parseSecretRef`, `splitSecretCommand`, `SecretRef`, `SecretRefError` — the `$ENV_VAR` / `!command` secret-reference forms shared by the `models.json` parser and the request-time resolver |
| `suggest.ts` | `suggest`, `editDistance` — "did you mean …?" for mistyped commands, providers and model ids |
| `cli/exit-codes.ts` | The [exit-code table](../cli/exit-codes.md) as named constants and the `ExitCode` union, `CommandResult` (what a command handler returns), `CliUsageError`, `CliExitError`, `exitCodeForParseError` |
| `cli/logger.ts` | `createLogger`, `createLineLogger`, `debugEnabled` — leveled diagnostics, always on stderr |
| `cli/output.ts` | `formatJson`, `outputModeFor` — the `--json` rule |
| `cli/kit.ts`, `cli/table.ts`, `cli/spinner.ts`, `cli/prompt.ts`, `cli/theme.ts`, `cli/width.ts` | The CLI output kit: headings, status marks, receipts, tables, a TTY-only spinner, prompts that never run non-interactively, the CLI theme and display-width helpers |
| `ui/tokens.ts`, `ui/color.ts`, `ui/style.ts`, `ui/glyphs.ts`, `ui/theme-file.ts` | The design tokens shared by the TUI and the CLI: colour roles and palettes, colour-depth detection, the style engine, glyphs and JSON theme files |
| `index.ts` | No barrel — import per-module paths |

## Contracts

### `KubicPresentationState` (`presentation.ts`)

The event/presentation contract. Pure types: every field is a replicated
value — no field requires the presentation to hold authority, and commands
are narrow and typed. One session, one lane: the state holds the session's
facts and its single live lane, with no id-keyed collections. Deliberately
absent: no `eval`-style command channel, no raw event stream, no path from
the presentation to the harness.

| Field | Type |
| --- | --- |
| `session` | `SessionSnapshot` |
| `lane` | `LaneSnapshot` |
| `approvals` | `readonly ApprovalRequest[]` |
| `usage` | `UsageTotals` |
| `connection` | object with `status: 'connected' \| 'disconnected' \| 'reconnecting'`, `detail?` |

`PRESENTATION_STATE_FIELDS` pins exactly those five keys via
`satisfies Record<keyof KubicPresentationState, true>` — adding or
removing a field breaks compilation, and the projector re-checks the same
list at runtime before every hand-out.

| Interface | Fields |
| --- | --- |
| `SessionSnapshot` | `sessionId: string`, `model?: string`, `thinking?: string`, `workspace?: string`, `approvalsSkipped: boolean` |
| `LaneSnapshot` | `status: 'idle'\|'running'\|'done'`, `tools: LaneToolSnapshot[]`, `queued: string[]`, `compacting: boolean`, `fault?`, `retrying?` |
| `LaneToolSnapshot` | `toolCallId`, `toolName`, `status: 'running'\|'done'`, `isError`, `args?`, `entry?`, `durationMs?` |
| `LaneImagePart` | `mimeType`, `data` (base64, no `data:` prefix), `filename?`, `bytes?` |
| `ApprovalRequest` | `requestId`, `toolName?`, `capability?`, `detail?` |
| `UsageTotals` | `inputTokens`, `outputTokens`, `costUsd`, `requests?`, `cacheReadTokens?`, `cacheWriteTokens?` |

The state is produced by the host-side projector
(`packages/host/src/presentation/projector.ts`), which folds the lane event
stream plus the approval facts the host feeds it; `apps/kubic/src/tui-run.ts`
feeds the TUI from it, and `packages/tui/src/tui-app.ts` renders it
(`applyPresentation`) — the presentation never folds raw events itself.
The projector also exposes `revision()`, its monotonic fold counter (0 at
the seed, +1 per applied fact): a consumer can tell a fresh state from the
one it last rendered without diffing. It is deliberately not a state field.

### `PRESENTATION_COMMANDS` (`presentation.ts`)

The closed command vocabulary (`isPresentationCommand` narrows `string`
into it):

`approval.respond`, `session.attach`, `session.detach`, `session.fork`,
`session.navigate`, `lane.prompt`, `lane.steer`, `lane.followUp`,
`lane.abort`, `lane.compact`, `lane.resume`, `model.select`,
`thinking.cycle`.

## Dep-direction neighbours

- May import: nothing internal (external deps only).
- Imported by: every package may import core ([tui](tui.md) takes its
  contracts from core only).

```text
@kubic/core            ← imported by all; imports nothing internal
```

Back to the [docs index](../README.md).
