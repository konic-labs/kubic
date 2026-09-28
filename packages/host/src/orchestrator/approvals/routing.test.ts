// Orchestrator approval routing (issue #48; §41.2 deferred keyed-service).
// RED first: worker→user directly, manager read-only + refused, timeout
// denies, memoOnce settles races once and survives restarts.
import { describe, expect, it } from 'vitest';
import { buildOrchestratorRequest } from './request.js';
import {
  attemptManagerApprove,
  buildManagerBlockedIndicator,
  createOrchestratorRouter,
  MemoryDecisionStore,
} from './routing.js';

function req(key = 'net-1') {
  void key;
  return buildOrchestratorRequest({
    trigger: 'network',
    toolName: 'bash',
    args: { command: 'curl https://example.com' },
    justification: 'need release tarball',
    sessionId: 'sess-1',
    agentId: 'agent-1',
    role: 'implementer',
    worktree: '/wt/agent-1',
    provenance: { parentSessionId: 'root' },
  });
}

describe('orchestrator routing (issue #48)', () => {
  it('routes a worker network request to the user dialog, never the manager', async () => {
    const seen: string[] = [];
    const router = createOrchestratorRouter({
      maxPendingMs: 50,
      awaitAnswer: async (r) => {
        seen.push(r.trigger);
        return { approved: true, by: 'user' };
      },
    });
    const verdict = await router.request(req());
    expect(verdict).toEqual({ approved: true, by: 'user' });
    expect(seen).toEqual(['network']);
  });

  it('refuses the manager approve API and logs the refusal', () => {
    const audit: { type: string; detail: string }[] = [];
    const result = attemptManagerApprove(req(), {
      audit: (event) => {
        audit.push(event);
      },
    });
    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.reason).toMatch(/manager cannot approve/i);
    }
    expect(audit.some((e) => e.type === 'manager-approve-refused')).toBe(true);
  });

  it('exposes a manager read-only blocked indicator', () => {
    const indicator = buildManagerBlockedIndicator(req(), 'pending-user');
    expect(indicator.blocked).toBe(true);
    expect(indicator.decider).toBe('user');
    expect(indicator.readOnly).toBe(true);
    expect(JSON.stringify(indicator)).toMatch(/pending-user/);
  });

  it('denies on no-presentation timeout with a reason, never hangs', async () => {
    const router = createOrchestratorRouter({ maxPendingMs: 15 });
    const verdict = await router.request(req());
    expect(verdict.approved).toBe(false);
    if (!verdict.approved) {
      expect(verdict.reason).toMatch(/timed out|denied/i);
    }
    expect(router.pendingRequests()).toEqual([]);
  });

  it('memoOnce: restart never re-asks for a settled key', async () => {
    const store = new MemoryDecisionStore();
    let asks = 0;
    const first = createOrchestratorRouter({
      maxPendingMs: 50,
      store,
      awaitAnswer: async () => {
        asks += 1;
        return { approved: true, by: 'user' };
      },
    });
    const request = req();
    await first.request(request);
    expect(asks).toBe(1);
    const second = createOrchestratorRouter({
      maxPendingMs: 50,
      store,
      awaitAnswer: async () => {
        asks += 1;
        return { approved: true, by: 'user' };
      },
    });
    const verdict = await second.request(request);
    expect(verdict).toEqual({ approved: true, by: 'user' });
    expect(asks).toBe(1);
  });

  it('memoOnce: concurrent races settle once (single user prompt)', async () => {
    let asks = 0;
    // The user answers only once all three racers are in flight — an
    // explicit latch, not a wall-clock sleep.
    let answer: () => void = () => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const router = createOrchestratorRouter({
      maxPendingMs: 5_000,
      awaitAnswer: async () => {
        asks += 1;
        await answered;
        return { approved: true, by: 'user' };
      },
    });
    const request = req();
    const racing = Promise.all([
      router.request(request),
      router.request(request),
      router.request(request),
    ]);
    // One prompt is pending while the racers wait on it.
    expect(router.pendingRequests()).toHaveLength(1);
    answer();
    const [a, b, c] = await racing;
    expect(a).toEqual({ approved: true, by: 'user' });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(asks).toBe(1);
  });
});
