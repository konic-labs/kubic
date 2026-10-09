// The approval contract: the centered 70%/60% overlay
// the question and confirm dialogs use; the decision keys. The approval itself
// is the inline card (approval-card.test.ts). Faux-only: zero network, short
// real timers.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APPROVAL_MIN_WIDTH,
  approvalKeyConflicts,
  approvalOverlayOptions,
  resolveApprovalKey,
} from './approval-view.js';
import { approvalOverlayBounds } from './test-support/approval-geometry.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('approval overlay geometry', () => {
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
});

// The action a key resolves to, or undefined when no binding matches.
const actionFor = (
  data: string,
  overrides?: Parameters<typeof resolveApprovalKey>[1],
) => resolveApprovalKey(data, overrides)?.action;

describe('approval keybindings', () => {
  it('resolves a/Ctrl-S/d via matchesKey with zero conflicts', () => {
    expect(actionFor('a')).toBe('allow-once');
    expect(actionFor('\x13')).toBe('allow-session');
    expect(actionFor('s')).toBeUndefined();
    expect(actionFor('d')).toBe('deny');
    expect(actionFor('x')).toBeUndefined();
    expect(approvalKeyConflicts()).toEqual([]);
  });

  it('deny wins on a conflicting key', () => {
    expect(
      actionFor('x', {
        'allow-once': ['x'],
        deny: ['x'],
      }),
    ).toBe('deny');
    expect(
      approvalKeyConflicts({
        'allow-once': ['x'],
        deny: ['x'],
      }),
    ).toEqual([{ key: 'x', actions: ['deny', 'allow-once'] }]);
  });

  it('lets user overrides win', () => {
    expect(actionFor('x', { 'allow-once': ['x'] })).toBe('allow-once');
    expect(actionFor('a', { 'allow-once': ['x'] })).toBeUndefined();
  });
});

describe('approval view exact rendering', () => {
  it('floors fractional overlay geometry instead of returning floats', () => {
    expect(approvalOverlayBounds(99, 29)).toEqual({
      width: 69,
      height: 17,
      row: 6,
      col: 15,
    });
  });

  it('shows the overlay at exactly 80 columns, not below', () => {
    const options = approvalOverlayOptions();
    expect(options.visible?.(80, 30)).toBe(true);
    expect(options.visible?.(79, 30)).toBe(false);
  });
});
