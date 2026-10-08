# `@kubic/worker`

> The agent lane runtime; Pi boundary (CODEOWNERS-gated
> `src/pi-boundary.ts`).
> Source: `packages/worker/src`.

`@kubic/worker` is the agent runtime: the solo lane, tool adaptation,
Pi harness wiring, sessions, compaction and the failure taxonomy. All Pi imports flow through the worker Pi seam
`src/pi-boundary.ts` — `scripts/dep-lint.mjs` rejects
`@earendil-works/*` imports everywhere else in the worker (the TUI owns
the other seam, `packages/tui/src/tui-boundary.ts`), and CODEOWNERS flags
every diff touching the boundary for maintainer review.

## Public API (`packages/worker/src`)

| Module | Exports |
| --- | --- |
| `pi-boundary.ts` | Worker Pi seam (moved it to the Pi 1.0 surface). pi-durable harness: values `Harness`, `createRegistry`, `defineExtension`, `defineTool`, `wrapTool`, `hook`, `section`, `ToolTask`, `GenerationTask`, `CompactionTask`, `AgentDoc`, `LiveDoc`, `UsageDoc`, `configure`, `defineDoc`, the entry-kind tokens (`UserEntry`, `AssistantEntry`, `ToolResultEntry`, `SystemEntry`, `CompactionEntry`), `MemoryStorage`, `watchEvents`, `ConversationBusy`; types `Conversation`, `Submission`, `SettledSubmissionRecord`, `Extension`, `ToolRegistration`, `ToolExecutionApi`, `ToolHooks`, `HookRegistration`, `HarnessSettings`, `CompactionPolicy`, `AgentEvent`, `EntryRecord`, `Storage`; storage `openNodeJsonlStorage`. `@earendil-works/chord`: `Context`, `BACKGROUND_CONTEXT`, `JsonValue`. `@earendil-works/pi-durable/env`: `FileSystem`, `ExecutionEnv`, `Result`, `ok`, `err`, `FileError`, `FileErrorCode`, `FileInfo`, `FileKind`. Model layer (`Model`, `MutableModels`, `Usage`, `DeferredHandle`, `ModelThinkingLevel`, thinking clamp, providers, `Type`, the lazy `api/*.lazy` subpaths, `builtinProviders`) — each re-export carries a JUSTIFICATION block naming seam, user, why-Pi, and review, and the pi-boundary gate fails an export without one |
| `lane/solo.ts` | `SOLO_PROMPT_SECTION`, `SOLO_ROLE`, `assembleSoloPrompt`, `SoloPromptInput` (policy options: `spanHooks`/`contributions`/`classes`/`interceptors`; enterprise `toolAllowed`/`modelAllowed`), `SoloCompactionOptions`, `SoloBootOptions` (`session` is the handle, handed to the harness through `session.adopt()` so a `release()` cannot close a storage a live harness owns; `settings` excludes `compaction`/`extensions`, which the lane owns; the pre-1.0 `memos` option is gone — tool memos are pi-durable `api.memo`; `modelPolicy`/`onModelNotice`: a resumed lane keeps its stored model unless the selection is an explicit pin, which switches it; an unregistered stored model fails closed with `ModelSelectError` ), `SoloLane` (`harness`/`conversation`/`registry`/`kills`/`model`; `close()` closes the harness and leaves `session.release()` to the caller), `bootSoloLane` (installs the per-process registry `kubic.policy` → `kubic.spans` → `kubic` — install order is hook order), `splitSoloModelId`, `escalateSoloModel`. One turn is `conversation.submit(...)` → `submission.wait(...)`; `lane/turn.ts` owns the glue |
| `lane/events.ts` | `KubicLaneEvent`, `LaneEventSink`, `toKubicLaneEvent`, `subscribeLaneEvents` |
| `lane/failures.ts` | `FailureCode`, `RetryDecisionKind`, `ClassifiedFailure`, `classifyFailure`, `RetryHints`, `RetryDecision`, `RetryBudget`, `chooseRetry` |
| `lane/tools-adapter.ts` | `KubicToolContext`, `kubicToolsToPiTools` (registry schemas + json_schema/`prefer` constrained sampling), `renderGrepText` (plain-text results with a header; [tools](../cli/tools.md)). A successful `edit` or `write` also puts its display record in the result `details` — never in the model's text |
| `ops/display-diff.ts` | `displayDiff(before, after)` (Pi's display form: `+n` / `-n` / ` n` rows, 3 lines of context, `...` gaps, bounded LCS, 400 rows) and `writeDisplay(content)`; the ops report them through `OpContext.display` |
| `lane/interceptors.ts` | `PolicyInterceptorOptions`, `ApprovalCall`, `ApprovalAskVerdict`, `defaultIsDestructive`, `isNetworkCommand`, `confinePath`, `redactReason`, `redactSecrets` (broad redactor for summaries/block reasons: inline credential rules + the shared `@kubic/core` shape table), `policyInterceptorHooks` (ordered pi-durable `ToolTask.beforeTool` registrations; one call per boot — the attempt counter and the exact-call stand-down set (call id + args hash, spent after the call) live in that call, never across boots; first block wins, a throw blocks) |
| `lane/policy.ts` | `PermissionClasses` (re-export), `PolicyRefusedError` |
| `lane/session-store.ts` | `SessionStore`, `openSessionStore`, `KubicSessionMeta`, `KubicSessionDoc`, `SessionHandle`, `SessionListEntry`, `createSession`, `attachSession`, `listSessions`, `readSessionMetadata`, `forkSession` / `ForkSessionOptions` / `ForkSessionResult` / `SessionForkError` (a new session forked from an existing one), `laneConversationIdOf` (the conversation a session's lane runs — a fork's recorded `KubicSessionMeta.conversation`, else the reserved root; every transcript reader resolves it), `SessionAttachError`, `SessionFormatError`, `SessionIdError`, `SessionLockError`, `acquireSessionLock`, `releaseSessionLock`, `sessionLockIsLive`, `sessionsTouchingWorkspace` — session storage on pi-durable ([session storage](#session-storage-issue-392)) |
| `lane/session-fs.ts` | `bridgeToPiFileSystem` — the 1.0 `FileSystem` (19 members, `id`/`truncateFile`/`flushFile` included) over the exec file bridge |
| `lane/turn.ts` | `TurnOutcome`, `RunTurnOptions`, `runTurn`, `awaitTurn`, `turnAbort`, `turnAbortReasonOf`, `TurnAbort`, `turnLaneRecord`, `TURN_BUSY_REASON`, `SoloOverflowRecovery`, `OverflowRecoveryOptions`, `recoverSoloOverflowTurn`, `runTurnWithOverflowRecovery` — one turn is `conversation.submit({ type: 'input', … })` → `submission.wait(context)`; no Kubic-side loop, no sleep. The recovery wrapper retries exactly one failure — context overflow, compacted first and retried once |
| `lane/settle.ts` | `JsonValue`, `ResultStatus`, `ResultErrorKind`, `ResultError`, `OperationErrorLike`, `SettledResult`, `LaneTerminalStatus`, `SubmissionFailure`, `classifyHarnessError`, `classifySubmissionFailure`, `classifyThrownError`, `laneStatusOf`, `laneErrorOf`, `settleTerminalStatus`, `settleSubmission` — a settled pi-durable submission → Kubic's `ResultStatus`/`ResultError` and the failure codes |
| `lane/pending.ts` | `PendingPolicy`, `PendingReport`, `PendingSettlementResult`, `SettlePendingOptions`, `PendingLane`, `inspectPending`, `settlePending`, `describePendingSettlement`, `pendingInputText`, `inspectStoredWork` — settle a turn a crashed process left open (`harness.inspect()` decides, `resume` waits under the caller's guard, `abort` is durable) |
| `lane/abort.ts` | `KillFn`, `OperationKillRegistry`, `AbortableLane`, `LaneAbortResult`, `LaneDriveError`, `abortLane`, `forgetLaneKills` — `conversation.abort(context)` plus the conversation-keyed kill drain (every kill attempted, failures aggregated); `track()` returns the unregister fn its owner calls when the handle settles |
| `lane/transcript.ts` | `TranscriptItem`, `entriesToTranscript`, `readConversationEntries`, `readSessionEntries` — the one pi-durable → Kubic transcript adapter |
| `lane/test-harness.ts` | `bootFauxLane`, `runPrompt`, `laneEntries`, `laneToolResults`, `laneSystemPrompt`, `laneActiveTools`, `fauxToolUse`, … — the test-only faux SoloLane factory |
| `lane/wrap.ts` | `ExecuteFn`, `ToolContribution`, `composeTools`, `compositionOrder`, `PolicyDeniedError`, `withPermissionCheck`, `TelemetryRecord`, `withTelemetry` |
| `usage.ts` | `KubicUsageRow`, `formatCost`, `usageRowFromEntry` |
| `model-select.ts` | `ModelSelectError`, `ModelSelection`, `AnyModel`, `selectModel`, `parseModelFlag`, `EscalationLadder`, `escalateModel`, `supportedThinking`, `clampThinking` |
| `models-config.ts` | `CustomProviderSpec`, `ModelsJsonError`, `THINKING_LEVELS`, `isThinkingLevel`, `parseModelsJson`, `LOCAL_MODELS_EXAMPLE`, `registerCustomProviders` |
| `prompts.ts` | `PromptCacheError`, `SystemPromptInput`, `assembleSystemPrompt`, `TaskAffinity`, `pinModelForTask`, `taskModelForTurn`, `assertSingleModelId`, `ModelEscalationEvent`, `escalatePinnedModel`, `CompactionRoute`, `buildCompactionRoute`, `SessionCacheCounters`, `emptyCacheCounters`, `recordCacheUsage`, `cacheHitRate`, `SessionCacheStats` |
| `compaction.ts` | `DEFAULT_RESERVE_TOKENS`, `MAX_RESERVE_FRACTION`, `effectiveReserveTokens`, `SOLO_KEEP_RECENT_TOKENS` (20000), `SOLO_BACKGROUND_TOKENS` (0: Kubic's reserve threshold is the only trigger — no speculative background summary), `SoloCompactionSettingsOptions`, `soloCompactionSettings` (the harness `settings.compaction`; `reserveTokens` is a live getter clamped to the current model's window, so a model switch re-clamps with no explicit step), `SoloCompactionLane`, `compactSoloLane` (manual `/compact [focus]`; admits Pi's compaction task with Kubic's prompt as its instructions; **automatic** threshold/overflow compaction uses Pi's own summarization prompt, because pi-durable only accepts instructions through `compact()`, so Kubic's `buildCompactPrompt` reaches the manual path only), `parseCompactCommand`, `CompactPromptInput`, `buildCompactPrompt`, `FileOpKind`, `FileOp`, `CumulativeFileOps`, `emptyFileOps`, `accumulateFileOps`, `StructuredSummary`, `formatStructuredSummary`, `TruncatedToolOutput`, `SpillArtifact`, `resolveTruncatedOutput`, `buildSpillArtifact`, `passThroughOutput`, `CompactedState` (the `buildCompactedState` constructor was deleted) |
| `approval-client.ts`, `session.ts`, `tools.ts` | Pointer | Approvals decider in `@kubic/host` `approvals.ts` + `lane/interceptors.ts`; sessions in `lane/session-store.ts`; tools in `lane/tools-adapter.ts` |
| `ops/` | Implemented | Operation implementations (read/write/edit/bash/git/…) + registry |

### Output bounds

Child output is capped at two independent layers, both keeping the **tail**
(endings usually carry the error) and naming exactly what was dropped:

- **Seam (memory):** `NodeShell` accumulates at most `MAX_CHILD_OUTPUT_BYTES`
  (10 MiB) per stream — `env.ts`, overridable per spawn via
  `SpawnOptions.maxOutputBytes`. A chatty child (`yes`, a verbose build) can no
  longer OOM the run; the settled stream gains a
  `[kubic: output truncated — dropped N leading bytes, kept the last M]`
  header. Both numbers are **bytes of the decoded stream** —
  invalid UTF-8 arrives as U+FFFD and costs 3 bytes, so a binary-producing
  child is capped conservatively: the accumulator measures
  `Buffer.byteLength` per chunk and trims on a **code-point boundary**, so
  CJK or emoji output cannot admit 3-4x the promised memory the way a
  UTF-16 code-unit count did, and the kept tail can never start with half a
  surrogate pair (a lone low surrogate would reach the model, the
  trajectory and the session store as U+FFFD). A code point that does not
  fit is dropped whole, so the tail is at most the cap and may be shorter.
- **Op (context window):** `bash` clips each stream to
  `BASH_RESULT_MAX_CHARS` (64 K chars) in the result the model sees, with a
  `[kubic: N leading chars dropped]` header and `truncated: true` on
  `BashResult` — the model knows it saw a slice. The registry's
  never-replay memoization stores the clipped result, so retries are
  consistent.
| `index.ts` | Pointer | No barrel — import per-module paths |

### Find/grep walk bounds

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

### Grep bounds

`grep` reads and returns under three bounds, all in `ops/grep.ts`:

- **`GREP_MAX_LINE_LENGTH` (500, / Pi's constant):** match text is
  clipped, `linesTruncated: true` marks it, and the rendered header says
  `lines clipped at 500 chars`. Clipping is not truncation — every match is
  still reported, so `truncated` stays false — but a partial line read as a
  whole one is a wrong answer, which is why the flag rides the header.
- **`GREP_MAX_FILE_BYTES` (8 MiB, the text bound read and edit share):** the
  file is `stat`ed and, when over the bound, never opened; the count lands in
  `skippedOversized`. Unlike a binary skip this marks the result `truncated`
  with a notice naming the bound: an unsearched text candidate can hide
  matches, so the model has to know the search was partial.
- **`GREP_RESULT_MAX_BYTES` (51200, read's output cap / Pi's
  `DEFAULT_MAX_BYTES`):** matches are appended while the rendered
  `path:line: text` line fits; the search stops at the last whole line and
  the header names `output cap 51200B reached`.
- **Binary files (a NUL byte anywhere in the decoded content) are skipped
  and counted** in `skippedBinary`. That is narrower than read's sniff
  (which also refuses a first chunk that is not valid UTF-8): grep does not
  pay a second read for the validity check, so a NUL-free invalid-UTF-8
  file is still searched. This is the documented contract (binaries are
  never text-matched), so it counts without flipping `truncated`. Entries
  that are not regular files (FIFO, socket, device) are skipped too —
  reading a FIFO could block the run — without a count, since they are not
  text candidates at all.

`include` stays a path substring test — pinned in the tool schema and the
operation description (`ops/grep.test.ts`), not turned into a glob.

### Bash op: bash-preferred, sh fallback

The `bash` op runs **bash when the system has it** — not `sh`, so
bashisms (`[[ ]]`, `local`, arrays) work wherever bash exists. Resolution
is lazy and cached per process: the first command attempts `bash`, and a
spawn that settles exit 127 with Node's `spawn <name> ENOENT` message
line (the `env.ts` ENOENT hardening is what puts that
message in stderr — user output never matches) degrades once to `sh` and
remembers — a single detect-and-retry inside
`execute()`, before the registry memoizes under `op-result-bash`, so a
retried command memoizes exactly once. Detection and execution both go
through `ctx.env.shell` — no `child_process` in ops, `FakeExecutionEnv`
scripts the answer. The Windows `cmd /d /s /c` path is unchanged.

`BashResult.shell: 'bash' | 'sh' | 'cmd'` names what actually ran. The
retry handle is re-registered via `ctx.trackHandle` so
timeout/abort kill whichever handle is live, and the settled one is
**untracked** again: `OperationKillRegistry.track` returns the
unregister fn the op calls once `wait()` settles, because a lane reuses one
registry for a whole session — a handle left per completed call kept that
call's output alive for the life of the run. `kill()` on a settled handle is
a no-op, and a group SIGKILL escalation is scheduled only when the leader
was still alive at kill time (a leader that already exited has had its pgid
recycled; the group itself lives while any member does, which is why the
SIGTERM is still sent).
The test seam
`__setResolvedShellForTests` (exported from `ops/bash.ts`, never
re-exported) pins or resets the per-process resolution.

A clipped stream spills its full text by path:
`clipStream` bounds each stream to its last `BASH_RESULT_MAX_LINES` (2000,
pi-durable's `DEFAULT_MAX_LINES`) and its last `BASH_RESULT_MAX_CHARS`
(64 KiB), writes the untruncated stream through `OpContext.spill` — the
session-scoped sink the lane builds from its session directory
(`createSessionSpillSink`, `spill.ts`, one 0600 file per clipped stream under
`<sessionDir>/spill/`, named `<n>-<stream>-<pid>.log`) — and names the path in the header
(`[kubic: N leading chars dropped — full output: <path>]`) and in
`BashResult.spillPath`. A name is never reused for the life of the session —
the counter starts after the highest index already in `spill/`, so a resumed
session cannot truncate a file an earlier tool result still names. Because the
files live inside the session directory,
`kubic sessions prune`'s one recursive remove takes them with the session and
nothing lands in the workspace (where the end-of-run sweep would journal it)
or in `$TMPDIR`. No sink (tests, journal-free contexts) or a sink that throws
leaves the header without a path; the call never fails over a spill.

The op also bounds a call in time: with no `timeout` the command
gets `BASH_DEFAULT_TIMEOUT_SEC` (120 s), any timeout is clamped to
`BASH_MAX_TIMEOUT_SEC` (600 s), and processes the command backgrounded are
killed when it exits unless `KUBIC_BASH_KEEP_BACKGROUND` opts in. Both limits
and the model-facing description come from those constants; the user-facing
statement is in [tools](../cli/tools.md#bash-limits).

### Read/edit bounds

Two hard bounds keep one tool call from costing the whole file in memory
(the journal has hashed bounded; the ops now match):

- **`read` — `READ_MAX_BYTES` (8 MiB) of I/O, `READ_CHUNK_BYTES` (512 KiB)
  per buffer:** with a ranged-read seam (`FileSystem.readFileRange` — 's file-bridge seam extended to `ExecutionEnv`), `readWindowed` seeks to the
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
  `fs.readFileRange` as a method (the real `NodeFileSystem` reads `this.cwd`), and `read` names the actual failure: a missing path
  is `not_found`, a directory `is_directory`, an unreadable file
  `permission_denied`, a cwd-confinement escape `invalid_args`; any other
  error propagates as a fault instead of masquerading as a missing file.
- **`edit` — `EDIT_MAX_BYTES` (8 MiB):** `stat` first and refuse above the
  bound with a named `file_too_large` OpError (op failure-code vocabulary,
  `ops/types.ts`) naming the size — before any content allocation, journal
  untouched. The boundary is exact: 8 MiB edits fine, 8 MiB + 1 refuses.
- **`read` output bounds:** the scan bound above is
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
  (NB, …)` notice — the sniff only MARKS the window, so the scan
  contract is unchanged. `ReadResult` only gains fields; nothing is
  renamed.

The reason for both: `read` capped only its output and `edit` capped
nothing, so `read` with `limit: 1` or one `edit` on a multi-GB file cost the
whole file in memory (plus its UTF-8 decode) on a path the model triggers
with a single tool call. Text ops stay text; for oversized files the
refusal names targeted shell tooling as the actionable alternative.

### Edit line endings and BOM

`edit` (`ops/edit.ts`) normalizes before matching and restores on write,
following Pi's `edit-diff.ts` shape with three deliberate deviations from
the installed Pi 1.0.2 (`edit-diff.js`, `tools/edit.js`), so nobody
"aligns with Pi" later and reintroduces the `no_match` this issue fixes:

- `detectLineEnding` takes the **dominant** ending (Pi takes the first
  line's), which is what the issue asks for; a tie goes to LF.
- `normalizeToLF` folds **`\r\n` only**, not Pi's lone `\r` as well: an
  old-Mac file keeps its bytes rather than being silently rewritten.
- The model's `oldText`/`newText` are BOM-stripped too (Pi strips only the
  file body): Kubic's `read` keeps the BOM, so a needle copied from the
  first line carries it and must still match.

Beyond that:

- `detectLineEnding` counts CRLF against bare LF and takes the dominant one
  (a tie goes to LF); `normalizeToLF` puts the file body, `oldText` and
  `newText` into LF space for `countOccurrences`/split/join; `restoreLineEndings`
  puts the file's own ending back on the written content. Without it a CRLF
  file with an LF multi-line `oldText` was `no_match` and a partial match
  could mix endings. `newText` is normalized too, so a replacement that
  carries CRLF can never come out as `\r\r\n`.
- `stripBom` removes a leading U+FEFF from the file body and from both model
  texts, and the write re-adds one only when the file had it — a first-line
  edit in a BOM file succeeds, the BOM is preserved, and a replacement can
  never introduce a second one. A needle that normalizes to nothing is
  refused (`invalid_args`), since an empty match would match everywhere.
- `expectCount` counts on the normalized text. The journal keeps the real
  pre-image and the real written content (BOM and endings included), so
  `edit`'s `afterHash` describes the file on disk and `kubic undo` restores
  a CRLF/BOM file exactly.

The regression suite is `packages/worker/src/ops/edit.test.ts` (CRLF
multi-line replace, CRLF needle and replacement, BOM first line, BOM in the
needle, no second BOM, empty-after-normalization refusal, `expectCount` on
normalized text, LF unchanged, undo round-trip).

### Write pre-image bound

`readPreImage` (`ops/atomic-file.ts`) never holds a file it cannot bound.
Above `PREIMAGE_MAX_BYTES` (8 MiB, the text bound read and edit share) the
bytes are streamed through the sha256 one `PREIMAGE_CHUNK_BYTES` (4 MiB)
chunk at a time and the pre-image is recorded hash-only (`text: null`, so
`write` sets `beforeOmitted: true` alongside the digest). The digest is over
the raw bytes on both paths, so it is identical either way; what changes is
memory: overwriting a 1.5 GB file used to allocate roughly 3x its size
(buffer + decode + re-encode lossless check) and journal the content
verbatim — one `write` call away from OOMing the worker — and now costs one
chunk. Undo reports the step non-reversible exactly as it does for a binary
pre-image: it skips the entry (`non-reversible (skipped)`) instead of
inventing content. `edit` is unaffected — it refuses above `EDIT_MAX_BYTES`
before calling `readPreImage` — and a seam without `readFileRange` (a test
double) keeps the whole-file fallback.

### Write/edit symlink safety

`write` and `edit` share `replaceFile` (`ops/atomic-file.ts`), the
journal-first tmp+rename writer. It now follows symlinks instead of
replacing them: the target is resolved (`FileSystem.realpath`, resolving
the nearest existing prefix and appending the components a create has yet
to make), the tmp is written **beside the resolved file** and renamed onto
it, and the journal records the **resolved path** (workspace-relative) in
that case. That keying matters beyond display: the end-of-run sweep keys
entries root-relative and the walk skips symlinks, so recording the link
path made one symlinked edit produce two phantom entries — an unattributed
`write <target>` (the target really changed) and a `delete <link>` (the walk
never listed it) — and `undo` renamed onto the link, replacing it. With the
resolved path the sweep adds nothing, and undo restores the target with the
link intact. A resolved target outside `ctx.env.cwd` — a link, or a
symlinked directory above the path, however the workspace root is spelled
(its own `realpath` counts as inside) — is refused with a named
`symlink_escape` OpError before the journal append. A `realpath` failure
that is not a missing component (`EACCES`, `ELOOP`) is treated as
unresolvable: the writer falls back to the named path and the seam's
confinement rather than guessing a resolved one. The tmp carries a pid- and
call-unique name (`<target>.kubic-tmp-<pid>-<n>`, so two writers cannot
collide), residue at that name is swept before the write, and the tmp is
removed best-effort through `FileSystem.unlink` when the write, chmod or
rename fails — the earlier fixed-name tmp leaked into the workspace and the
next sweep journaled it as an unattributed create. Both new seam members
are optional (test doubles have no links and no cleanup) and
`withReadRoots` forwards them, or a run with skill roots would leak the
tmp. A dangling link has no target to resolve, so the write replaces the
link itself, as before.

### Session storage

One pi-durable `Storage` per session, at `<sessions-root>/<id>/` — the same
directory that already held the journal, spans, approvals posture and lock,
and now the `spill/` directory of (bash output too large for the
model's context window; removed with the session by `kubic sessions prune`).
The storage is opened over the exec file bridge (`bridgeToPiFileSystem`), not
through pi-durable's Node entry point: session bytes keep crossing the I/O
seam, so the secret scrubbing and the file modes apply to the
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
change journal stays Kubic's fsync'd store: that is where "this
change can be undone" is guaranteed.

Session state is private:
the session directory and the sessions root are 0700, and the JSONL files, the
`session.json` header, the lock file and the stored thinking level are created
0600 through the same bridge calls the port uses (the mode is applied at
creation only — an existing file keeps its own). An existing loose directory is
tightened when the next session lock is taken, and `kubic doctor`'s
`state:permissions` check names one that is still loose.

**Legacy sessions (Pi 0.87).** A transcript written by the removed
`JsonlSessionRepo` lives at `<root>/--<cwd>--/<ts>_<id>.jsonl` with a
format-4 header. There is no converter (the repo is unreleased):
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

### Session locking

One live attachment per session, fail-closed. `createSession` (before the
storage is created) and `attachSession` (before the storage is opened)
acquire `<sessions-root>/<session-id>/lock.json` — a
`{pid, startedAt, procStart?, nonce?}` record of the attaching process
(`startedAt` is when the lock was taken, `procStart` the holder process's
own start time for the pid-reuse guard, `nonce` the
per-attempt unique that makes the post-write verification exact) — through
the exec-owned lock-file primitive (`exec/lock-file.ts`; I/O confinement): an O_EXCL (`writeFileSync(…, {flag: 'wx'})`) create is the atomic
test-and-set, and the primitive makes the session dir eagerly as the
lock's parent. `handle.release(…)` releases the lock, so the file exists
only while a session is actually attached.

The lock is the ONLY guard around a storage open: pi-durable
states that one process owns a storage at a time and provides no
cross-process locking, so every open in this module happens with the lock
already held.

- **Refusal** is `SessionLockError`; its message names the session and
  the holder's pid + start time. Host maps it to `workspace_unavailable`
  (exit 5) on `kubic run`; `kubic sessions attach` prints it and exits 1
  without reading the transcript.
- **Stale steal** (never a steal of a live lock): a holder whose process
  is gone (`process.kill(pid, 0)` fails) is stale immediately — crash
  recovery works same-day. There is NO age rule: a days-old lock with a
  live, matching holder is a long TUI session, never stale. Pid reuse is
  caught by the process-start check instead: the lock records the holder's
  own start time (`/proc` on Linux; `processStartTimeOf`), and
  a live pid whose start moved is a recycled number, so the lock is stale.
  Locks without a recorded start (legacy shape, or a platform without a
  start-time source) fall back to the pid probe. An unparseable/torn
  `lock.json` is a stale candidate. The takeover lands through a temp
  file + hard-link claim (`claimLockLink`: exactly one racer lands per
  generation), clears only the stale occupant it judged, and re-reads to
  verify the owner is this attempt. A steal that loses surfaces as
  `SessionLockError`, never a crash.
- **Owned release**: `releaseSessionLock` removes only a lock naming this
  process — another process's lock is left alone. A refused attach or a
  failed create therefore releases safely: what they never owned, they
  never delete.
- **Local filesystem only.** O_EXCL atomicity is claimed on local
  filesystems only — no network/shared-disk (NFS/SMB) locking semantics
  are provided or tested.
- **Read-only liveness view**: `sessionLockIsLive(sessionDir)`
  reports `{pid, startedAt}` while the holder pid is alive — the rail
  `kubic sessions prune` reads before it would ever delete a session. It is
  deliberately stronger than the steal rule above (any live holder pid
  protects, regardless of the lock's age): deletion is unrecoverable, so a
  reused pid costs at most a skipped prune. A dead holder — or a
  torn/absent payload — never protects. Liveness is this machine's process
  table, local filesystem only, like every lock read here.
- **Repo-level overlap — warning only** (blind spot). A
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

### Session transcript (`lane/transcript.ts`)

One adapter turns a session's durable entries into Kubic's
`TranscriptItem` vocabulary. Pi 0.87 stored a tree of
`{id, parentId, type: 'message', message}` entries; pi-durable stores
typed records (`pi.user`, `pi.assistant` with `model: [AssistantMessage]`,
`pi.tool-result`, `pi.system`, `pi.compaction`, `pi.reset`), so every
reader — `kubic sessions attach`, the run-envelope usage, the
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

Pi seam: all pi-durable symbols come from `pi-boundary.ts`; the
adapter adds only `ResetEntry` and `ROOT_CONVERSATION_ID` there.

## Contracts

### Lane events + failures (`lane/events.ts`, `lane/failures.ts`)

Exactly one `subscribeLaneEvents` per conversation relays pi-durable's
committed watch (`watchEvents`, isolated here because upstream marks it
experimental), only to the groups Kubic routes: run status, tool
status, usage, faults, plus retry and compaction. `KubicLaneEvent`
variants: `run-start`/`run-end` (`inputs: SubmissionId[]`),
`tool-start`/`tool-end` (`toolCallId`, `toolName`, + `args` / `isError` +
`entry?`), `usage` (`row: KubicUsageRow`, real provider/model from the
assistant entry, + `entry`), `fault` (`code`, `message`),
`retry` (`phase`, `attempt?`, `error?`), `compaction` (`phase`,
`reason?`), `message-delta` (`text`: the in-flight generation's streamed
text; a whole-message or thinking-only batch maps to nothing),
`entry` (`entry`: a committed non-assistant message end — a user turn, a
compaction summary, a reset handoff — so the transcript folds it
live), `inbox` (`items`: the conversation's queue), and `snapshot` —
the attach / late-join / overflow path,
carrying the committed `entries`, live tools, retry, compactions and
`pi.usage`; a snapshot REPLACES the consumer's state, it never appends.

`FAILURE_CODES`: `model_failed`, `model_refused`,
`provider_transient`, `provider_auth`, `tool_failed`,
`tool_invalid_args`, `tool_timeout`, `tool_unavailable`,
`process_crashed`, `process_spawn_failed`, `workspace_failed`,
`context_overflow`, `context_polluted`, `run_limit`,
`approval_denied`, `approval_timed_out` — pinned equal with the
[trajectory](trajectory.md) snapshot by test. `RETRY_STRATEGIES`:
`retry_same`, `retry_with_new_context`, `retry_with_new_agent`,
`retry_with_stronger_model`, `retry_with_different_tool`,
`retry_with_wider_capability`; decisions add `escalate`/`abandon`, and
retries are bounded by `RetryBudget`.
Emitted by `classifyFailure`: `retry_same` (executed by the
harness's durable generation retry — Kubic never relaunches it),
`retry_with_different_tool`, and `retry_with_new_context` (solo
compact-then-retry). Pollution escalates (the operator picks the fresh
agent); `run_limit`/`approval_denied` abandon and spend nothing.
`retry_with_stronger_model` / `retry_with_new_agent` are part of the
vocabulary but never chosen automatically — the operator switches the
model or starts a fresh session; `retry_with_wider_capability` only ever
arises through an explicit approval, never from the chooser. `RetryBudget(maxAttempts,
maxCostUsd)` binds both arms (attempts AND reported retry spend; the
turn's own spend never counts). Solo overflow
recovery (`recoverSoloOverflowTurn` / `runTurnWithOverflowRecovery` in
`lane/turn.ts`, live on the headless path): compact via
`runManualCompaction`, then one retry with a fresh request id; a
compaction that did not cut abandons with the original failure.

### Usage (`usage.ts`)

`KubicUsageRow` is `{ model, provider, usage: Usage (Pi type),
toolCallId?, entryId? }`. `usageRowFromEntry` builds the rows from the
committed assistant entry, so `provider`/`model` are the ones that really
answered (not the lane name or the boot model). The roll-up surface is
`kubic cost --session <run>`. Rows carry no timing: Pi 1.0 reports none
Kubic can read.

## Dep-direction neighbours

- May import: [@kubic/core](core.md), [@kubic/exec](exec.md),
  [@kubic/agents](agents-pkg.md) (+ trajectory/eval shapes as
  snapshots where pinned) — never host/tui.
- Imported by: [@kubic/host](host.md) (runtime wiring).
- Never imported by [@kubic/trajectory](trajectory.md): trajectory imports
  nothing but core — it records structural snapshots pinned by the golden
  fixture test, never a live import.
- Pi seam: `pi-boundary.ts` only.

```text
core + exec + agents ──→ @kubic/worker ──→ host
                              ↑
                    pi-boundary.ts (worker Pi seam)
```

Back to the [docs index](../README.md).
