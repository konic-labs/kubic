// 3-domain cancellation: disconnect cancels invocation-only, preserves
// service-owned and durable work (issue #37; §32). RED first.
import { describe, expect, it } from 'vitest';
import { DisconnectController, TaskScope } from './cancellation.js';

describe('cancellation domains (issue #37, §32)', () => {
  it('cancels invocation-only scopes on disconnect', () => {
    const ctl = new DisconnectController();
    const invocation = new TaskScope('invocation');
    ctl.track(invocation);
    expect(invocation.signal.aborted).toBe(false);
    const result = ctl.onDisconnect();
    expect(invocation.signal.aborted).toBe(true);
    expect(result.cancelled).toEqual(['invocation']);
  });

  it('preserves service-owned and durable scopes on disconnect', () => {
    const ctl = new DisconnectController();
    const service = new TaskScope('service');
    const durable = new TaskScope('durable');
    ctl.track(service);
    ctl.track(durable);
    const result = ctl.onDisconnect();
    expect(service.signal.aborted).toBe(false);
    expect(durable.signal.aborted).toBe(false);
    expect(result.preserved).toEqual(
      expect.arrayContaining(['service', 'durable']),
    );
  });
});

// Cancellation hardening (issue #69): untrack and exact mixed outcomes.
describe('cancellation domains hardening (issue #69)', () => {
  it('untracks scopes so disconnect leaves them alone', () => {
    const ctl = new DisconnectController();
    const invocation = new TaskScope('invocation');
    ctl.track(invocation);
    ctl.untrack(invocation);
    const result = ctl.onDisconnect();
    expect(invocation.signal.aborted).toBe(false);
    expect(result.cancelled).toEqual([]);
    expect(result.preserved).toEqual([]);
  });

  it('reports exact cancelled/preserved sets for mixed scopes', () => {
    const ctl = new DisconnectController();
    const invocation = new TaskScope('invocation');
    const service = new TaskScope('service');
    const durable = new TaskScope('durable');
    ctl.track(invocation);
    ctl.track(service);
    ctl.track(durable);
    const result = ctl.onDisconnect();
    expect(result).toEqual({
      cancelled: ['invocation'],
      preserved: ['service', 'durable'],
    });
    expect(invocation.signal.aborted).toBe(true);
  });

  it('exposes the controller signal and starts unaborted', () => {
    const scope = new TaskScope('service');
    expect(scope.domain).toBe('service');
    expect(scope.signal).toBe(scope.controller.signal);
    expect(scope.signal.aborted).toBe(false);
  });

  it('disconnects cleanly with no tracked scopes', () => {
    const ctl = new DisconnectController();
    expect(ctl.onDisconnect()).toEqual({ cancelled: [], preserved: [] });
  });
});
