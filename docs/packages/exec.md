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
| `env.ts` | `ExecutionEnv`, `Provenance`, `ROOT_PROVENANCE`, `FileSystem`, `StatInfo`, `Shell`, `ShellResult`, `SpawnOptions`, `ProcessHandle`, `ProcessSnapshot`, `UpdateCallback`, `CheckpointStore`, `NodeExecutionEnv`, `FakeExecutionEnv`, `FakeScript`, `MemoryCheckpointStore`, `CHECKPOINT_INTERVAL_MS`, `MAX_CHILD_OUTPUT_BYTES`, `KILL_GRACE_MS`, `TOOL_ENV_ALLOWLIST`, `toolSpawnEnv` (§3.8: every spawned child gets the allowlisted env, secrets dropped) |
| `journal.ts` | `JournalOp`, `JournalEntryInput`, `JournalEntry`, `JournalRetention`, `RetentionPolicy`, `FileJournalStore`, `Baseline`, `BaselineOptions`, `ReconcileContext`, `RestoreResult`, `LARGE_FILE_BYTES`, `HASH_CHUNK_BYTES`, `HASH_NOTICE_BYTES`, `MAX_SWEEP_CONTENT_BYTES`, `DEFAULT_JOURNAL_MAX_BYTES`, `sha256Hex`, `sha256HexOfFile`, `encodeDelta`, `applyDelta`, `captureBaseline`, `saveBaseline`, `loadBaseline`, `restoreEntry`, `removeCreatedEntry`, `isUndoableCreate`, `reconcile` |
| `journal-diff.ts` | `FileChange`, `DiffFilter`, `diffEntries`, `unifiedHunks`, `renderDiff` |
| `journal-status.ts` | `JournalStatus`, `RepoState`, `journalStatus`, `renderLog` |
| `journal-undo.ts` | `UndoScope`, `UndoPlan`, `UndoOptions`, `UndoResult`, `planUndo`, `applyUndo` |
| `journal-reconcile.ts` | `RunReconciliationOptions`, `RunReconciliation`, `beginReconciliation` |
| `ignore.ts` | `IgnoreRule`, `parseIgnoreFile`, `isIgnored` — the shared `.gitignore`-subset matcher (#116, #172): the journal baseline walk and the worker's find/grep walk cannot disagree on what is ignored |
| `file-bridge.ts` | `FileBridge`, `BridgeFileInfo`, `BridgeLineReader`, `createNodeFileBridge` |
| `lock-file.ts` | `createLockFile`, `readLockFile`, `removeLockFile` — the O_EXCL lock-file primitive behind the session lock (#118) |
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
| `FileSystem` | `readFile(path): string`, `writeFile(path, content): void`, `rename(from, to): void`, `listDir(path): string[]`, `stat(path): StatInfo`, `lstat?(path): StatInfo & { isSymbolicLink: boolean }` (optional, #172: `stat` follows links, `lstat` lets the walk skip symlinks instead of descending loops; absent = links are indistinguishable from targets) |
| `ShellResult` | `exitCode: number`, `stdout: string`, `stderr: string`, `provenance: Provenance` |
| `ProcessSnapshot` | `stdout: string`, `stderr: string`, `exitCode: number \| null` |
| `CheckpointStore` | `record(key, snapshot): void`, `recordFinal(key, snapshot): void`, `latest(key): ProcessSnapshot \| undefined` |
| `SpawnOptions` | `provenance: Provenance`, `onUpdate?: UpdateCallback`, `checkpointKey?: string`, `checkpointStore?: CheckpointStore` |
| `ProcessHandle` | `pid: number \| undefined`, `wait(): Promise<ShellResult>`, `kill(): void` — SIGTERM to the whole process group, escalating to SIGKILL after `killGraceMs` (default `KILL_GRACE_MS`, 2 s) if the child has not settled, so a child that traps SIGTERM can never leave `wait()` hanging |
| `Shell` | `spawn(cmd: string, args: string[], options: SpawnOptions): ProcessHandle` |

`ROOT_PROVENANCE` is `{ sessionId: '', agentId: '', toolCallId: 'root',
turnId: 0, operation: 'init' }`. `NodeExecutionEnv` is the cwd-scoped
live binding; `FakeExecutionEnv` (+ `FakeScript`) is the hermetic test
double. `confine()` is lexical only (`resolve()` defeats `..`/absolute
escapes but not symlinks) — acceptable because solo has no isolation.

### Journal (`journal.ts`, `journal-diff.ts`)

`JournalOp` is `'write' \| 'edit' \| 'create' \| 'delete' \| 'rename'`.
`LARGE_FILE_BYTES` is 64 KiB; `HASH_CHUNK_BYTES` and
`MAX_SWEEP_CONTENT_BYTES` are 4 MiB; `DEFAULT_JOURNAL_MAX_BYTES` is 100 MiB.

| Interface | Fields |
| --- | --- |
| `JournalEntryInput` | `path`, `op`, `before: string \| null`, `beforeHash?: string \| null`, `after: string \| null`, `afterHash?: string \| null`, `afterOmitted?: boolean`, `afterBytes?: number`, `bytesDelta: number`, `sessionId`, `agentId`, `toolCallId: string \| null`, `timestamp: number`, `unattributed?: boolean` |
| `JournalEntry` | `path`, `op`, `beforeHash: string \| null`, `afterHash: string \| null`, `deltaHash: string \| null`, `bytesDelta: number`, `sessionId`, `agentId`, `toolCallId: string \| null`, `timestamp: number`, `unattributed?: boolean`, `afterOmitted?: boolean`, `afterBytes?: number` |
| `JournalRetention` | `maxBytes?: number`, `maxAgeMs?: number`, `durable?: boolean` (default `true`) |
| `FileChange` (`journal-diff.ts`) | `path`, `op: JournalOp`, `agentId`, `toolCallId: string \| null`, `sessionId`, `timestamp: number`, `unattributed: boolean`, `reversible: boolean`, `before: string \| null`, `after: string \| null`, `corrupt: boolean`, `afterOmitted: boolean`, `afterBytes?: number`, `contentTruncated?: boolean` |
| `DiffFilter` | `path?: string`, `agent?: string` |

One `FileChange` per path (earliest before, latest after, latest
attribution); unified-hunk rendering is shared by the CLI and future
views. Status (`JournalStatus`, `RepoState`) and undo (`UndoScope`,
`UndoPlan`, `UndoResult`) build on the same entry store — see the module
for their exact fields.

Display surfaces (issue #126): `journalStatus` resolves the branch of a
linked worktree by following `.git`'s `gitdir:` pointer to the real `HEAD`
(pure file reads; a dangling or malformed pointer is `(unknown)`, never a
throw); `unifiedHunks` accumulates its `@@` header counts while emitting,
so the counts always equal the lines printed; and the `diff --json`
projection (`clipContent` / `clipChangeContent` with
`DEFAULT_MAX_CONTENT_BYTES` = 64 KiB, `0` = unlimited) clips each side to
the bound, appending the marker line `[kubic: content truncated at <n>
bytes]` and setting `contentTruncated`. The human `renderDiff` path never
clips — it renders hunks, not whole files.

Journal durability (issue #117): index appends go through the bridge's
`appendDurably` (open/write/fsync/close) so the entry is on platter
before `append` returns — one fsync per tool write is the price of
"reversible", and it is the default (`JournalRetention.durable`; `false`
trades it for a crash window of one truncated last line, and a bridge
without `appendDurably` always falls back to a plain append). The fsync
covers the appended index line only — blob payloads and the retention
compaction rewrite are renamed without one, so a crash right after a
compaction can lose more than the last line. Blob writes and undo
restores are tmp+rename in the target's own directory, so a partial file
is never visible under its real name; directory-entry fsync is
deliberately out of scope — rename atomicity is the guarantee, stated in
[the journal and safety page](../architecture/journal-and-safety.md).

Undo records (issue #117): every successful restore appends its inverse
entry — pre-undo content as `before`, restored content as `after`,
`sessionId`/`agentId` `kubic-undo`, `toolCallId` null — so the journal
describes the world after an undo, and a second `undo --step` is the
redo. It is an attributed entry (no `unattributed` flag, no
`reconciled` marker); `applyUndo` appends it in the non-dry-run path
only, and only for a step that actually restored. Plain plans
(`planUndo` without `step`) filter these records out — they are the
walk's own bookkeeping — so repeated plain undo is idempotent
(`already undone`, nothing appended); `--step` targets them. A restore
also preserves the target's existing mode across its tmp+rename (a
0600 secret stays 0600, a 755 script keeps its exec bit), creates the
tmp 0600 so crash residue is never world-readable, and sweeps stale
`<target>.kubic-restore-*.tmp` siblings best-effort after a successful
restore.
An agent-authored create (`op: 'create'`, no before-hash, not
`unattributed`) is reversible by removal (`isUndoableCreate`,
`removeCreatedEntry`, same containment guards as `restoreEntry`): undo
removes the file when its content still matches the recorded after-hash,
reports `already undone` when it is already absent, and journals a
`kubic-undo` delete carrying the removed content so `--step` redoes it.

Baseline walk ignores (issue #116): `captureBaseline` honors every
`.gitignore` on the way down, not just the root's. Rules accumulate per
directory as the recursion descends — child rules are appended AFTER the
parent's, so `isIgnored`'s last-match-wins lets a nested negation override a
parent ignore (the ordering git uses) — and the stack is dropped on recursion
exit, so a sibling subtree never inherits another's rules. An unreadable
nested ignore (chmod 000, a permission-denied mount) leaves the parent rules
in force and the walk continues: the documented widening, never a throw.
`reconcile` re-walks through the same `captureBaseline`, so boot and sweep can
never disagree about what is in scope. The matcher is the shared
`ignore.ts` (#172), so this walk and the worker's find/grep walk also cannot
disagree about what is ignored. The matcher stays the documented
common subset (`*`, `?`, `**` at the edges, `dir/`, `!`) — character classes
and mid-pattern `**` are not modeled — and nested rules are matched against
the workspace-relative path rather than re-rooted at their own directory, so
a nested ANCHORED pattern must be written repo-relative (`packages/foo/build/`);
a git-style directory-relative one (`sub/build/` inside
`packages/foo/.gitignore`) matches nothing and merely widens the baseline.
Per-directory negation subtleties beyond last-match-wins, and
`.git/info/exclude` / `core.excludesFile`, remain unsupported (the latter is a
follow-up, not a behavior change here). Cost: one `exists('.gitignore')` per
directory entered — the same order as the `listDir` already paid, with no read
at all for a directory without an ignore file.

Sweep after-content bound (issue #120): `reconcile`'s record path reads a
changed file once, bounded by `MAX_SWEEP_CONTENT_BYTES` (4 MiB). Above the
bound — or when the utf-8 decode is lossy — the entry is hash-only:
`after: null` with `afterHash` keeping the walk hash (so dedupe and undo
staleness compare the same digest the walk produced), `afterOmitted: true`,
and `afterBytes` the observed size; `diff` renders
`[content not captured — N bytes changed]`. The lossy check hashes the bytes
the decode came from and the decode's re-encoding: they agree only for a
faithful round-trip (the walk hash itself cannot make this call — at or
under `HASH_CHUNK_BYTES` it IS the hash of the decode). A hash-only
after-side is a designed absence, never `corrupt`.

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
