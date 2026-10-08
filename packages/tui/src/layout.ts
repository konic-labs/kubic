// VStack root (panel row; order). Rows top to bottom: the one-row header; the
// TreeView (sized to its content, hidden below 80 cols and wherever the
// caller turns it off); the ScrollView transcript (grow 1, follow-end); the
// inspectable panel (diff / journal, basis 12, present only while open); the
// transient notice row (0–2 rows); the editor; the one-row status line; the
// key-hint row. Slots are Components — contents belong to their own issues;
// this module owns arrangement only.

import type { Component } from './tui-boundary.js';
import { VStack } from './tui-boundary.js';

export const NARROW_COLUMNS = 80;

// The panel row's height while a panel is open. Same basis as
// the tree so toggling a panel does not resize the transcript unevenly.
const PANEL_BASIS = 12;

// Structural viewport (matches Pi's LayoutViewport {width, height} without
// importing its layout internals through the seam).
interface Viewport {
  width: number;
  height: number;
}

// The tree row sizes to its content up to this many rows (TUI polish: a
// fixed 12-row block left most of the top of the screen blank in Kubic).
export const TREE_MAX_ROWS = 6;

export interface LayoutSlots {
  // Optional one-line header above everything else.
  header?: Component;
  tree: Component;
  // Whether the tree row shows at all (the lane hides it until
  // Ctrl-T asks for it). Absent keeps it on; the width gate applies either
  // way.
  treeVisible?: () => boolean;
  transcript: Component;
  status: Component;
  editor: Component;
  // The transient notice row above the editor (turn outcome,
  // command replies, the working line) and the key-hint row at the bottom.
  // Both size to their content, so an empty notice takes no row.
  notice?: Component;
  hints?: Component;
  // The diff/journal panel row. Optional so the four-row
  // arrangement is unchanged for callers that have no panel; when present,
  // the row is only laid out while `panel.isOpen()` — a closed panel must
  // not reserve blank rows. NOT width-gated: an operator on a narrow
  // terminal still gets the panels (only the tree collapses there).
  panel?: { component: Component; isOpen: () => boolean };
}

export function buildLayoutRoot(slots: LayoutSlots): VStack {
  // The tree hides below 80 columns; Pi's Stack consults `visible` per
  // viewport at render time (proven by the narrow snapshot test).
  const treeVisible = (viewport: Viewport): boolean =>
    viewport.width >= NARROW_COLUMNS && (slots.treeVisible?.() ?? true);
  // Structural StackEntry (Pi's StackChild): field-for-field compatible with
  // the seam's VStack children without widening tui-boundary.ts.
  type Row = {
    component: Component;
    basis?: number | 'auto';
    grow?: number;
    shrink?: number;
    minSize?: number;
    maxSize?: number;
    visible?: (viewport: Viewport) => boolean;
  };
  const rows: Row[] = [];
  if (slots.header !== undefined) {
    rows.push({ component: slots.header, basis: 1, shrink: 0 });
  }
  rows.push(
    {
      component: slots.tree,
      basis: 'auto',
      shrink: 0,
      maxSize: TREE_MAX_ROWS,
      visible: treeVisible,
    },
    {
      component: slots.transcript,
      grow: 1,
      shrink: 1,
      minSize: 3,
    },
  );
  if (slots.panel !== undefined) {
    // Read through the slot, not a captured boolean: the callback runs per
    // render, so a toggle takes effect on the next frame.
    const panel = slots.panel;
    rows.push({
      component: panel.component,
      basis: PANEL_BASIS,
      shrink: 1,
      minSize: 3,
      visible: (): boolean => panel.isOpen(),
    });
  }
  if (slots.notice !== undefined) {
    rows.push({ component: slots.notice, basis: 'auto', shrink: 0 });
  }
  rows.push(
    { component: slots.editor, basis: 'auto', shrink: 0 },
    { component: slots.status, basis: 'auto', shrink: 0 },
  );
  if (slots.hints !== undefined) {
    rows.push({ component: slots.hints, basis: 'auto', shrink: 0 });
  }
  return new VStack(rows, { gap: 0, align: 'stretch' });
}
