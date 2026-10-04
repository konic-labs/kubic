# `@kubic/worker`

> Design ref: worker runtime; Pi boundary (§65, CODEOWNERS-gated
> `src/pi-boundary.ts`).
> Owner: issue
> [#63](https://github.com/konic-labs/kubic/issues/63).
> Source: `packages/worker/src` (read-only — this page quotes it, never moves it).

`@kubic/worker` is the agent runtime: solo lane, tool adaptation, Pi
harness wiring, budgets, compaction, and the worker → host result
payload. All Pi imports flow through the worker Pi seam
`src/pi-boundary.ts` (§65) — `scripts/dep-lint.mjs` rejects
`@earendil-works/*` imports everywhere else in the worker (the TUI owns
the other seam, `packages/tui/src/tui-boundary.ts`), and CODEOWNERS flags
every diff touching the boundary for maintainer review.

## Public API (`packages/worker/src`)

| Module | Exports |
| --- | --- |
| `result.ts` | `AgentResult`, `RESULT_FIELDS`, `ResultStatus`, `RESULT_STATUSES`, `ResultError`, `ResultErrorKind`, `ERROR_KINDS`, `TestResult`, `ArtifactRef`, `WorkspaceDiffRef`, `WorkerProvenance`, `ApprovalRecord`, `EscalationRecord`, `ResultMetrics`, `ResultValidation`, `validateAgentResult`, `JsonValue` |
| `pi-boundary.ts` | Worker Pi seam (§65, [#197](https://github.com/konic-labs/kubic/issues/197); #391 moved it to the Pi 1.0 surface). pi-durable harness: values `Harness`, `createRegistry`, `defineExtension`, `defineTool`, `wrapTool`, `hook`, `section`, `ToolTask`, `GenerationTask`, `CompactionTask`, `AgentDoc`, `LiveDoc`, `UsageDoc`, `configure`, `defineDoc`, the entry-kind tokens (`UserEntry`, `AssistantEntry`, `ToolResultEntry`, `SystemEntry`, `CompactionEntry`), `MemoryStorage`, `watchEvents`, `ConversationBusy`; types `Conversation`, `Submission`, `SettledSubmissionRecord`, `Extension`, `ToolRegistration`, `ToolExecutionApi`, `ToolHooks`, `HookRegistration`, `HarnessSettings`, `CompactionPolicy`, `AgentEvent`, `EntryRecord`, `Storage`; storage `openNodeJsonlStorage`. `@earendil-works/chord`: `Context`, `BACKGROUND_CONTEXT`, `JsonValue`. `@earendil-works/pi-durable/env`: `FileSystem`, `ExecutionEnv`, `Result`, `ok`, `err`, `FileError`, `FileErrorCode`, `FileInfo`, `FileKind`. Model layer (`Model`, `MutableModels`, `Usage`, `DeferredHandle`, `ModelThinkingLevel`, thinking clamp, providers, `Type`, the lazy `api/*.lazy` subpaths, `builtinProviders`) — each re-export carries a JUSTIFICATION block naming seam, user, why-Pi, and review, and the pi-boundary gate fails an export without one |
| `lane/solo.ts` | `SOLO_LANE_NAME` (`'main'`), `SOLO_PROMPT_SECTION`, `SOLO_ROLE`, `assembleSoloPrompt`, `SoloPromptInput`, `defaultSoloModelId`, `defaultSoloPrompt`, `SoloPolicyOptions` (`beforePolicyHooks`/`spanHooks`/`contributions`/`classes`/`interceptors`; enterprise `toolAllowed`/`modelAllowed`), `SoloCompactionOptions`, `SoloBootOptions` (`session` is the #392 handle, handed to the harness through `session.adopt()` so a `release()` cannot close a storage a live harness owns; `settings` excludes `compaction`/`extensions`, which the lane owns; the pre-1.0 `memos` option is gone — tool memos are pi-durable `api.memo`; `modelPolicy`/`onModelNotice`: a resumed lane keeps its stored model unless the selection is an explicit pin, which switches it; an unregistered stored model fails closed with `ModelSelectError` — #148), `SoloLane` (`harness`/`conversation`/`registry`/`kills`/`model`; `close()` closes the harness and leaves `session.release()` to the caller), `bootSoloLane` (installs the per-process registry `kubic.budget` → `kubic.policy` → `kubic.spans` → `kubic` — install order is hook order, #397/#394), `splitSoloModelId`, `escalateSoloModel`. One turn is `conversation.submit(...)` → `submission.wait(...)`; the pre-1.0 `driveToSettled`/`DriveOutcome` loop was deleted with #395, and `lane/turn.ts` owns the glue |
| `lane/events.ts` | `KubicLaneEvent`, `LaneEventSink`, `KubicLaneTool`, `KubicLaneCompaction`, `toKubicLaneEvent`, `subscribeLaneEvents` |
| `lane/failures.ts` | `FailureCode`, `FAILURE_CODES`, `RetryStrategy`, `RETRY_STRATEGIES`, `RetryDecisionKind`, `ClassifiedFailure`, `classifyFailure`, `RetryHints`, `RetryDecision`, `RetryBudget`, `chooseRetry` |
| `lane/tools-adapter.ts` | `KubicToolContext`, `kubicToolsToPiTools` (registry schemas + json_schema/`prefer` constrained sampling — #168), `renderToolText`, `renderReadText`, `renderGrepText`, `renderBashText` (plain-text results with a header; [tools](../cli/tools.md)) |
| `lane/interceptors.ts` | `PolicyTrigger`, `PolicyInterceptorOptions`, `ApprovalCall`, `ApprovalAskVerdict`, `defaultIsDestructive`, `isNetworkCommand`, `confinePath`, `redactReason`, `policyInterceptorHooks` (ordered pi-durable `ToolTask.beforeTool` registrations, #397; one call per boot — the attempt counter and approved-call set live in that call, never across boots; first block wins, a throw blocks) |
| `lane/policy.ts` | `PermissionClasses` (re-export), `PolicyRefusedError` |
| `lane/session-store.ts` | `SessionStore`, `openSessionStore`, `KubicSessionMeta`, `KubicSessionDoc`, `SessionHandle`, `SessionListEntry`, `createSession`, `attachSession`, `listSessions`, `readSessionMetadata`, `SessionAttachError`, `SessionFormatError`, `SessionIdError`, `SessionLockError`, `acquireSessionLock`, `releaseSessionLock`, `sessionLockIsLive`, `sessionsTouchingWorkspace` — session storage on pi-durable ([session storage](#session-storage-issue-392)) |
| `lane/session-fs.ts` | `bridgeToPiFileSystem` — the 1.0 `FileSystem` (19 members, `id`/`truncateFile`/`flushFile` included) over the exec file bridge |
| `lane/turn.ts` | `TurnOutcome`, `RunTurnOptions`, `runTurn`, `awaitTurn`, `turnAbort`, `turnAbortReasonOf`, `TurnAbort`, `turnLaneRecord`, `TURN_BUSY_REASON` — one turn is `conversation.submit({ type: 'input', … })` → `submission.wait(context)`; no Kubic-side loop, no sleep (§20.5–§20.7, #395) |
| `lane/settle.ts` | `OperationErrorLike`, `SettledResult`, `LaneTerminalStatus`, `SubmissionFailure`, `classifyHarnessError`, `classifySubmissionFailure`, `classifyThrownError`, `laneStatusOf`, `laneErrorOf`, `settleTerminalStatus`, `settleSubmission` — a settled pi-durable submission → Kubic's `ResultStatus`/`ResultError` and the §52 codes (#395) |
| `lane/pending.ts` | `PendingPolicy`, `PendingReport`, `PendingSettlementResult`, `SettlePendingOptions`, `PendingLane`, `inspectPending`, `settlePending`, `describePendingSettlement`, `pendingInputText`, `inspectStoredWork` — settle a turn a crashed process left open (#147; #396: `harness.inspect()` decides, `resume` waits under the caller's guard, `abort` is durable) |
| `lane/abort.ts` | `KillFn`, `OperationKillRegistry`, `AbortableLane`, `LaneAbortResult`, `LaneDriveError`, `abortLane`, `forgetLaneKills` — `conversation.abort(context)` plus the conversation-keyed kill drain (every kill attempted, failures aggregated, #395 D6.2) |
| `lane/transcript.ts` | `TranscriptItem`, `entriesToTranscript`, `readConversationEntries`, `readSessionEntries` — the one pi-durable → Kubic transcript adapter (#400) |
| `lane/test-harness.ts` | `bootFauxLane`, `runPrompt`, `laneEntries`, `laneToolResults`, `laneSystemPrompt`, `laneActiveTools`, `fauxToolUse`, … — the test-only faux SoloLane factory (#401) |
| `lane/wrap.ts` | `ExecuteFn`, `ToolContribution`, `composeTools`, `compositionOrder`, `PolicyDeniedError`, `withPermissionCheck`, `TelemetryRecord`, `withTelemetry` |
| `lifecycle/registry.ts` | `WorkerRegistration`, `WorkerRow`, `WorkerRegistry` |
| `lifecycle/env.ts` | `ENV_ALLOWLIST`, `filterSpawnEnv`, `roleCredentialEnv`, `roleGrantEnv`, `withRoleGrant`, `buildSpawnEnv`, `redactEnvForLog` |
| `lifecycle/reap.ts` | `RawExit`, `ExitReport`, `reportExit`, `ReapTarget`, `ReapDeps`, `DetachedReap`, `TEARDOWN_BUDGET_MS`, `reapDetached` |
| `lifecycle/budgets.ts` | `LIFECYCLE_BUDGETS_MS`, `PerfSample`, `PerfGateResult`, `checkPerfGate` |
| `usage.ts` | `KubicUsageRow`, `ModelUsageSummary`, `UsageSummary`, `summarizeUsage`, `formatCost`, `formatUsageLine`, `usageRowFromEntry` |
| `model-select.ts` | `ModelSelectError`, `ModelSelection`, `AnyModel`, `selectModel`, `parseModelFlag`, `EscalationRecord`, `EscalationLadder`, `EscalationError`, `createLadder`, `escalateModel`, `supportedThinking`, `clampThinking`, `saveThinkingLevel`, `loadThinkingLevel` |
| `models-config.ts` | `CustomApi`, `CUSTOM_APIS`, `CustomModelSpec`, `CustomProviderSpec`, `ModelsJsonError`, `THINKING_LEVELS`, `isThinkingLevel`, `parseModelsJson`, `LOCAL_MODELS_EXAMPLE`, `registerCustomProviders` |
| `prompts.ts` | `PromptCacheError`, `PROMPT_CACHE_RULES`, `SystemPromptInput`, `assembleSystemPrompt`, `sortedToolNames`, `serializeMetadata`, `appendTurnContent`, `LaneBinding`, `LaneRegistry`, `AffinityEscalation`, `TaskAffinity`, `pinModelForTask`, `taskModelForTurn`, `assertSingleModelId`, `ModelEscalationEvent`, `escalatePinnedModel`, `CompactionRoute`, `buildCompactionRoute`, `SessionCacheCounters`, `emptyCacheCounters`, `recordCacheUsage`, `cacheHitRate`, `SessionCacheStats` |
| `compaction.ts` | `DEFAULT_RESERVE_TOKENS`, `MAX_RESERVE_FRACTION`, `effectiveReserveTokens`, `SOLO_KEEP_RECENT_TOKENS` (20000), `SOLO_BACKGROUND_TOKENS` (0: Kubic's reserve threshold is the only trigger — no speculative background summary, #399), `SoloCompactionSettingsOptions`, `soloCompactionSettings` (the harness `settings.compaction`; `reserveTokens` is a live getter clamped to the current model's window, so a model switch re-clamps with no explicit step), `SoloCompactionLane`, `compactSoloLane` (§27.2 manual `/compact [focus]`; admits Pi's compaction task with Kubic's prompt as its instructions — #330; **automatic** threshold/overflow compaction uses Pi's own summarization prompt, because pi-durable only accepts instructions through `compact()`, so Kubic's `buildCompactPrompt` reaches the manual path only — #399/D3), `parseCompactCommand`, `CompactionError`, `CompactPromptInput`, `buildCompactPrompt`, `BranchSummaryEntry`, `BranchSummaryStore`, `FileOpKind`, `FileOp`, `CumulativeFileOps`, `emptyFileOps`, `accumulateFileOps`, `StructuredSummary`, `formatStructuredSummary`, `TruncatedToolOutput`, `SpillArtifact`, `resolveTruncatedOutput`, `buildSpillArtifact`, `passThroughOutput`, `CompactedState`, `buildCompactedState` |
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

### Find/grep walk bounds (issue #172)

`walkFiles` (`ops/walk.ts`) is what `find` and `grep` recurse with, so
both made the same mistake on a real repo: the 10,000-entry cap was spent on
`.git` and dependency trees, and a symlinked directory was followed as a
second route to a subtree — a loop returned the same file under every route
until the cap or the depth bound stopped it. The walk now:

- **Never walks `.git`**, at any depth, ahead of the ignore matcher: a
  `.gitignore` line cannot un-ignore it.
- **Applies the default ignore set (`node_modules/`) plus every
  `.gitignore` on the way down**, matched against the walk-root-relative
  path. Nested rules ride the stack frame, so they scope to their own
  subtree, and child rules are appended after the parent's — last-match-wins,
  so a nested negation overrides a broader ignore, the ordering git uses. An
  unreadable ignore file keeps the parent rules and keeps walking (the
  documented widening, never a throw). The matcher is the journal's shared
  subset (`exec/ignore.ts`), so repo-wide search and `kubic diff` agree on
  what is ignored; its limits (character classes, nested anchored patterns
  needing the root-relative form) are stated in [@kubic/exec](exec.md),
  under "Baseline walk ignores".
- **Never follows a symlink**, file or directory: the walk uses the optional
  `FileSystem.lstat` (`exec/env.ts`) and skips any entry it marks
  `isSymbolicLink`, so a loop yields one match per real path and a dangling
  link is skipped rather than stat-failing. The named ROOT is the caller's
  explicit target and is read as given (a symlinked root path still walks);
  only links below it are skipped. Seams without `lstat` cannot tell
  a link from its target (the documented widening; `FakeExecutionEnv` has no
  links to make). The skill read-roots wrapper (`withReadRoots`,
  `exec/read-roots.ts`) forwards `lstat`, so a user with skills outside the
  workspace keeps this protection; it once dropped the method and the walk
  fell back to `stat`.
- **Says when a bound stopped it.** `truncated: true` now always carries an
  optional, additive `notice` naming the bound: `walk entry cap 10000
  reached while listing <dir>; results may be incomplete` for the entry
  bound, `walk depth cap 100 reached at <dir>; results may be incomplete`
  for the depth bound, or `result cap <n> reached (maxResults); results may
  be incomplete` / `(maxMatches)` for the op's own limit. `grep`'s
  model-facing text carries the notice after the `truncated` marker (`find`'s
  JSON result already did). The match cap is
  exact: `truncated` is set only once a match beyond `maxMatches` was
  actually seen, never merely because the cap filled on the last match.
  Tool names, argument shapes, and the
  existing result fields are unchanged; `ls` skips an entry whose `stat`
  fails (a dangling symlink) instead of throwing, which it already did and is
  now pinned by test.

The real-filesystem suite for all of this is
`packages/worker/src/ops/walk-real.test.ts` (mkdtemp trees through
`NodeExecutionEnv`, a >10k `node_modules` fixture, a directory cycle, and a
cleanup `afterEach`).

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

The op also bounds a call in time (issue #339): with no `timeout` the command
gets `BASH_DEFAULT_TIMEOUT_SEC` (120 s), any timeout is clamped to
`BASH_MAX_TIMEOUT_SEC` (600 s), and processes the command backgrounded are
killed when it exits unless `KUBIC_BASH_KEEP_BACKGROUND` opts in. Both limits
and the model-facing description come from those constants; the user-facing
statement is in [tools](../cli/tools.md#bash-limits).

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

### Write/edit symlink safety (issue #140)

`write` and `edit` share `replaceFile` (`ops/atomic-file.ts`), the
journal-first tmp+rename writer. It now follows symlinks instead of
replacing them: the target is resolved (`FileSystem.realpath`, resolving
the nearest existing prefix and appending the components a create has yet
to make), the tmp is written **beside the resolved file** and renamed onto
it, and the journal still names the path the call used. A resolved target
outside `ctx.env.cwd` is refused with a named `symlink_escape` OpError
before the journal append — following it would write outside the
confinement guardrail; the same check covers a symlinked directory above
the path. The tmp carries a pid- and call-unique name
(`<target>.kubic-tmp-<pid>-<n>`, so two writers cannot collide), any
stale residue at that exact name is cleared before the write, and the tmp
is removed best-effort through `FileSystem.unlink` when the write, chmod
or rename fails — the earlier fixed-name tmp leaked into the workspace and
the next sweep journaled it as an unattributed create. Both new seam
members are optional (test doubles have no links and no cleanup) and
`withReadRoots` forwards them, or a run with skill roots would leak the
tmp. A dangling link has no target to resolve, so the write replaces the
link itself, as before.

### Session storage (issue #392)

One pi-durable `Storage` per session, at `<sessions-root>/<id>/` — the same
directory that already held the journal, spans, approvals posture and lock.
The storage is opened over the exec file bridge (`bridgeToPiFileSystem`), not
through pi-durable's Node entry point: session bytes keep crossing the I/O
seam, so the #359 secret scrubbing and the #361 file modes apply to the
session JSONL exactly as they did before, and Kubic stays the only package
that touches `node:fs`.

| Path under `<root>/<id>/` | What it is |
| --- | --- |
| `main.jsonl` + `doc-<n>.jsonl` | the pi-durable JSONL storage: the session's transcript, documents and durable tasks — the session's truth |
| `session.json` | Kubic's **listing header**: the metadata projection `listSessions` reads |
| `lock.json` | the session lock ([below](#session-locking-issue-118)) |
| `journal/`, `spans.jsonl`, `posture.json`, `trajectory.json` | the rest of the session's state, unchanged |

The metadata itself is the session-scoped `kubic.session` document
(`KubicSessionDoc`, `{ cwd, createdAt, workspace? }`), written in the
creating commit by a plain pi-durable Session kernel — the harness belongs to
the caller. `readSessionMetadata(storage, context)` reads it back from the
storage a caller already has open.

The listing header exists because **listing must never open a session
storage**: pi-durable owns one storage per process and does no cross-process
locking, and opening a live session's storage would let recovery truncate a
file the live writer is appending to. `listSessions` and
`sessionsTouchingWorkspace` run on every `kubic run` boot (the overlap probe)
and in `kubic doctor`, so they read one small header file per session
instead. The header is written once from the same value as the document and
re-synced from the document on attach, so the two cannot drift.

**fsync is off** — pi-durable's default, and what 0.87's JSONL session
storage did, so this is parity rather than a downgrade. A process crash loses
nothing (the page cache outlives it); a power loss costs at most the newest
commit, which recovery drops whole instead of leaving a torn session. The
change journal stays Kubic's fsync'd store (§42.4): that is where "this
change can be undone" is guaranteed.

File modes are unchanged by this migration: the storage writes through the
same bridge calls as before, so session JSONL is still created with the
umask default. [#361](https://github.com/konic-labs/kubic/issues/361)
(restrictive 0600/0700 modes for session and journal state) is independent of
this port and stays open.

**Legacy sessions (Pi 0.87).** A transcript written by the removed
`JsonlSessionRepo` lives at `<root>/--<cwd>--/<ts>_<id>.jsonl` with a
format-4 header. There is no converter (the repo is unreleased, §21):
`listSessions` reports it as `{ format: 'legacy' }` (and
`sessionsTouchingWorkspace` skips it — a 0.87 transcript can never be the
live sibling that probe warns about), and `attachSession` refuses it with
`SessionFormatError`:

```
session <id> was written by Kubic on Pi 0.87; start a new session
```


A session id must be a plain path segment (`[A-Za-z0-9_-]`) **and** must not
be shaped like one of pi's transcript directories (`--…--`): `listSessions`
classifies that shape as the 0.87 layout, so a session with such an id would
be attachable but invisible to `sessions list`, the overlap probe and
`kubic doctor`. Both paths refuse it (`SessionIdError` on create,

`SessionAttachError` on attach) before any path join — containment by
construction. `createSession` also refuses an id that already has a session
(`Session already exists: <id>`, 0.87's message) and an id that belongs to a
0.87 transcript (`SessionFormatError`): a durable session is never written

over an existing session's journal, spans and posture. A legacy transcript's
header id is validated against the same rule before it enters a listing: a
foreign or hand-edited header is skipped, never rendered.

`SessionHandle.release(context)` always releases the lock and closes the
storage only while no harness adopted it. A caller that boots a harness does
`Harness.open(handle.adopt(), …)`: adoption hands ownership over, so a
`release()` racing a live harness never closes the storage under it (the
harness closes it), and `release()` stays idempotent either way.
`handle.storage` is for reads — `readSessionMetadata` and the other readers —
and does not transfer ownership.


### Session locking (issue #118)

One live attachment per session, fail-closed. `createSession` (before the
storage is created) and `attachSession` (before the storage is opened)
acquire `<sessions-root>/<session-id>/lock.json` — a `{pid, startedAt}`
record of the attaching process — through the exec-owned lock-file
primitive (`exec/lock-file.ts`; I/O confinement, §9): an O_EXCL
(`writeFileSync(…, {flag: 'wx'})`) create is the atomic test-and-set, and
the primitive makes the session dir eagerly as the lock's parent.
`handle.release(…)` releases the lock (best-effort remove), so the file
exists only while a session is actually attached.

The lock is the ONLY guard around a storage open (issue #392): pi-durable
states that one process owns a storage at a time and provides no
cross-process locking, so every open in this module happens with the lock
already held.

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
  two or more sessions are recorded). It matches the session's recorded
  `workspace` when it declared one, its `cwd` otherwise, and it skips
  `format: 'legacy'` transcripts (a 0.87 session cannot be attached, so it
  cannot be a live sibling). The reason it warns: each run's
  end-of-run sweep compares against its own boot baseline, so a sibling
  session's in-flight changes land in this run's journal as unattributed,
  non-reversible entries. Never a block.

The lock covers the session's journal too (it lives under the session
dir) — the journal is not locked separately.

### Session transcript (`lane/transcript.ts`, issue #400)

One adapter turns a session's durable entries into Kubic's
`TranscriptItem` vocabulary. Pi 0.87 stored a tree of
`{id, parentId, type: 'message', message}` entries; pi-durable stores
typed records (`pi.user`, `pi.assistant` with `model: [AssistantMessage]`,
`pi.tool-result`, `pi.system`, `pi.compaction`, `pi.reset`), so every
reader — `kubic sessions attach`, the run-envelope usage, the §46
trajectory, replay/export/eval — goes through this module instead of
matching entry-kind strings itself.

- `entriesToTranscript(entries)` is pure: it maps each known kind (user
text, assistant text + tool calls + usage + `provider/model` +
`thinkingLevel`, tool result with its `isError`, system instruction,
compaction summary, reset handoff), skips unknown kinds and payload-less
message entries, and returns the transcript in entry-id order whatever
order it was handed.
- `readConversationEntries(conversation, context)` reads a live harness
conversation's active context (the newest head marker and the entries it
keeps) — the trajectory capture path.
- `readSessionEntries(storage, context)` reads the same active transcript
straight from a session's pi-durable Storage: no harness, no model layer,
no writes. A session whose root conversation does not exist yet (a fresh
`sessions create`) reads as an empty transcript, never a throw. This is
the path CLI readers take, so a reader never opens what it may not run.

Pi seam: all pi-durable symbols come from `pi-boundary.ts` (§65); the
adapter adds only `ResetEntry` and `ROOT_CONVERSATION_ID` there.

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

Exactly one `subscribeLaneEvents` per conversation relays pi-durable's
committed watch (`watchEvents`, isolated here because upstream marks it
experimental), only to the §15 groups Kubic routes: run status, tool
status, usage, faults, plus retry and compaction. `KubicLaneEvent`
variants: `run-start`/`run-end` (`inputs: SubmissionId[]`),
`tool-start`/`tool-end` (`toolCallId`, `toolName`, + `args` / `isError` +
`entry?`), `usage` (`row: KubicUsageRow`, real provider/model from the
assistant entry, + `entry`), `fault` (`code`, `message`),
`retry` (`phase`, `attempt?`, `error?`), `compaction` (`phase`,
`reason?`), and `snapshot` — the attach / late-join / overflow path,
carrying the committed `entries`, live tools, retry, compactions and
`pi.usage`; a snapshot REPLACES the consumer's state, it never appends.

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
tests use fixture rows, never network or paid tokens. Since #398 the rows
are built by `usageRowFromEntry` from the committed assistant entry, so
`provider`/`model` are the ones that really answered (not the lane name or
the boot model — #287).

### Worker lifecycle (`lifecycle/`)

`WorkerRegistration` (`workerId`, `sessionId`, `generation`, `owner`,
`resources?`, `pid?`, `status?`); `WorkerRow` adds `startedAtMs`,
`ageMs` (+ `startupMs?`). Spawn env is allowlist-filtered
(`ENV_ALLOWLIST`, `filterSpawnEnv`, `roleCredentialEnv`,
`buildSpawnEnv`, `redactEnvForLog`); detached exits are reaped with a
1s teardown budget (`TEARDOWN_BUDGET_MS`).

A worker child reads its own provider credential back with
`roleGrantEnv`/`withRoleGrant` (issue #200): the `KUBIC_ROLE_<ROLE>_*`
grant is exposed under the plain provider-key names the models assembly
asks for, only for the role the child was told it runs as — a sibling
prefix never matches. The plain names exist only in the env view handed
to the models assembly for that read, never in the child's process env.

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
prints no marker. `KUBIC_WORKER_GENERATION` (the generation the row was
registered under) rides next to it, so the child's §46 trajectory records
the same generation `kubic workers` shows (issue #383). Registry rows persist to
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
                    pi-boundary.ts (worker Pi seam, §65)
```

Back to the [docs index](../README.md).
