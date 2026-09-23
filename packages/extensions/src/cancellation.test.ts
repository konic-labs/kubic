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
