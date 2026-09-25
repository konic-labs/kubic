# `@kubic/exec`

> Design ref: §9 ExecutionEnv binding; only this package touches
> `node:fs`/`node:child_process`.
> Owner: issue
> [#63](https://github.com/konic-labs/kubic/issues/63).
> Source: `packages/exec/src` (read-only — this page quotes it, never moves it).

`@kubic/exec` is the execution-environment seam (issue #12; §9, §20.2,
§20.4, §3.7). Every tool runs through it — no tool imports
`node:fs`/`child_process` directly (`scripts/dep-lint.mjs` rejects those
imports everywhere else; test scaffolding is exempt). Solo has no
isolation (§3.7): confinement here is a cwd guardrail against accidental
escapes, not a sandbox boundary.

## Public API (`packages/exec/src`)

| Module | Exports |
| --- | --- |
| `env.ts` | `ExecutionEnv`, `Provenance`, `ROOT_PROVENANCE`, `FileSystem`, `StatInfo`, `Shell`, `ShellResult`, `SpawnOptions`, `ProcessHandle`, `ProcessSnapshot`, `UpdateCallback`, `CheckpointStore`, `NodeExecutionEnv`, `FakeExecutionEnv`, `FakeScript`, `MemoryCheckpointStore`, `CHECKPOINT_INTERVAL_MS` |
| `journal.ts` | `JournalOp`, `JournalEntryInput`, `JournalEntry`, `JournalRetention`, `RetentionPolicy`, `FileJournalStore`, `Baseline`, `BaselineOptions`, `ReconcileContext`, `RestoreResult`, `LARGE_FILE_BYTES`, `HASH_CHUNK_BYTES`, `DEFAULT_JOURNAL_MAX_BYTES`, `sha256Hex`, `sha256HexOfFile`, `encodeDelta`, `applyDelta`, `captureBaseline`, `saveBaseline`, `loadBaseline`, `restoreEntry`, `reconcile` |
| `journal-diff.ts` | `FileChange`, `DiffFilter`, `diffEntries`, `unifiedHunks`, `renderDiff` |
| `journal-status.ts` | `JournalStatus`, `RepoState`, `journalStatus`, `renderLog` |
| `journal-undo.ts` | `UndoScope`, `UndoPlan`, `UndoResult`, `planUndo`, `applyUndo` |
| `journal-reconcile.ts` | `RunReconciliationOptions`, `RunReconciliation`, `beginReconciliation` |
| `file-bridge.ts` | `FileBridge`, `BridgeFileInfo`, `BridgeLineReader`, `createNodeFileBridge` |
| `runtime-exclude.ts` | `RUNTIME_EXCLUDE_ENTRIES`, `RUNTIME_EXCLUDE_BEGIN`, `RUNTIME_EXCLUDE_END`, `RuntimeExcludeText`, `applyRuntimeExcludeBlock`, `RuntimeExcludeOutcome`, `ensureRuntimeExcludeRules` |
| `workspace.ts`, `paths.ts` | Pointer | Workspace = cwd-scoped `NodeExecutionEnv` in `env.ts` (#12); path confinement in `env.ts` + `@kubic/worker` `lane/interceptors.ts` |
| `index.ts` | Pointer | No barrel — import per-module paths |

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

### Effects / replay (issue #97 — deleted, not wired)

There is **no Kubic-side replay kernel**. `effects.ts` (the `ToolCall`
state machine, `EffectGate`, replay policies) and `checkpoint-store.ts`
(`FileCheckpointStore`) were deleted: both reimplemented machinery the Pi
harness already owns — the tool-call machine
(`planned → effect_pending → outcome_ready → completed`, `replay:
"never" | "safe"`, `pi-agent-core` `session/types.ts`) and the
abort-aware admission gate (`execution/effect-gate.ts`).

What actually ships in Kubic:

- **Replay policy declaration.** `Operation.replay` is `'never' | 'safe'`
  per operation (`packages/worker/src/ops/*`), mapped straight onto
  `AgentHarnessTool.replay` by `@kubic/worker` `lane/tools-adapter.ts`.
  Never-replay operations memoize their result under the invocation id
  (`ops/registry.ts`), so a retry with the same invocation id returns the
  recorded result instead of re-executing.
- **`MemoryCheckpointStore`** (`env.ts`) is the `CheckpointStore` seam
  behind `SpawnOptions.checkpointKey`/`checkpointStore`, exercised by the
  exec and lane tests. No production caller supplies one, so **a
  `kubic run`/`kubic orchestrate` invocation persists no checkpoint**.

`kubic replay --tier deterministic|live` **re-executes** the recorded
objective through the solo lane at the pinned model/role config. It does
**not** replay recorded effects: there is no effect log to replay from,
and a `replay:"never"` tool re-invokes when the re-execution reaches it.
Only `--tier recorded` is log-only, and it never touches a lane.

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
