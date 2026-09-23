// ApprovalView: centered modal approval dialog (issue #26).
// §41 triggers/policy/explicit autoApprove/timeout→deny/memoOnce +
// session-scoped skip; §16.4 showOverlay centered 70%/60% + visible +
// focus/unfocus + capturing (nonCapturing never set); §16.6 matchesKey /
// Focusable / CURSOR_MARKER / registry; §16.9 keybindings.
// Presentation only: mirrors the host decider semantics
// (packages/host/src/approvals.ts) structurally without importing it —
// dep-lint forbids tui → host. Pi is touched ONLY through
// ./tui-boundary.js. No node:fs in prod src (I/O confinement).

import type { Component, Focusable } from './tui-boundary.js';
import { CURSOR_MARKER, matchesKey } from './tui-boundary.js';

export type ApprovalAction = 'allow-once' | 'allow-session' | 'deny';

// Structural request: the fields the dialog renders. The host owns the
// trigger/policy truth; the view never classifies, only presents.
export interface ApprovalViewRequest {
  readonly key: string;
  readonly capability: string;
  readonly toolName: string;
  readonly command?: string;
  readonly paths?: ReadonlyArray<string>;
  readonly justification?: string;
  readonly summary?: string;
}

export type ApprovalDecision =
  | { approved: true; by: string }
  | { approved: false; reason: string };

// Overlay geometry (§16.4): centered 70% width / 60% height, visible at
// 80+ columns, inline fallback below.
export const APPROVAL_MIN_WIDTH = 80;

export function shouldUseInlineFallback(width: number): boolean {
  return width < APPROVAL_MIN_WIDTH;
}

// Structural overlay options mirroring Pi's OverlayOptions (§16.4) without
// importing Pi past the seam: OverlayOptions is not a boundary export and
// the boundary is frozen for this issue. Field-for-field compatible with
// Pi's OverlayOptions (width/maxHeight accept numbers or "N%" strings).
export interface ApprovalOverlayOptions {
  readonly width?: number | `${number}%`;
  readonly maxHeight?: number | `${number}%`;
  readonly anchor?:
    | 'center'
    | 'top-left'
    | 'top-right'
    | 'bottom-left'
    | 'bottom-right'
    | 'top-center'
    | 'bottom-center'
    | 'left-center'
    | 'right-center';
  readonly visible?: (termWidth: number, termHeight: number) => boolean;
  readonly nonCapturing?: boolean;
}

export function approvalOverlayOptions(): ApprovalOverlayOptions {
  return {
    width: '70%',
    maxHeight: '60%',
    anchor: 'center',
    // Capturing by design: the modal takes focus on show (nonCapturing
    // is never set). Narrow terminals skip the overlay via visible.
    visible: (termWidth: number): boolean =>
      termWidth >= APPROVAL_MIN_WIDTH,
  };
}

export interface ApprovalOverlayBounds {
  readonly width: number;
  readonly height: number;
  readonly row: number;
  readonly col: number;
}

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

function truncateLine(line: string, width: number): string {
  if (line.length <= width) return line;
  if (width <= 0) return '';
  return `${line.slice(0, width - 1)}…`;
}

// Pure headless render (no VirtualTerminal in Pi 0.85.1): callers render
// these lines directly like renderLayout in layout.test.ts.
export function renderApprovalLines(
  request: ApprovalViewRequest,
  width: number,
): string[] {
  const w = Math.max(0, Math.floor(width));
  const lines = [
    `Approval required: ${request.capability}`,
    `tool: ${request.toolName}`,
  ];
  if (request.command !== undefined && request.command !== '') {
    lines.push(`command: ${request.command}`);
  }
  if (request.paths !== undefined && request.paths.length > 0) {
    lines.push(`paths: ${request.paths.join(', ')}`);
  }
  lines.push(`justification: ${request.justification ?? '(none)'}`);
  lines.push('[a] allow once   [s] allow session   [d] deny');
  return lines.map((line) => truncateLine(line, w));
}

// Narrow-terminal fallback (w < 80): same body under an inline header so
// the approval never depends on overlay space being available.
export function renderApprovalInline(
  request: ApprovalViewRequest,
  width: number,
): string[] {
  const w = Math.max(0, Math.floor(width));
  return [
    truncateLine('! approval (inline) — narrow terminal', w),
    ...renderApprovalLines(request, w),
  ];
}
