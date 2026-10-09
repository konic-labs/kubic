// The run's guard on its own: the turn bound, the wall clock, the interrupts
// and the order they win in, over a fake signal source and fake timers.
import { EventEmitter } from 'node:events';
import type { Lane } from '@kubic/agent/lane/boot';
import { turnAbortReasonOf } from '@kubic/agent/lane/turn';
import { BACKGROUND_CONTEXT } from '@kubic/agent/pi-boundary';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { guardStopMessage, killLaneChildren, RunGuard } from './guard.js';

afterEach(() => {
  vi.useRealTimers();
});

function guarded(maxTurns?: number) {
  const signals = new EventEmitter();
  const guard = new RunGuard(BACKGROUND_CONTEXT, signals, maxTurns);
  const abortReason = () =>
    turnAbortReasonOf(guard.context.abortSignal?.reason);
  return { signals, guard, abortReason };
}

describe('RunGuard', () => {
  it('stops one committed response past --max-turns, as a guard abort', () => {
    const { guard, abortReason } = guarded(2);
    guard.countTurn();
    guard.countTurn();
    expect(guard.stop).toBeUndefined();
    expect(guard.context.abortSignal?.aborted).toBe(false);
    guard.countTurn();
    expect(guard.stop).toEqual({ kind: 'turn-limit', turns: 2 });
    expect(guard.stopMessage).toBe('turn limit reached after 2 turns');
    expect(abortReason()).toBe('guard');
  });

  it('never stops on turns without a bound', () => {
    const { guard } = guarded();
    for (let turn = 0; turn < 50; turn += 1) guard.countTurn();
    expect(guard.stop).toBeUndefined();
  });

  it('stops on the wall clock once started', () => {
    vi.useFakeTimers();
    const { guard, abortReason } = guarded();
    guard.start(1000, () => undefined);
    vi.advanceTimersByTime(999);
    expect(guard.stop).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(guard.stop).toEqual({ kind: 'timeout', ms: 1000 });
    expect(abortReason()).toBe('guard');
    guard.close();
  });

  it('on the first signal: detaches, runs the interrupt hook, then stops as a signal abort', () => {
    const { signals, guard, abortReason } = guarded();
    const order: string[] = [];
    guard.start(60_000, () => {
      order.push(
        `hook (listeners ${signals.listenerCount('SIGINT')}, stop ${guard.stop?.kind ?? 'none'})`,
      );
    });
    expect(signals.listenerCount('SIGINT')).toBe(1);
    expect(signals.listenerCount('SIGTERM')).toBe(1);
    expect(signals.listenerCount('SIGHUP')).toBe(1);
    signals.emit('SIGTERM', 'SIGTERM');
    expect(order).toEqual(['hook (listeners 0, stop none)']);
    expect(guard.interruptedBy).toBe('SIGTERM');
    expect(guard.stop).toEqual({ kind: 'interrupted', signal: 'SIGTERM' });
    expect(abortReason()).toBe('signal');
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    guard.close();
  });

  it('keeps the first stop, but still records a later signal', () => {
    vi.useFakeTimers();
    const { signals, guard } = guarded();
    guard.start(10, () => undefined);
    vi.advanceTimersByTime(10);
    signals.emit('SIGINT', 'SIGINT');
    expect(guard.stop).toEqual({ kind: 'timeout', ms: 10 });
    expect(guard.interruptedBy).toBe('SIGINT');
  });

  it('close detaches the signals and disarms the clock', () => {
    vi.useFakeTimers();
    const { signals, guard } = guarded();
    guard.start(10, () => undefined);
    guard.close();
    vi.advanceTimersByTime(100);
    expect(guard.stop).toBeUndefined();
    expect(signals.listenerCount('SIGINT')).toBe(0);
    guard.close();
  });

  it('names each stop', () => {
    expect(guardStopMessage({ kind: 'interrupted', signal: 'SIGHUP' })).toBe(
      'run interrupted by SIGHUP',
    );
    expect(guardStopMessage({ kind: 'timeout', ms: 5 })).toBe(
      'run timed out after 5ms',
    );
    expect(guardStopMessage({ kind: 'turn-limit', turns: 1 })).toBe(
      'turn limit reached after 1 turns',
    );
  });
});

describe('killLaneChildren', () => {
  it('kills every child of the conversation, past one that already exited', () => {
    const killed: string[] = [];
    const drained: string[] = [];
    const lane = {
      conversation: { id: 'conversation-1' },
      kills: {
        drain: (key: string) => {
          drained.push(key);
          return [
            () => killed.push('first'),
            () => {
              throw new Error('ESRCH');
            },
            () => killed.push('third'),
          ];
        },
      },
    } as unknown as Lane;
    killLaneChildren(lane);
    expect(drained).toEqual(['conversation-1']);
    expect(killed).toEqual(['first', 'third']);
    expect(() => killLaneChildren(undefined)).not.toThrow();
  });
});
