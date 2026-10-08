// The approval SEAT's cancellation on the composition path ("maxPendingMs …
// then deny, not hang"). When the service's bound expires the call is denied —
// and the question must go away with it: the TUI surface must not keep showing
// the obsolete ask, blocking the next real ask behind it, or drop a late approval
// without a word.
//
// This file lives in the composition root because it is the only place that
// may import BOTH sides: the host's ApprovalService and the TUI's
// ApprovalSurface (host -> tui is a forbidden dependency edge, enforced by
// `npm run lint:deps`).
//
// Fake timers only, fakes only — no network, no paid tokens, no temp files.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ApprovalRequest,
  ApprovalService,
  MemoryApprovalStore,
  validatePolicy,
} from '../../../packages/host/src/approvals.js';
import { createApprovalSurface } from '../../../packages/tui/src/approval-surface.js';

afterEach(() => {
  vi.useRealTimers();
});

function ask(key: string, capability = 'destructive-shell'): ApprovalRequest {
  return { key, capability, toolName: 'bash', summary: 'rm -rf /tmp/x' };
}

// The service over a REAL surface: the composition root's own shape
// (`installPolicy({ answer: surface.seat })`).
function serviceOver(surface: ReturnType<typeof createApprovalSurface>) {
  return new ApprovalService({
    policy: validatePolicy({ route: 'ask-user', maxPendingMs: 1_000 }),
    store: new MemoryApprovalStore(),
    awaitAnswer: (request, signal) => surface.seat(request, signal),
  });
}

describe('a service timeout withdraws the seat', () => {
  it('aborts the seat, clears the shown ask, and shows the next queued one', async () => {
    vi.useFakeTimers();
    const surface = createApprovalSurface({ armingMs: 0 });
    const service = serviceOver(surface);
    const first = service.request(ask('k-1'));
    // The next ask is already queued behind the shown one.
    const second = surface.ask(ask('k-2'));
    expect(surface.pending()?.key).toBe('k-1');

    await vi.advanceTimersByTimeAsync(1_000);

    const verdict = await first;
    expect(verdict.approved).toBe(false);
    if (!verdict.approved) expect(verdict.reason).toMatch(/timed out/);
    // The obsolete question is gone and the queued one took its place.
    expect(surface.pending()?.key).toBe('k-2');
    // …and answering NOW settles the second ask, not the withdrawn one.
    expect(surface.decide('a')).toBe(true);
    await expect(second).resolves.toMatchObject({ approved: true });
  });

  it('a decide() after the timeout has no effect and returns false', async () => {
    vi.useFakeTimers();
    const surface = createApprovalSurface({ armingMs: 0 });
    const service = serviceOver(surface);
    const first = service.request(ask('k-1'));

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(first).resolves.toMatchObject({ approved: false });
    expect(surface.pending()).toBeUndefined();
    expect(surface.decide('a')).toBe(false);
    expect(surface.decide('s')).toBe(false);
  });

  it('a late seat answer never overturns the timeout denial', async () => {
    vi.useFakeTimers();
    const surface = createApprovalSurface({ armingMs: 0 });
    const service = serviceOver(surface);
    const first = service.request(ask('k-1'));
    await vi.advanceTimersByTimeAsync(1_000);
    const verdict = await first;
    expect(verdict.approved).toBe(false);
    // The withdrawn ask is unanswerable, so the denial stands (a latched
    // approval must not appear after the user never decided).
    expect(surface.decide('a')).toBe(false);
    expect(service.decided('k-1')).toBeUndefined();
  });
});
