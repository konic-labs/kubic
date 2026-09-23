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
| `tree.ts` | `RunStatus`, `ToolCallState`, `rootGlyph`, `toolGlyph`, `TreeToolCall`, `AgentTreeState`, `createTreeState`, `toggleTree`, `LaneEventLike`, `applyLaneEvent`, `collapsedSummary`, `renderTreeLines`, `TreeMouseEvent`, `TreeMouseResult`, `TreeViewOptions`, `AgentTreeView` |
| `diff-view.ts` | `DiffOp`, `DiffFileChange`, `DiffRenderOptions`, `isBinaryText`, `unifiedHunks`, `renderDiffHeader`, `renderDiffLines`, `DiffView` |
| `approval-view.ts` | `ApprovalAction`, `ApprovalViewRequest`, `ApprovalDecision`, `APPROVAL_MIN_WIDTH`, `shouldUseInlineFallback`, `ApprovalOverlayOptions`, `approvalOverlayOptions`, `ApprovalOverlayBounds`, `approvalOverlayBounds`, `renderApprovalLines`, `renderApprovalInline`, `APPROVAL_DEFAULT_KEYS`, `ApprovalKeyOverrides`, `resolveApprovalAction`, `ApprovalKeyConflict`, `approvalKeyConflicts`, `ApprovalOverlayHandle`, `ApprovalOverlayTui`, `showApprovalOverlay`, `dismissApprovalOverlay` |
| `journal-view.ts` | `JournalFilter`, `filterJournalChanges`, `renderJournalLines`, `JournalViewOptions`, `JournalView` |
| `views.ts`, `components.ts` | Reserved stubs (`export {}`) — view assembly lands with owners #23–#28 |
| `index.ts` | Reserved stub (`export {}`) — import per-module paths |

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
  `renderStatusLines` under `DEFAULT_STATUS_THEME`.
- **Transcript** (`transcript.ts`): `TranscriptEntryKind` is
  `text|tool|output`; `TranscriptView` applies snapshot/delta ops
  (`TranscriptOp`) and replays via `replayTranscript`.
- **Tree** (`tree.ts`): `RunStatus` is `idle|running|done`;
  `AgentTreeState` toggles (`toggleTree`), consumes lane events
  (`LaneEventLike` via `applyLaneEvent`), and renders
  (`renderTreeLines`, `collapsedSummary`, glyphs).
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
