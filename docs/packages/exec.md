# `@kubic/exec`

> Design ref: §9 ExecutionEnv binding; only this package touches
> `node:fs`/`node:child_process`.
> Owner: issue
> [#63](https://github.com/konic-labs/kubic/issues/63).
> Source: `packages/exec/src` (read-only — this page quotes it, never moves it).

`@kubic/exec` is the execution-environment seam (issue #12; §9, §20.2,
§3.7). Every tool runs through it — no tool imports
`node:fs`/`child_process` directly (`scripts/dep-lint.mjs` rejects those
imports everywhere else; test scaffolding is exempt). Solo has no
isolation (§3.7): confinement here is a cwd guardrail against accidental
escapes, not a sandbox boundary.

## Public API (`packages/exec/src`)

| Module | Exports |
| --- | --- |
| `env.ts` | `ExecutionEnv`, `Provenance`, `ROOT_PROVENANCE`, `FileSystem`, `StatInfo`, `Shell`, `ShellResult`, `SpawnOptions`, `ProcessHandle`, `ProcessSnapshot`, `UpdateCallback`, `CheckpointStore`, `NodeExecutionEnv`, `FakeExecutionEnv`, `FakeScript`, `MemoryCheckpointStore`, `CHECKPOINT_INTERVAL_MS` |
| `journal.ts` | `JournalOp`, `JournalEntryInput`, `JournalEntry`, `JournalRetention`, `RetentionPolicy`, `FileJournalStore`, `Baseline`, `BaselineOptions`, `ReconcileContext`, `RestoreResult`, `LARGE_FILE_BYTES`, `DEFAULT_JOURNAL_MAX_BYTES`, `sha256Hex`, `encodeDelta`, `applyDelta`, `captureBaseline`, `saveBaseline`, `loadBaseline`, `restoreEntry`, `reconcile` |
| `journal-diff.ts` | `FileChange`, `DiffFilter`, `diffEntries`, `unifiedHunks`, `renderDiff` |
| `journal-status.ts` | `JournalStatus`, `RepoState`, `journalStatus`, `renderLog` |
| `journal-undo.ts` | `UndoScope`, `UndoPlan`, `UndoResult`, `planUndo`, `applyUndo` |
| `journal-reconcile.ts` | Reconciliation entry points over journal entries |
| `effects.ts` | `ReplayPolicy`, `REPLAY_POLICIES`, `ToolCall`, `ToolCallState`, `TOOL_CALL_STATES`, `ToolEvent`, `ToolEnd`, `advanceToolCall`, `EffectTicket`, `EffectGate`, `batchTerminates` |
| `checkpoint-store.ts` | `FileCheckpointStore` |
| `file-bridge.ts` | `FileBridge`, `BridgeFileInfo`, `BridgeLineReader`, `createNodeFileBridge` |
| `workspace.ts`, `paths.ts` | Workspace / path helpers |
| `index.ts` | Reserved stub (`export {}`) |

## Contracts

### `ExecutionEnv` (`env.ts`)

| Field | Type |
| --- | --- |
| `cwd` | `string` |
| `fs` | `FileSystem` |
| `shell` | `Shell` |
| `provenance` | `Provenance` |
| `withProvenance` | `(next: Provenance) => ExecutionEnv` |

Supporting shapes, field-for-field:

| Interface | Fields |
| --- | --- |
| `Provenance` | `sessionId: string`, `agentId: string`, `toolCallId: string`, `turnId: number`, `operation: string` |
| `StatInfo` | `isFile: boolean`, `isDirectory: boolean`, `size: number` |
| `FileSystem` | `readFile(path): string`, `writeFile(path, content): void`, `rename(from, to): void`, `listDir(path): string[]`, `stat(path): StatInfo` |
| `ShellResult` | `exitCode: number`, `stdout: string`, `stderr: string`, `provenance: Provenance` |
| `ProcessSnapshot` | `stdout: string`, `stderr: string`, `exitCode: number \| null` |
| `CheckpointStore` | `record(key, snapshot): void`, `recordFinal(key, snapshot): void`, `latest(key): ProcessSnapshot \| undefined` |
| `SpawnOptions` | `provenance: Provenance`, `onUpdate?: UpdateCallback`, `checkpointKey?: string`, `checkpointStore?: CheckpointStore` |
| `ProcessHandle` | `pid: number \| undefined`, `wait(): Promise<ShellResult>`, `kill(): void` |
| `Shell` | `spawn(cmd: string, args: string[], options: SpawnOptions): ProcessHandle` |

`ROOT_PROVENANCE` is `{ sessionId: '', agentId: '', toolCallId: 'root',
turnId: 0, operation: 'init' }`. `NodeExecutionEnv` is the cwd-scoped
live binding; `FakeExecutionEnv` (+ `FakeScript`) is the hermetic test
double. `confine()` is lexical only (`resolve()` defeats `..`/absolute
escapes but not symlinks) — acceptable because solo has no isolation.

### Journal (`journal.ts`, `journal-diff.ts`)

`JournalOp` is `'write' \| 'edit' \| 'create' \| 'delete' \| 'rename'`.
`LARGE_FILE_BYTES` is 64 KiB; `DEFAULT_JOURNAL_MAX_BYTES` is 100 MiB.

| Interface | Fields |
| --- | --- |
| `JournalEntryInput` | `path`, `op`, `before: string \| null`, `beforeHash?: string \| null`, `after: string \| null`, `bytesDelta: number`, `sessionId`, `agentId`, `toolCallId: string \| null`, `timestamp: number`, `unattributed?: boolean` |
| `JournalEntry` | `path`, `op`, `beforeHash: string \| null`, `afterHash: string \| null`, `deltaHash: string \| null`, `bytesDelta: number`, `sessionId`, `agentId`, `toolCallId: string \| null`, `timestamp: number`, `unattributed?: boolean` |
| `JournalRetention` | `maxBytes?: number`, `maxAgeMs?: number` |
| `FileChange` (`journal-diff.ts`) | `path`, `op: JournalOp`, `agentId`, `toolCallId: string \| null`, `sessionId`, `timestamp: number`, `unattributed: boolean`, `reversible: boolean`, `before: string \| null`, `after: string \| null` |
| `DiffFilter` | `path?: string`, `agent?: string` |

One `FileChange` per path (earliest before, latest after, latest
attribution); unified-hunk rendering is shared by the CLI and future
views. Status (`JournalStatus`, `RepoState`) and undo (`UndoScope`,
`UndoPlan`, `UndoResult`) build on the same entry store — see the module
for their exact fields.

### Effects (`effects.ts`)

`REPLAY_POLICIES` is `['never', 'safe']`; `TOOL_CALL_STATES` covers the
tool-call machine stepped by `advanceToolCall(call, event)`; `EffectGate`
issues `EffectTicket`s and `batchTerminates(ends)` decides batch end.
Replay declarations, the gate, and the batch machine are the Slice C
surface — see the module for exact fields.

## Dep-direction neighbours

- May import: [@kubic/core](core.md) only (no worker/host/agents/
  trajectory/eval/tui — see `scripts/dep-lint.mjs`).
- Imported by: [@kubic/worker](worker.md) (lane bridges), [@kubic/host](host.md)
  (journal CLI), [@kubic/agents](agents-pkg.md) (`FileBridge` for
  memory/skills).
- Note: importable by the extensions dogfood facet but unreferenced
  in-tree (allowed by `scripts/dep-lint.mjs`, no edge yet).
- Sole owner of `node:fs` / `node:child_process` (§9, issue #12).

```text
@kubic/core
    ↑
@kubic/exec           ← sole node:fs/child_process owner
    ↑         ↑
 worker      host …
```

Back to the [docs index](../README.md).
