export interface ApprovalOverlayBounds {
  readonly width: number;
  readonly height: number;
  readonly row: number;
  readonly col: number;
}

// NOTE (max-extent estimate — Pi is the layout authority at runtime):
// Pi's compositeOverlays (pi-tui/dist/tui.js) renders the component at the
// resolved width and uses content height (overlayLines.length clamped to
// maxHeight) centered via resolveOverlayLayout — it never sizes the box to
// termHeight * 60%. This helper returns the 70%-wide / 60%-tall centered
// max extent for headless estimates and tests only.
export function approvalOverlayBounds(
  termWidth: number,
  termHeight: number,
): ApprovalOverlayBounds {
  const width = Math.floor(termWidth * 0.7);
  const height = Math.floor(termHeight * 0.6);
  return {
    width,
    height,
    row: Math.max(0, Math.floor((termHeight - height) / 2)),
    col: Math.max(0, Math.floor((termWidth - width) / 2)),
  };
}
