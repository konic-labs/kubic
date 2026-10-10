// The approval card's decision keys: the defaults, a conflict and the
// operator's overrides. The card itself is approval-card.test.ts. Faux-only:
// zero network, short real timers.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { approvalKeyConflicts, resolveApprovalKey } from './approval-view.js';

afterEach(() => {
  vi.useRealTimers();
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
