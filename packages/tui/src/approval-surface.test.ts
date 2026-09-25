// The approval surface (issue #96, acceptance criteria 1 and 2).
// RED: nothing in the interactive TUI can answer an approval — the host's
// installed policy has no answer seat, and approval-view.ts is runtime-dead.
//
// Criterion 2's width rule and criterion 1's key map are pinned here as pure
// render/settle tests: there is no VirtualTerminal in the pinned pi-tui, so
// the app is rendered at a fixed width (the established pattern in
// layout.test.ts / tree.test.ts) and the surface is exercised with plain
// strings. Overlay compositing itself is the root's business and is asserted
// against a real TuiAltScreen on the composition path.
import { describe, expect, it } from 'vitest';
import {
  createApprovalSurface,
  INLINE_APPROVAL_HEADER,
} from './approval-surface.js';
import {
  APPROVAL_MIN_WIDTH,
  type ApprovalViewRequest,
  approvalOverlayOptions,
} from './approval-view.js';

const REQUEST: ApprovalViewRequest = {
  key: 'k-1',
  capability: 'destructive-shell',
  toolName: 'bash',
  command: 'rm -rf /tmp/x',
  justification: 'clean scratch dir',
};

describe('approval surface: width rule (issue #96, criterion 2)', () => {
  it('renders the inline form below APPROVAL_MIN_WIDTH', async () => {
    const surface = createApprovalSurface();
    const pending = surface.ask(REQUEST);
    expect(surface.isShowing()).toBe(true);
    const lines = surface.renderInline(70).join('\n');
    expect(lines).toContain(INLINE_APPROVAL_HEADER);
    expect(lines).toContain('destructive-shell');
    expect(lines).toContain('rm -rf /tmp/x');
    expect(lines).toContain('deny');
    for (const line of surface.renderInline(70)) {
      expect(line.length).toBeLessThanOrEqual(70);
    }
    surface.decide('d');
    await pending;
  });

  it('does not take the inline path at or above APPROVAL_MIN_WIDTH', async () => {
    const surface = createApprovalSurface();
    const pending = surface.ask(REQUEST);
    expect(surface.usesInlineFallback(APPROVAL_MIN_WIDTH)).toBe(false);
    expect(surface.usesInlineFallback(APPROVAL_MIN_WIDTH - 1)).toBe(true);
    expect(surface.usesInlineFallback(100)).toBe(false);
    surface.decide('a');
    await pending;
  });

  it('uses the overlay where the width allows it', async () => {
    // The overlay's own visible() gate is the second half of the rule: below
    // the minimum Pi must not composite it, so the inline body is the only
    // surface left — the two can never both be absent.
    const options = approvalOverlayOptions();
    expect(options.visible?.(APPROVAL_MIN_WIDTH, 30)).toBe(true);
    expect(options.visible?.(APPROVAL_MIN_WIDTH - 1, 30)).toBe(false);
    const surface = createApprovalSurface();
    const pending = surface.ask(REQUEST);
    expect(surface.usesInlineFallback(APPROVAL_MIN_WIDTH - 1)).toBe(true);
    surface.decide('d');
    await pending;
  });
});

describe('approval surface: decisions (issue #96, criterion 1)', () => {
  it('resolves allow-once, allow-session and deny by key', async () => {
    for (const [key, expected] of [
      ['a', { approved: true, by: 'allow-once' }],
      ['s', { approved: true, by: 'allow-session' }],
      ['d', { approved: false, reason: 'denied by the user' }],
    ] as const) {
      const surface = createApprovalSurface();
      const pending = surface.ask(REQUEST);
      expect(surface.decide(key)).toBe(true);
      await expect(pending).resolves.toEqual(expected);
      expect(surface.isShowing()).toBe(false);
    }
  });

  it('treats Esc as deny (the approval-view default) without quitting', async () => {
    const surface = createApprovalSurface();
    const pending = surface.ask(REQUEST);
    expect(surface.decide('\u001b')).toBe(true);
    await expect(pending).resolves.toEqual({
      approved: false,
      reason: 'denied by the user',
    });
  });

  it('ignores a key that is not a decision instead of settling on it', async () => {
    const surface = createApprovalSurface();
    const pending = surface.ask(REQUEST);
    expect(surface.decide('z')).toBe(false);
    expect(surface.isShowing()).toBe(true);
    surface.decide('a');
    await expect(pending).resolves.toEqual({
      approved: true,
      by: 'allow-once',
    });
  });

  it('denies (never hangs) when no decision can arrive', async () => {
    const surface = createApprovalSurface();
    const pending = surface.ask(REQUEST);
    surface.cancelPending('the session quit before the approval was answered');
    await expect(pending).resolves.toEqual({
      approved: false,
      reason: 'the session quit before the approval was answered',
    });
    expect(surface.isShowing()).toBe(false);
  });

  it('answers one request at a time: a second ask waits for the first', async () => {
    const surface = createApprovalSurface();
    const first = surface.ask(REQUEST);
    const second = surface.ask({ ...REQUEST, key: 'k-2', toolName: 'write' });
    expect(surface.pending()?.key).toBe('k-1');
    surface.decide('a');
    await expect(first).resolves.toEqual({ approved: true, by: 'allow-once' });
    // The queued request is shown once the first settles.
    expect(surface.pending()?.key).toBe('k-2');
    surface.decide('d');
    await expect(second).resolves.toEqual({
      approved: false,
      reason: 'denied by the user',
    });
  });

  it('settles every queued request when the session quits', async () => {
    const surface = createApprovalSurface();
    const first = surface.ask(REQUEST);
    const second = surface.ask({ ...REQUEST, key: 'k-2' });
    surface.cancelPending('quit');
    await expect(first).resolves.toEqual({ approved: false, reason: 'quit' });
    await expect(second).resolves.toEqual({ approved: false, reason: 'quit' });
    expect(surface.isShowing()).toBe(false);
  });
});

describe('approval surface: boot key check (issue #96, criterion 1)', () => {
  it('passes the shipped defaults with zero conflicts', () => {
    const surface = createApprovalSurface();
    expect(surface.checkKeys()).toBe(true);
  });

  it('refuses to arm a conflicting key map by name', () => {
    const surface = createApprovalSurface({
      keyOverrides: { 'allow-once': ['x'], deny: ['x'] },
    });
    expect(() => surface.checkKeys()).toThrow(/approval key conflict: x/);
  });

  it('reports the documented keys the surface answers to', () => {
    const surface = createApprovalSurface();
    expect(surface.keys()).toEqual({
      'allow-once': ['a'],
      'allow-session': ['s'],
      deny: ['d', 'escape'],
    });
  });
});

describe('approval surface: untrusted content (issue #96, criterion 1)', () => {
  it('sanitizes the request before it reaches a render function', async () => {
    const ESC = '\u001b';
    const BEL = '\u0007';
    const surface = createApprovalSurface();
    const pending = surface.ask({
      key: 'k',
      capability: `destructive${ESC}[2J-shell`,
      toolName: `bash${BEL}`,
      command: `rm -rf ${ESC}[31m/tmp/x`,
      paths: [`/tmp${ESC}[2J/x`],
      justification: `because${ESC}[0m`,
    });
    const frame = surface.renderInline(120).join('\n');
    expect(frame).toContain('destructive');
    expect(frame).toContain('bash');
    expect(frame).toContain('/tmp/x');
    expect(frame).not.toContain(`${ESC}[2J`);
    expect(frame).not.toContain(`${ESC}[31m`);
    expect(frame).not.toContain(BEL);
    surface.decide('d');
    await pending;
  });
});
