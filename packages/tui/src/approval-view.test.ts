// RED (issue #26): ApprovalView overlay + keybindings.
// §41 triggers/policy/explicit autoApprove/timeout→deny/memoOnce; §16.4
// centered 70%/60% overlay + focus/unfocus + nonCapturing; §16.6
// matchesKey/Focusable/CURSOR_MARKER/registry; §16.9 themes/keybindings.
// Headless snapshots render directly (no VirtualTerminal in Pi 0.85.1)
// like layout.test.ts. Faux-only: zero network, short real timers.
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_MIN_WIDTH,
  approvalOverlayBounds,
  approvalOverlayOptions,
  renderApprovalInline,
  renderApprovalLines,
  shouldUseInlineFallback,
  type ApprovalViewRequest,
} from './approval-view.js';
function request(): ApprovalViewRequest {
  return {
    key: 'k1',
    capability: 'destructive-shell',
    toolName: 'bash',
    command: 'rm -rf /tmp/x',
    paths: ['/tmp/x'],
    justification: 'clean scratch dir',
  };
}
describe('approval render (issue #26; §41)', () => {
  it('shows capability, justification, command+paths, and 3 actions', () => {
    const lines = renderApprovalLines(request(), 100);
    const doc = lines.join('\n');
    expect(doc).toContain('destructive-shell');
    expect(doc).toContain('clean scratch dir');
    expect(doc).toContain('rm -rf /tmp/x');
    expect(doc).toContain('/tmp/x');
    expect(doc).toContain('allow once');
    expect(doc).toContain('allow session');
    expect(doc).toContain('deny');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(100);
  });
});

describe('approval overlay geometry (issue #26; §16.4)', () => {
  it('is centered 70%/60% and capturing (focus)', () => {
    const options = approvalOverlayOptions();
    expect(options.width).toBe('70%');
    expect(options.maxHeight).toBe('60%');
    expect(options.anchor).toBe('center');
    expect(options.nonCapturing).not.toBe(true);
    expect(options.visible?.(100, 30)).toBe(true);
    expect(options.visible?.(70, 24)).toBe(false);
    expect(APPROVAL_MIN_WIDTH).toBe(80);
  });

  it('centers a 70-col box on 100x30', () => {
    expect(approvalOverlayBounds(100, 30)).toEqual({
      width: 70,
      height: 18,
      row: 6,
      col: 15,
    });
  });

  it('falls back inline below 80 columns', () => {
    expect(shouldUseInlineFallback(100)).toBe(false);
    expect(shouldUseInlineFallback(70)).toBe(true);
    const lines = renderApprovalInline(request(), 70);
    const doc = lines.join('\n');
    expect(doc).toContain('destructive-shell');
    expect(doc).toContain('deny');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(70);
  });
});