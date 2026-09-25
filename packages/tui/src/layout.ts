// §16.2 VStack root (issue #22; panel row added by issue #96).
// Rows in order: AgentTreeView (basis 12, collapses below 80 cols),
// ScrollView transcript (grow 1, follow-end), the inspectable panel
// (issue #96: diff / journal, basis 12, present only while open),
// StatusBar (basis 2), editor + footer (auto). Slots are Components —
// contents belong to their own issues (#23–#28); this module owns
// arrangement only.

import type { Component } from './tui-boundary.js';
import { VStack } from './tui-boundary.js';

export const NARROW_COLUMNS = 80;

// The panel row's height while a panel is open (issue #96). Same basis as
// the tree so toggling a panel does not resize the transcript unevenly.
export const PANEL_BASIS = 12;

// Structural viewport (matches Pi's LayoutViewport {width, height} without
// importing its layout internals through the seam).
export interface Viewport {
  width: number;
  height: number;
}

export interface LayoutSlots {
  tree: Component;
  transcript: Component;
  status: Component;
  editor: Component;
  // Issue #96: the diff/journal panel row. Optional so the #22 four-row
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
    viewport.width >= NARROW_COLUMNS;
  // Structural StackEntry (Pi's StackChild): field-for-field compatible with
  // the seam's VStack children without widening tui-boundary.ts (#96 keeps
  // the #22 boundary frozen).
  type Row = {
    component: Component;
    basis?: number | 'auto';
    grow?: number;
    shrink?: number;
    minSize?: number;
    visible?: (viewport: Viewport) => boolean;
  };
  const rows: Row[] = [
    { component: slots.tree, basis: 12, shrink: 0, visible: treeVisible },
    { component: slots.transcript, grow: 1, shrink: 1, minSize: 3 },
  ];
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
  rows.push(
    { component: slots.status, basis: 2, shrink: 0 },
    { component: slots.editor, basis: 'auto', shrink: 0 },
  );
  return new VStack(rows, { gap: 0, align: 'stretch' });
}

// Headless snapshot: render the root at a fixed width (pure — no
// terminal). Row count and content assert layout, not pixels.
export function renderLayout(root: VStack, width: number): string[] {
  return root.render(width);
}
