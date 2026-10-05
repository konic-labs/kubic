// Issue #409 (§41: a time-bounded ask denies on timeout): on the TUI
// `--orchestrator` path the router races the TUI seat against its own bound.
// When the bound expires the router denies — and the seat is now told (an
// AbortSignal), so the overlay withdraws exactly that ask, the next queued ask
// takes the screen, and a late answer is never recorded as a decision.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOrchestratorRequest } from '../../../packages/host/src/orchestrator/approvals/request.js';
import { createOrchestratorRouter } from '../../../packages/host/src/orchestrator/approvals/routing.js';
import { TIMEOUT_REASON_MARKER } from '../../../packages/host/src/orchestrator/approvals/worker-asks.js';
import { createApprovalSurface } from '../../../packages/tui/src/approval-surface.js';
import { createTuiApp } from '../../../packages/tui/src/tui-app.js';
import { workerAskSeatFromAnswer } from './tui-orchestrator.js';

afterEach(() => {
  vi.useRealTimers();
});

function ask(command: string) {
  return buildOrchestratorRequest({
    trigger: 'network',
    toolName: 'bash',
    args: { command },
    justification: 'needs the network',
    sessionId: 'sess-409',
    agentId: 'alpha',
    role: 'implementer',
    worktree: '/wt/alpha',
    provenance: { parentSessionId: 'root' },
  });
}

describe('router-bound expiry on the TUI seat (issue #409)', () => {
  it('withdraws the expired ask, shows the next, and never records a late answer', async () => {
    vi.useFakeTimers();
    const surface = createApprovalSurface({ armingMs: 0 });
    const router = createOrchestratorRouter({
      maxPendingMs: 50,
      awaitAnswer: workerAskSeatFromAnswer(surface.seat),
    });
    const firstRequest = ask('curl https://one.example');
    const first = router.request(firstRequest);
    await vi.advanceTimersByTimeAsync(30);
    expect(surface.pending()?.summary).toContain('one.example');
    const secondRequest = ask('curl https://two.example');
    const second = router.request(secondRequest);
    // 55 ms: the first ask's bound has expired, the second's has not.
    await vi.advanceTimersByTimeAsync(25);
    const verdict = await first;
    expect(verdict.approved).toBe(false);
    if (!verdict.approved)
      expect(verdict.reason).toContain(TIMEOUT_REASON_MARKER);
    // The overlay no longer shows the denied ask: the queued one took over.
    expect(surface.pending()?.summary).toContain('two.example');
    // The operator answers what is on screen — the SECOND ask — and the
    // first stays denied: the late key never lands on the expired request.
    expect(surface.decide('\x1b')).toBe(true);
    expect((await second).approved).toBe(false);
    expect(router.decided(firstRequest.key)?.approved).toBe(false);
    expect(surface.isShowing()).toBe(false);
  });

  it('the overlay frame drops the expired ask and shows the next one', async () => {
    vi.useFakeTimers();
    const surface = createApprovalSurface({ armingMs: 0 });
    const app = createTuiApp({
      sessionId: 'sess-409',
      model: 'faux/m',
      mode: 'orchestrator',
      approvalsSkipped: false,
      approvalSurface: surface,
    });
    // A recording overlay host: the frame is whatever overlay is shown and
    // not yet hidden (the live alt-screen composites exactly that).
    const overlays: Array<{
      render: (width: number) => string[];
      hidden: boolean;
    }> = [];
    app.attachApprovalOverlay({
      terminal: { columns: 120, rows: 30 },
      showOverlay: (component) => {
        const entry = {
          render: (width: number) =>
            (component as { render: (w: number) => string[] }).render(width),
          hidden: false,
        };
        overlays.push(entry);
        return {
          unfocus: () => {},
          hide: () => {
            entry.hidden = true;
          },
        };
      },
    });
    const frame = (): string =>
      overlays
        .filter((overlay) => !overlay.hidden)
        .flatMap((overlay) => overlay.render(100))
        .join('\n');
    const router = createOrchestratorRouter({
      maxPendingMs: 50,
      awaitAnswer: workerAskSeatFromAnswer(surface.seat),
    });
    const first = router.request(ask('curl https://one.example'));
    await vi.advanceTimersByTimeAsync(30);
    expect(frame()).toContain('one.example');
    const second = router.request(ask('curl https://two.example'));
    await vi.advanceTimersByTimeAsync(25);
    await first;
    expect(frame()).not.toContain('one.example');
    expect(frame()).toContain('two.example');
    surface.decide('\x1b');
    await second;
    expect(frame()).toBe('');
  });

  it('the seat receives an AbortSignal that aborts when the router bound expires', async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const router = createOrchestratorRouter({
      maxPendingMs: 20,
      awaitAnswer: (_request, signal) => {
        seen = signal;
        return new Promise(() => {});
      },
    });
    const verdict = router.request(ask('curl https://x.example'));
    expect(seen?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(25);
    expect((await verdict).approved).toBe(false);
    expect(seen?.aborted).toBe(true);
  });
});
