// The approval contract (issue #26): §41 timeout→deny/memoOnce; §16.4 the
// centered 70%/60% overlay the question and confirm dialogs use; §16.6/§16.9
// the decision keys. The approval itself is the inline card (issue #459,
// approval-card.test.ts). Faux-only: zero network, short real timers.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APPROVAL_MIN_WIDTH,
  approvalKeyConflicts,
  approvalOverlayBounds,
  approvalOverlayOptions,
  createApprovalMemo,
  resolveApprovalAction,
  waitForApproval,
} from './approval-view.js';

afterEach(() => {
  vi.useRealTimers();
});

// Settles only once the clock reaches maxPendingMs — not a tick earlier.
async function settledAt(
  pending: Promise<unknown>,
  maxPendingMs: number,
): Promise<void> {
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(maxPendingMs - 1);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toBe(true);
}

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
});

describe('approval keybindings (issue #26; §16.6/§16.9)', () => {
  it('resolves a/Ctrl-S/d via matchesKey with zero conflicts', () => {
    expect(resolveApprovalAction('a')).toBe('allow-once');
    expect(resolveApprovalAction('\x13')).toBe('allow-session');
    expect(resolveApprovalAction('s')).toBeUndefined();
    expect(resolveApprovalAction('d')).toBe('deny');
    expect(resolveApprovalAction('x')).toBeUndefined();
    expect(approvalKeyConflicts()).toEqual([]);
  });

  it('deny wins on a conflicting key', () => {
    expect(
      resolveApprovalAction('x', {
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
    expect(resolveApprovalAction('x', { 'allow-once': ['x'] })).toBe(
      'allow-once',
    );
    expect(resolveApprovalAction('a', { 'allow-once': ['x'] })).toBeUndefined();
  });
});

describe('approval timeout + memoOnce (issue #26; §41)', () => {
  it('denies with reason on maxPendingMs expiry and never hangs headless', async () => {
    vi.useFakeTimers();
    const memo = createApprovalMemo();
    const pending = waitForApproval('k1', {
      memo,
      maxPendingMs: 20,
    });
    await settledAt(pending, 20);
    const verdict = await pending;
    expect(verdict).toEqual({
      approved: false,
      reason: 'approval timed out after 20ms',
    });
    expect(memo.decided('k1')).toEqual(verdict);
  });

  it('rejects invalid maxPendingMs instead of arming a bad timer', () => {
    for (const maxPendingMs of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() =>
        waitForApproval('k1', { memo: createApprovalMemo(), maxPendingMs }),
      ).toThrow(RangeError);
    }
  });

  it('resolves deny when awaitAnswer rejects instead of propagating', async () => {
    const memo = createApprovalMemo();
    const verdict = await waitForApproval('k1', {
      memo,
      maxPendingMs: 50,
      awaitAnswer: () => Promise.reject(new Error('boom')),
    });
    expect(verdict).toEqual({
      approved: false,
      reason: 'approval await failed: boom',
    });
    expect(memo.decided('k1')).toEqual(verdict);
  });

  it('persists decisions: restart/rerender never re-asks; races settle once', async () => {
    const memo = createApprovalMemo();
    const first = memo.submit('k1', { approved: true, by: 'allow-once' });
    const raced = memo.submit('k1', {
      approved: false,
      reason: 'late deny',
    });
    expect(raced).toEqual(first);
    const again = await waitForApproval('k1', {
      memo,
      maxPendingMs: 20,
      awaitAnswer: () => {
        throw new Error('must not re-ask');
      },
    });
    expect(again).toEqual(first);
  });
});

describe('approval mutation hardening (issue #68)', () => {
  it('floors fractional overlay geometry instead of returning floats', () => {
    expect(approvalOverlayBounds(99, 29)).toEqual({
      width: 69,
      height: 17,
      row: 6,
      col: 15,
    });
  });

  it('resolves an approving answer through the memo', async () => {
    const memo = createApprovalMemo();
    const verdict = await waitForApproval('k1', {
      memo,
      maxPendingMs: 50,
      awaitAnswer: () => Promise.resolve({ approved: true, by: 'allow-once' }),
    });
    expect(verdict).toEqual({ approved: true, by: 'allow-once' });
    expect(memo.decided('k1')).toEqual(verdict);
  });

  it('waits out an undefined answer to the timeout deny', async () => {
    vi.useFakeTimers();
    const memo = createApprovalMemo();
    const pending = waitForApproval('k1', {
      memo,
      maxPendingMs: 20,
      awaitAnswer: () => Promise.resolve(undefined),
    });
    await settledAt(pending, 20);
    const verdict = await pending;
    expect(verdict).toEqual({
      approved: false,
      reason: 'approval timed out after 20ms',
    });
  });

  it('denies immediately on maxPendingMs 0 without throwing', async () => {
    const memo = createApprovalMemo();
    const verdict = await waitForApproval('k1', { memo, maxPendingMs: 0 });
    expect(verdict).toEqual({
      approved: false,
      reason: 'approval timed out after 0ms',
    });
  });

  it('reports a non-Error rejection without an undefined reason', async () => {
    const memo = createApprovalMemo();
    const verdict = await waitForApproval('k1', {
      memo,
      maxPendingMs: 50,
      awaitAnswer: () => Promise.reject('string boom'),
    });
    expect(verdict).toEqual({
      approved: false,
      reason: 'approval await failed: string boom',
    });
  });

  it('shows the overlay at exactly 80 columns, not below', () => {
    const options = approvalOverlayOptions();
    expect(options.visible?.(80, 30)).toBe(true);
    expect(options.visible?.(79, 30)).toBe(false);
  });
});
