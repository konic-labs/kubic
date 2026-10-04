# `@kubic/tui`

> Design ref: §17 UX; §32 facet split (TUI never imports
> host/worker implementation — contracts from core only).
> Owner: issue
> [#63](https://github.com/konic-labs/kubic/issues/63).
> Source: `packages/tui/src` (read-only — this page quotes it, never moves it).

`@kubic/tui` is presentation only (§3.1): layout and views over the
[@kubic/core](core.md) `KubicPresentationState`. It must import contracts
from `@kubic/core` and never `@kubic/host` or `@kubic/worker`
implementation — enforced by `scripts/dep-lint.mjs` (issue #2). All Pi
presentation imports flow through `src/tui-boundary.ts` (issue #22), the
TUI-side analogue of the worker Pi boundary.

## Public API (`packages/tui/src`)

| Module | Exports |
| --- | --- |
| `tui-boundary.ts` | Sole presentation seam: re-exports `Component`, `Focusable`, `MouseRegionHandler`, `StackEntryOptions`, `Terminal`, `TUI` (types) and `CURSOR_MARKER`, `Editor`, `Markdown`, `MouseRegion`, `matchesKey`, `ScrollView`, `Text`, `TuiAltScreen`, `VStack` (values) from `@earendil-works/pi-tui`, each with a JUSTIFICATION block |
| `layout.ts` | `Viewport`, `LayoutSlots`, `NARROW_COLUMNS`, `buildLayoutRoot`, `renderLayout` |
| `screen.ts` | `Screen`, `bootScreen` |
| `status-bar.ts` | `StatusUsageCost`, `StatusUsage`, `StatusUsageRow`, `StatusSummary`, `summarizeStatusRows`, `formatStatusCost`, `StatusMode`, `StatusBarState`, `StatusBarTheme`, `DEFAULT_STATUS_THEME`, `statusVisibleWidth`, `renderStatusLines`, `StatusBarOptions`, `StatusBar` |
| `transcript.ts` | `TranscriptEntryKind`, `TranscriptEntry`, `TranscriptDelta`, `LaneSnapshot` (re-export), `TranscriptSnapshotOp`, `TranscriptDeltaOp`, `TranscriptOp`, `TranscriptView`, `createTranscriptView`, `replayTranscript` |
| `tree.ts` | `RunStatus`, `ToolCallState`, `rootGlyph`, `toolGlyph`, `TreeToolCall`, `TreeUsage`, `TreeTurnSummary`, `AgentTreeState`, `createTreeState`, `toggleTree`, `LaneEventLike`, `applyLaneEvent`, `collapsedSummary`, `formatTreeTokens`, `renderTreeLines`, `TreeMouseEvent`, `TreeMouseResult`, `TreeViewOptions`, `AgentTreeView` |
| `editor-view.ts` | `EDITOR_FALLBACK_ROWS`, `editorTheme`, `PromptEditor` (Pi `Editor` behind the seam: Enter submit, multi-line entry, history, focus forwarding) |
| `lane-cells.ts` | `LaneEntryLike`, `PROMPT_PREFIX`, `TOOL_CALL_PREFIX`, `TOOL_RESULT_MAX_CHARS`, `TOOL_DETAIL_MAX_CHARS`, `TOOL_OUTCOME_MAX_CHARS`, `sanitizeLaneText`, `summarizeToolArguments`, `summarizeToolOutcome`, `entriesToCells` — committed lane entries → coarse transcript cells (§15.2); every cell's text (user, assistant, tool result, tool name) is sanitized here so model-supplied content cannot drive the terminal. `sanitizeLaneText` strips complete ECMA-48 sequences (CSI, OSC, C1 CSI, 2-byte ESC forms — not just the ESC byte, #299), collapses carriage-return overwrites to the text after the last `\r`, expands tabs by visible column width, and drops the remaining C0/C1 controls |
| `tui-app.ts` | `TuiAppSeed`, `TuiInputResult`, `TuiApp`, `createTuiApp`, `seedFromPresentation` — the global keys (Ctrl-C/Esc/Ctrl-D/Ctrl-T) are classified through Pi's `parseKey` (see `tui-boundary.ts`), so both legacy-byte and Kitty CSI-u encodings are honoured |
| `diff-view.ts` | `DiffOp`, `DiffFileChange`, `DiffRenderOptions`, `isBinaryText`, `unifiedHunks`, `renderDiffHeader`, `renderDiffLines` (pure render functions; the panel owns the document and its scrolling, #301) |
| `approval-view.ts` | `ApprovalAction`, `ApprovalViewRequest`, `ApprovalDecision`, `APPROVAL_MIN_WIDTH`, `shouldUseInlineFallback`, `ApprovalOverlayOptions`, `approvalOverlayOptions`, `ApprovalOverlayBounds`, `approvalOverlayBounds`, `renderApprovalLines`, `renderApprovalInline`, `APPROVAL_DEFAULT_KEYS`, `ApprovalKeyOverrides`, `resolveApprovalAction`, `ApprovalKeyConflict`, `approvalKeyConflicts`, `ApprovalOverlayHandle`, `ApprovalOverlayTui`, `showApprovalOverlay`, `dismissApprovalOverlay` |
| `journal-view.ts` | `JournalFilter`, `filterJournalChanges`, `renderJournalLines`, `JournalViewOptions`, `JournalView` |
| `views.ts`, `components.ts` | Pointer | View assembly lives in `layout.ts` / `*-view.ts` / `tui-app.ts` (#23–#28); no shared or aggregated module |
| `index.ts` | Pointer | No barrel — import per-module paths (`tui-boundary.js` seam + views); `tui/` stays presentation-only |

## Contracts

### Layout (`layout.ts`, §16.2)

VStack root, four rows in order:

| Row | Slot | Sizing |
| --- | --- | --- |
| `AgentTreeView` | `tree` | basis 12, collapses below 80 columns |
| ScrollView transcript | `transcript` | grow 1, follow-end |
| `StatusBar` | `status` | basis 2 |
| editor + footer | `editor` | auto |

`Viewport` is `{ width: number, height: number }` (matches Pi's
`LayoutViewport` without importing layout internals through the seam);
`LayoutSlots` is `{ tree, transcript, status, editor: Component }`;
`NARROW_COLUMNS` is 80 (the tree hides below it — proven by the narrow
snapshot test); `renderLayout(root, width)` renders headless (pure, no
terminal). Slots are `Component`s — contents belong to #23–#28; this
module owns arrangement only.

### Views

- **Status bar** (`status-bar.ts`): `StatusMode` is `solo|orchestrator`;
  usage/cost rollups (`StatusUsage`, `StatusUsageRow`,
  `StatusUsageCost`, `StatusSummary`, `summarizeStatusRows`,
  `formatStatusCost`) feed `StatusBarState`, rendered by
  `renderStatusLines` under `DEFAULT_STATUS_THEME`. The bar shows
  model/thinking/tokens/cache/cost only: the TTFT and tool-ms segments
  were deleted in #346 (Pi 1.0 routes no timing Kubic could read), and
  `kubic tui --session` seeds the rows from the session's `pi.usage`
  ledger before the first frame. Issue #347 adds the context gauge: when
  `StatusBarState.contextWindow` is known and a committed request reported
  its prompt size (`StatusSummary.contextTokens`), row 1 carries
  `ctx NN%` — warning-coloured at or above
  `StatusBarState.compactionThreshold` — and drops before the model when
  the terminal narrows.
- **Transcript** (`transcript.ts`): `TranscriptEntryKind` is
  `text|tool|output`; `TranscriptView` applies snapshot/delta ops
  (`TranscriptOp`) and replays via `replayTranscript`. Tool output is
  collapsed to `TOOL_OUTPUT_PREVIEW_LINES` rows (cut at the width, with a
  hint naming hidden or clipped rows); Ctrl-X expands it, and then every
  output line and the tool call's args summary wrap with a hanging indent
  instead of being cut (issue #300). Caching (issue #298): each cell's
  markdown and finished rows are reused while its text, width and theme
  level are unchanged — a steady frame (the 100 ms spinner repaint) parses
  nothing — and a snapshot that drops cells prunes their cache entries;
  `markdownCacheSize()`/`markdownParses()` expose the counters the perf
  tests assert on. Snapshot reuse (issue #297): `applyLaneSnapshot` diffs by
  cell id and keeps the object of every unchanged cell, so a re-applied
  snapshot allocates nothing; the op log behind `writeLog` is opt-in
  (`createTranscriptView({ ops: true })`, for `replayTranscript` and tests)
  — production applies a snapshot per lane event and keeps no copy of it.
- **Tree** (`tree.ts`): `RunStatus` is `idle|running|done`;
  `AgentTreeState` toggles (`toggleTree`), consumes lane events
  (`LaneEventLike` via `applyLaneEvent` — run status, tool start/end, usage
  rows and the attach snapshot's usage ledger) and renders
  (`renderTreeLines`, `collapsedSummary`, glyphs,
  `formatTreeTokens`). Tool rows carry the args summary and outcome
  (`summarizeToolArguments`/`summarizeToolOutcome`, shell tool only), a
  failed call renders
  `✗`, the root row carries `$cost in/out` (`TreeUsage`, seeded from the
  attach snapshot's ledger — the tree picks it up when the lane attaches,
  not at boot — then summed from usage rows), and calls are
  grouped per turn (a `run-start` rolls the live group into
  `previousTurns` as a `TreeTurnSummary`, which folds to one line).
- **Diff** (`diff-view.ts`): `DiffOp` mirrors the journal ops
  (`write|edit|create|delete|rename`); `DiffFileChange` renders headers
  + unified hunks (`renderDiffHeader`, `renderDiffLines`,
  `unifiedHunks`); binary text detected by `isBinaryText`.
- **Approval overlay** (`approval-view.ts`): `ApprovalAction` is
  `allow-once|allow-session|deny`; `ApprovalViewRequest` resolves to an
  `ApprovalDecision` via `resolveApprovalAction` (defaults in
  `APPROVAL_DEFAULT_KEYS`, overridable, conflicts reported by
  `approvalKeyConflicts`); `APPROVAL_MIN_WIDTH` is 80 — narrower falls
  back to inline (`shouldUseInlineFallback`, `renderApprovalInline`).
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
  truncated tool output) — the §15.2 coarse-cell feed the prompt loop
  re-applies after every turn.
- **App** (`tui-app.ts`): `createTuiApp` arranges the views and routes
  input. The shipped key map is Enter (submit), Ctrl-J / Shift+Enter /
  `\`+Enter (newline), Ctrl-T (tree toggle), Ctrl-C (cancel while a turn
  runs, else quit), Esc (quit), Ctrl-D (quit on an empty draft). Plain
  characters — including `t`/`T` — belong to the editor.

### Presentation state

The data contract is [@kubic/core](core.md)
`KubicPresentationState` (§66) — this package defines no parallel event
vocabulary and holds no runtime authority. See the core page for the
field table and command list.

## Dep-direction neighbours

- May import: [@kubic/core](core.md) only — never exec/worker/host/
  agents/trajectory/eval implementation.
- Wired by: `apps/kubic` (composition root composes host + tui).
- Pi seam: `tui-boundary.ts` only (issue #22).

```text
@kubic/core ──→ @kubic/tui ──→ apps/kubic (composed with host)
      (pi-tui via tui-boundary.ts only)
```

Back to the [docs index](../README.md).
