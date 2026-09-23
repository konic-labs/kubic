// §16.2 VStack root (issue #22).
// Four rows in order: AgentTreeView (basis 12, collapses below 80 cols),
// ScrollView transcript (grow 1, follow-end), StatusBar (basis 2),
// editor + footer (auto). Slots are Components — contents belong to their
// own issues (#23–#28); this module owns arrangement only.

import type { Component } from './tui-boundary.js';
import { VStack } from './tui-boundary.js';

export const NARROW_COLUMNS = 80;

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
}

export function buildLayoutRoot(slots: LayoutSlots): VStack {
  // The tree hides below 80 columns; Pi's Stack consults `visible` per
  // viewport at render time (proven by the narrow snapshot test).
  const treeVisible = (viewport: Viewport): boolean =>
    viewport.width >= NARROW_COLUMNS;
  return new VStack(
    [
      { component: slots.tree, basis: 12, shrink: 0, visible: treeVisible },
      { component: slots.transcript, grow: 1, shrink: 1, minSize: 3 },
      { component: slots.status, basis: 2, shrink: 0 },
      { component: slots.editor, basis: 'auto', shrink: 0 },
    ],
    { gap: 0, align: 'stretch' },
  );
}

// Headless snapshot: render the root at a fixed width (pure — no
// terminal). Row count and content assert layout, not pixels.
export function renderLayout(root: VStack, width: number): string[] {
  return root.render(width);
}
