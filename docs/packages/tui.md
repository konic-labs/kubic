# `@kubic/tui`

> Facet split: the TUI never imports host/worker implementation
> (contracts come from core only).
> Source: `packages/tui/src`.

`@kubic/tui` is presentation only: layout and views over the
[@kubic/core](core.md) `KubicPresentationState`. It must import contracts
from `@kubic/core` and never `@kubic/host` or `@kubic/worker`
implementation — enforced by `scripts/dep-lint.mjs`. All Pi
presentation imports flow through `src/tui-boundary.ts`, the
TUI-side analogue of the worker Pi boundary.

## Public API (`packages/tui/src`)

| Module | Exports |
| --- | --- |
| `tui-boundary.ts` | Sole presentation seam: re-exports `Component`, `Focusable`, `MouseRegionHandler`, `StackEntryOptions`, `Terminal`, `TUI` (types) and `CURSOR_MARKER`, `Editor`, `Markdown`, `MouseRegion`, `matchesKey`, `ScrollView`, `Text`, `TuiAltScreen`, `VStack` (values) from `@earendil-works/pi-tui`, each with a JUSTIFICATION block |
| `layout.ts` | `Viewport`, `LayoutSlots`, `NARROW_COLUMNS`, `buildLayoutRoot`, `renderLayout` |
| `screen.ts` | `Screen`, `bootScreen`, `KubicAltScreen` (Pi's alt-screen with a `baseFilter` run over the base frame before the overlays are composited — the dimmed background) |
| `status-bar.ts` | `StatusUsageCost`, `StatusUsage`, `StatusUsageRow`, `StatusSummary`, `summarizeStatusRows`, `formatStatusCost`, `StatusBarState`, `StatusBarTheme`, `DEFAULT_STATUS_THEME`, `statusVisibleWidth`, `renderStatusLines`, `StatusBarOptions`, `StatusBar` |
| `transcript.ts` | `TranscriptEntryKind`, `TranscriptEntry`, `TranscriptDelta`, `LaneIdentity`, `TranscriptSnapshotOp`, `TranscriptDeltaOp`, `TranscriptOp`, `TranscriptView`, `createTranscriptView`, `replayTranscript`, `TranscriptBlockKind`, `TranscriptBlock` (block mode: `blocks`, `select`, `toggleBlock`, `blockLines`, `reveal` on the view) |
| `tree.ts` | `RunStatus`, `ToolCallState`, `rootGlyph`, `toolGlyph`, `TreeToolCall`, `TreeUsage`, `TreeTurnSummary`, `AgentTreeState`, `createTreeState`, `toggleTree`, `TreeToolSnapshot`, `TreeLaneSnapshot`, `applyTreeSnapshot`, `collapsedSummary`, `formatTreeTokens`, `renderTreeLines`, `TreeMouseEvent`, `TreeMouseResult`, `TreeViewOptions`, `AgentTreeView` |
| `editor-view.ts` | `EDITOR_FALLBACK_ROWS`, `editorTheme`, `PromptEditor` (Pi `Editor` behind the seam: Enter submit, multi-line entry, history, focus forwarding, `insertText` at the cursor) |
| `lane-cells.ts` | `LaneEntryLike`, `PROMPT_PREFIX`, `TOOL_CALL_PREFIX`, `TOOL_RESULT_MAX_CHARS`, `TOOL_DETAIL_MAX_CHARS`, `TOOL_OUTCOME_MAX_CHARS`, `sanitizeLaneText`, `summarizeToolArguments`, `summarizeToolOutcome`, `entriesToCells` — committed lane entries → coarse transcript cells; every cell's text (user, assistant, tool result, tool name) is sanitized here so model-supplied content cannot drive the terminal. `sanitizeLaneText` strips complete ECMA-48 sequences (CSI, OSC, C1 CSI, 2-byte ESC forms — not just the ESC byte), collapses carriage-return overwrites to the text after the last `\r`, expands tabs by visible column width, and drops the remaining C0/C1 controls |
| `tui-app.ts` | `TuiAppSeed`, `TuiInputResult`, `TuiApp`, `createTuiApp`, `seedFromPresentation` — the global keys (Ctrl-C/Esc/Ctrl-D/Ctrl-T) are classified through Pi's `parseKey` (see `tui-boundary.ts`), so both legacy-byte and Kitty CSI-u encodings are honoured |
| `diff-view.ts` | `DiffOp`, `DiffFileChange`, `DiffRenderOptions`, `isBinaryText`, `unifiedHunks`, `renderDiffHeader`, `renderDiffLines` (pure render functions; the panel owns the document and its scrolling) |
| `approval-view.ts` | `ApprovalAction`, `ApprovalViewRequest`, `ApprovalDecision`, `APPROVAL_MIN_WIDTH`, `ApprovalOverlayOptions`, `approvalOverlayOptions`, `ApprovalOverlayBounds`, `approvalOverlayBounds`, `APPROVAL_PAGE_KEY`, `APPROVAL_DEFAULT_KEYS`, `APPROVAL_ARMING_MS`, `APPROVAL_QUIET_MS`, `APPROVAL_REPEAT_MS`, `APPROVAL_IMMEDIATE_KEY`, `ApprovalKeyOverrides`, `resolveApprovalAction`, `resolveApprovalKey`, `isProseKey`, `approvalKeyProblems`, `ApprovalKeyConflict`, `approvalKeyConflicts`, `ApprovalOverlayHandle`, `ApprovalOverlayTui`, `ApprovalDecisionStore`, `MemoryApprovalDecisionStore`, `ApprovalMemo`, `createApprovalMemo`, `ApprovalWaitOptions`, `waitForApproval` |
| `approval-card.ts` | `APPROVAL_COMMAND_PAGE_LINES`, `wrapByColumns`, `approvalReason`, `ApprovalCardOptions`, `renderApprovalCard` (the inline approval card) |
| `block-viewer.ts` | `BlockViewerOptions`, `BlockViewer` (one transcript block whole in a framed, scrolling overlay with copy and close) |
| `preflight.ts` | `PreflightInfo`, `renderPreflight` (the first screen: wordmark, PREFLIGHT rows, START keys, RECENT sessions), `renderNoKeyPreflight` (the no-key block printed before exit 6) |
| `picker-view.ts` | `PickerViewOptions`, `PickerView` (every "choose one" overlay — model, session, theme, thinking, prompt — over `ui/picker.ts`, Pi's `Input` for the filter) |
| `palette-view.ts` | `PaletteViewOptions`, `PaletteView` (the ^P overlay: Pi's `Input` for the query, `ui/palette.ts` for the rest) |
| `journal-view.ts` | `JournalFilter`, `filterJournalChanges`, `renderJournalLines`, `JournalViewOptions`, `JournalView` |
| `views.ts`, `components.ts` | Pointer | View assembly lives in `layout.ts` / `*-view.ts` / `tui-app.ts`; no shared or aggregated module |
| `index.ts` | Pointer | No barrel — import per-module paths (`tui-boundary.js` seam + views); `tui/` stays presentation-only |

## UI kit (`packages/tui/src/ui`)

Pure render helpers every new surface is drawn with, over the
shared design tokens (`packages/core/src/ui`, `docs/ui/README.md`): each takes
a `UiTheme` (`tuiTheme().ui`) and returns strings — plain text at colour
depth `none`, so snapshots stay readable.

| Module | Helpers |
| --- | --- |
| `ui/line.ts` | `fitLine` (cut with `…`, plain text stays escape-free), `padTo`, `exactWidth`, `leftRight` (right part keeps its room) |
| `ui/surface.ts` | `fillLine` / `surfaceLines`: a background role edge to edge, kept through nested styles |
| `ui/frame.ts` | `frameLines` (`┌─┐` box, heavy `┏┃┗` card or bare rules; title and right label in the top rule), `frameInnerWidth` |
| `ui/marks.ts` | `badge` (inverse accent/waiting/ok/error cells, `[TEXT]` without colour; `key` caps), `gauge` (warn at 80%, err at 100%), `sectionLabel`, `rule` |
| `ui/key-hints.ts` | `renderKeyHintRow`: keys fg1, labels fg2, whole hints dropped from the end when narrow, a right-aligned hint |
| `ui/match.ts` | `fuzzyPositions` (contiguous run, else word starts) and `highlightPositions` (matched runs styled, the rest optionally too) |
| `ui/palette.ts` | the ^P palette: `PaletteItem`/`PaletteState`, grouping and ranking with Pi's `fuzzyMatch` (`paletteGroups`, `paletteRows`, `paletteResultCount`), navigation (`movePalette`, `cyclePaletteGroup`, `togglePaletteDetails`, `setPaletteQuery`, `setPaletteItems`), `renderPalette`, and the row helpers `paletteModelMeta`, `formatContextWindow`, `formatAge` |
| `ui/picker.ts` | the grouped picker list: `PickerRow`/`PickerGroup`/`PickerState`, `PICKER_FOLD_ROWS`, `createPicker`, `setPickerQuery`, `movePicker`, `onExpandRow`, `expandPickerGroup`, `selectedPickerRow`, `renderPicker` (headers with a key status, greyed disabled groups and rows, folding, a footer row) |
| `ui/clipboard.ts` | `CLIPBOARD_MAX_BYTES`, `copySize`, `osc52` (tmux passthrough), `formatSize`, `clipboardSupported` — block mode's copies |
| `ui/dim.ts` | `dimLine` / `dimFrame`: a row without colours, links or markers in fg3; a frame dimmed but for its key-hint row |

Widths always come from Pi's grapheme-aware helpers through
`tui-boundary.ts`, never `string.length`.

## Contracts

### Layout (`layout.ts`)

VStack root, rows in order:

| Row | Slot | Sizing |
| --- | --- | --- |
| *one-row header* (`chrome.ts`) | `header` | basis 1 |
| `AgentTreeView` | `tree` | auto, at most `TREE_MAX_ROWS`; hidden below 80 columns and while `treeVisible()` is false |
| ScrollView transcript | `transcript` | grow 1, follow-end |
| *diff / journal panel* | `panel` | basis 12 while open |
| *notice row* | `notice` | auto — no row when empty |
| editor | `editor` | auto |
| one-row status line | `status` | auto |
| *key-hint row* | `hints` | auto |

`Viewport` is `{ width: number, height: number }` (matches Pi's
`LayoutViewport` without importing layout internals through the seam);
`NARROW_COLUMNS` is 80 (the tree hides below it — proven by the narrow
snapshot test); `renderLayout(root, width)` renders headless (pure, no
terminal). Slots are `Component`s; this module owns arrangement only.

### Markdown, highlighting and file links

`markdownThemeFor(theme)` maps Pi's `MarkdownTheme` onto the tokens and
plugs `ui/highlight.ts` into its `highlightCode` hook: lowlight's scopes on
calm roles (keywords fg0 bold, strings add, numbers warn, comments fg2
italic, titles info, types fg1), the grammars loaded once by
`loadHighlighter()` at TUI boot, plain beyond `HIGHLIGHT_MAX_LINES` /
`HIGHLIGHT_MAX_CHARS` or on any error. `ui/file-links.ts`
(`linkFileReferences`, `fileUrl`) rewrites project paths into markdown links
through Pi's `transform` option — only when `getCapabilities().hyperlinks`,
so Pi emits OSC 8 instead of printing the URL; the app resolves paths
against `TuiAppSeed.listFiles` + `fileRoot`.

### Editor frame (`editor-frame.ts`)

`frameEditorLines(ui, lines, width, options)` closes Pi's editor into the
kit box (`┌─┐ │ › … │ └─┘`): the editor renders at
`width - EDITOR_FRAME_CELLS`, its two rules are found by `RULE_MARK` (a
zero-width APC marker the editor theme puts on them, stripped by the frame),
autocomplete rows stay below the box, and `CURSOR_MARKER` passes through.
Idle, the caret is accent bold and the first line carries the `@ file  / cmd`
hint while it fits; mid-turn it is a queue box (fg2 caret, italic
placeholder). `renderWorkingLine(ui, info, width)` is the line above it while
a turn runs (`⠹ Working · 0:12 · ↑ 9.2k ↓ 640 tok · 3 tools … esc interrupt
⏎ queue a message`).

### Chrome (`chrome.ts`)

`renderHeader(ui, info, width)` is the one-row header
(`■ KUBIC │ <project> ⎇ <branch> ●<dirty> … session <title> │ approvals on
│ HH:MM`, on bg1) with its drop ladder (clock, session, approvals when on,
branch; the project name is cut last; `approvals OFF` never drops).
`keyHintSet(context, keys, options)` returns the hint row for `idle`,
`working`, `approval` or `overlay`, built from the key registry
(`keyCap('ctrl+p')` is `^P`); `sessionTitle`, `shortSessionId` and
`formatClock` produce the header's session and clock text. The app
(`tui-app.ts`) takes the workspace facts, the clock and the per-mode lane
notice from its seed (`workspace`, `clock`, `laneNotice`) and
`setWorkspace`; the composition root reads git through the exec seam
(`apps/kubic/src/tui-workspace.ts`).

### Views

- **Status line** (`status-bar.ts`): one row.
  Usage/cost rollups (`StatusUsage`,
  `StatusUsageRow`, `StatusUsageCost`, `StatusSummary`,
  `summarizeStatusRows`, `formatStatusCost`) feed `StatusBarState`, rendered
  by `renderStatusLine(state, width, ui, now)`: `● model · thinking │ ctx
  gauge NN% of <window> │ cost │ journal N changes` and the
  `StatusTurnState` word (`ready`, `working`, `needs approval`,
  `cancelling…`, `error`) on the right; the `StatusBar` component reads the
  live turn facts through its `live` option. The state also holds the
  approvals posture, which the header renders. The TTFT and tool-ms
  segments were deleted (Pi 1.0 routes no timing Kubic could read),
  and `kubic tui --session` seeds the rows from the session's `pi.usage`
  ledger before the first frame. the context gauge shows when
  `StatusBarState.contextWindow` is known and a committed request reported
  its prompt size (`StatusSummary.contextTokens`) — warning-coloured at or
  above `StatusBarState.compactionThreshold`.
- **Transcript** (`transcript.ts`): `TranscriptEntryKind` is
  `prompt|text|tool|output|compaction|thinking|receipt` (a `thinking` cell collapses to `⋯ thought for 4.1s — <first sentence>`; a `receipt` cell is the app's per-turn `TurnReceipt`, merged before the next committed prompt and never stored); `TranscriptView` applies snapshot/delta ops
  (`TranscriptOp`) and replays via `replayTranscript`. The in-flight
  assistant message streams live: `setStream(text)` renders a
  plain draft after the committed cells while `message-delta` events arrive,
  and the committed entry replaces it (clearing the draft — the text is
  never rendered twice); a rebase snapshot also clears it. Since
  a prompt renders as a bg2 block with the accent `▌` edge and its
  `timestamp`, prose behind `◆`, and each call with its result as a card
  (`tool-card.ts`: `renderToolCard`, `parseShellText` for the bash record and
  the exec spill notice, `testSummary`; successful workspace reads in
  `READ_TOOLS` fold to one `○` line). Cards show `CARD_PREVIEW_LINES` body
  lines (cut at the width, with a `└` footer naming hidden or cut rows);
  Ctrl-X expands them, and then every line and a too-long target wrap
  instead of being cut. An `edit` (or a `write` over a text
  file) with a display record shows `+A −R` and the inline diff
  (`ui/diff-block.ts`: `parseDisplayDiff`, `renderDiffRows` with the
  `addBg`/`delBg` surfaces and a token-level `wordDiff` on the
  `addWordBg`/`delWordBg` roles; 12 rows collapsed); a new file shows
  `new file +N` and its first 8 lines. Per-call facts the entries do not carry
  (duration, running clock, waiting on an approval) come from the app through
  `TranscriptViewOptions.toolState`. A `pi.compaction` entry renders as its
  own `compaction` cell — a `── compacted · reason ──` rule plus the
  summary (pi-durable's preamble/`<summary>` wrapper stripped, collapsed to
  the same preview budget and expanded by Ctrl-X); a `pi.reset` handoff
  renders as text, and no `branch_summary` kind exists in 1.0 (branching
  forks into a new conversation). Caching: each cell's
  markdown and finished rows are reused while its text, width and theme
  level are unchanged — a steady frame (the 100 ms spinner repaint) parses
  nothing — and a snapshot that drops cells prunes their cache entries;
  `markdownCacheSize()`/`markdownParses()` expose the counters the perf
  tests assert on. Snapshot reuse: `applyLaneSnapshot` diffs by
  cell id and keeps the object of every unchanged cell, so a re-applied
  snapshot allocates nothing; the op log behind `writeLog` is opt-in
  (`createTranscriptView({ ops: true })`, for `replayTranscript` and tests)
  — production applies a snapshot per lane event and keeps no copy of it.
- **Tree** (`tree.ts`): `RunStatus` is `idle|running|done`;
  `AgentTreeState` toggles (`toggleTree`), takes ONE lane input —
  `applyTreeSnapshot(state, lane)`, the `TreeLaneSnapshot` the host
  projector folds (the tree never sees a raw lane event) — and renders
  (`renderTreeLines`, `collapsedSummary`, glyphs, `formatTreeTokens`). Tool
  rows carry the args summary and outcome
  (`summarizeToolArguments`/`summarizeToolOutcome`, shell tool only), a
  failed call renders
  `✗`, the root row carries `$cost in/out` (`TreeUsage`, the totals the
  state carries: the attach snapshot's cumulative ledger, then the usage
  rows), and calls are grouped per turn (a new running turn rolls the live
  group into `previousTurns` as a `TreeTurnSummary`, which folds to one
  line).
- **Diff** (`diff-view.ts`): `DiffOp` mirrors the journal ops
  (`write|edit|create|delete|rename`); `DiffFileChange` renders headers
  + unified hunks (`renderDiffHeader`, `renderDiffLines`,
  `unifiedHunks`); binary text detected by `isBinaryText`.
- **Approval keys** (`approval-view.ts`): `ApprovalAction` is
  `allow-once|allow-session|deny`; `ApprovalViewRequest` resolves to an
  `ApprovalDecision` via `resolveApprovalAction` (defaults in
  `APPROVAL_DEFAULT_KEYS`, overridable, conflicts reported by
  `approvalKeyConflicts`). `approvalOverlayOptions` (visible at
  `APPROVAL_MIN_WIDTH` = 80 columns) still frames the question and confirm
  dialogs.
- **Approval card** (`approval-card.ts`): `renderApprovalCard`
  draws the ask in the editor's slot at every width — heavy warn frame,
  `APPROVAL` badge, the tool and `i of n`; the command (paged by `v`, its
  destructive words bold) or the edit/write diff preview (`v` opens the
  whole diff); one `▲` reason row per capability (`approvalReason`), the
  working directory, the model's explanation on `?`, the next queued ask,
  and the keys. `approval-surface.ts` queues the asks, sanitises them at
  ingress and arms the keys (`queued`, `explaining`, `toggleExplain`).
- **Journal** (`journal-view.ts`): `JournalFilter` selects changes
  (`filterJournalChanges`), rendered as diff lines
  (`renderJournalLines`) under `DiffRenderOptions`.
- **Screen** (`screen.ts`): `bootScreen(terminal, root)` boots the alt
  screen from a layout root.
- **Editor** (`editor-view.ts`): `PromptEditor` wraps Pi's `Editor` with a
  lazily bound TUI handle (`bind`), Enter submit (empty drafts are
  ignored), multi-line entry (Ctrl-J / Shift+Enter / `\`+Enter), submit
  history, and focus forwarding for the IME cursor marker. `setDisabled`
  blocks submit for the duration of a turn.
- **Lane cells** (`lane-cells.ts`): `entriesToCells` turns committed lane
  entries into ordered transcript cells (`› ` prompts, `tool <name>` calls,
  truncated tool output) — the coarse-cell feed the prompt loop
  re-applies after every turn.
- **App** (`tui-app.ts`): `createTuiApp` arranges the views and routes
  input. The shipped key map is Enter (submit), Ctrl-J / Shift+Enter /
  `\`+Enter (newline), Ctrl-T (tree toggle), Esc (close a dropdown or
  overlay, else interrupt the turn — never quits), Ctrl-C (cancel while a
  turn runs, clear a draft, else arm: a second press within 2 s quits),
  Ctrl-D (quit on an empty draft). Plain
  characters — including `t`/`T` — belong to the editor.

### Presentation state

The data contract is [@kubic/core](core.md)
`KubicPresentationState` — this package defines no parallel event
vocabulary and holds no runtime authority. See the core page for the
field table and command list.

## Dep-direction neighbours

- May import: [@kubic/core](core.md) only — never exec/worker/host/
  agents/trajectory/eval implementation.
- Wired by: `apps/kubic` (composition root composes host + tui).
- Pi seam: `tui-boundary.ts` only.

```text
@kubic/core ──→ @kubic/tui ──→ apps/kubic (composed with host)
      (pi-tui via tui-boundary.ts only)
```

Back to the [docs index](../README.md).
