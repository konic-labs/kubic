// Per-worker approvals on the live delegation path (issue #105).
// RED first: the four modules in orchestrator/approvals/ are implemented and
// unreachable — a worker's network / destructive-shell / outside-write /
// install / push call never reaches them on `kubic orchestrate`. This file
// pins the wiring: worker asks route to the USER through a real
// createOrchestratorRouter (faux decider seat — no TTY, no network), the wait
// is bounded, budgets are opt-in per spawn, and the manager can only observe
// a read-only blocked indicator.
//
// The run drives the prod seam (`deps.approvals` + the ask mailbox) with
// git-free deps: the MANAGER half runs for real (creation, router, decisions,
// budgets, skip, audit), and the WORKER half speaks the same mailbox contract
// the prod child speaks (publish, then bounded wait) — so both halves of the
// cross-process channel are exercised by one test.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OrchestrateCommandDeps } from './orchestrate-cli.js';
import { runOrchestrateCommand } from './orchestrate-cli.js';
import type { OrchestratorApprovalRequest } from './orchestrator/approvals/request.js';
import {
  awaitWorkerAskAnswer,
  createOrchestratorApprovalsRun,
  orchestratorRequestKeyFor,
  type PublishedWorkerAsk,
  publishWorkerAsk,
  type WorkerApprovalsRun,
} from './orchestrator/approvals/worker-asks.js';
import type { MergedHunk } from './orchestrator/merge/attribution.js';

// Both halves must name the SAME session and agent set: prod threads the
// CLI's id and --agents list into the run, so the harness passes them.
const ORCHESTRATE_ARGS = [
  '-p',
  'do the work',
  '--session',
  'orch-105',
  '--agents',
  'worker-1',
];
const TWO_WORKER_ARGS = [
  '-p',
  'do the work',
  '--session',
  'orch-105',
  '--agents',
  'worker-1,worker-2',
];

function scratchRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

interface Harness {
  deps: OrchestrateCommandDeps;
  lines: string[];
  debugLines: string[];
  raised: OrchestratorApprovalRequest[];
  published: PublishedWorkerAsk[];
  approvals: WorkerApprovalsRun;
  dir: string;
}

type Decision = { approved: boolean; reason?: string };

interface HarnessOptions {
  maxPendingMs?: number;
  agents?: string[];
  budget?: unknown;
  fullAccess?: boolean;
  noSeat?: boolean;
  /** The trigger each worker raises; default `network` for worker-1. */
  triggerFor?: (agentId: string) => string;
  /** How many asks each worker raises (the child's own drive). */
  asksPerWorker?: number;
}

// The run under test. Only ONE thing is faked: the decider seat (the user's
// place in the dialog) — routing, decisions, budgets, skip and the mailbox are
// the real modules.
function harness(
  decide: (request: OrchestratorApprovalRequest) => Decision,
  options: HarnessOptions = {},
): Harness {
  const dir = scratchRoot('kubic-105-');
  const lines: string[] = [];
  const debugLines: string[] = [];
  const raised: OrchestratorApprovalRequest[] = [];
  const published: PublishedWorkerAsk[] = [];
  const approvals = createOrchestratorApprovalsRun({
    dir,
    sessionId: 'orch-105',
    maxPendingMs: options.maxPendingMs ?? 400,
    ...(options.noSeat === true
      ? {}
      : {
          seat: async (request: OrchestratorApprovalRequest) => {
            raised.push(request);
            const verdict = decide(request);
            return verdict.approved
              ? { approved: true, by: 'user' }
              : { approved: false, reason: verdict.reason ?? 'denied' };
          },
        }),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.fullAccess === true ? { fullAccess: true } : {}),
    debug: (line) => debugLines.push(line),
  });
  const mailbox = join(dir, 'approvals');
  const deps: OrchestrateCommandDeps = {
    out: (line) => lines.push(line),
    debug: (line) => debugLines.push(line),
    now: () => 1700000000000,
    isGitRepo: () => true,
    ensureWorktree: (agentId) => ({
      path: `/repo/.kubic/wt/${agentId}`,
      branch: `kubic/${agentId}`,
    }),
    createWorkerSession: (input) => ({ sessionId: input.workerSessionId }),
    // The worker half of the channel, as a real child drives it: publish each
    // ask, then wait the bounded time for the manager's answer. In-process
    // here (a child-process stand-in), but the CONTRACT is the prod one —
    // the same files, the same bound, the same denial-as-data.
    runWorker: async (agentId, worktree, _prompt, info) => {
      const trigger =
        options.triggerFor?.(agentId) ??
        (agentId === 'worker-2' ? 'destructive-shell' : 'network');
      const count = options.asksPerWorker ?? 1;
      for (let index = 0; index < count; index += 1) {
        const publishedAsk = publishWorkerAsk(mailbox, {
          trigger,
          toolName: 'bash',
          args: {
            command:
              trigger === 'network'
                ? `curl https://example.com/${index}.tgz`
                : `rm -rf /tmp/scratch-${index}`,
          },
          justification: `worker ${agentId} needs ${trigger} for step ${index}`,
          sessionId: info?.sessionId ?? 'orch-105',
          agentId,
          role: 'worker',
          worktree: worktree.path,
          provenance: { parentSessionId: info?.sessionId ?? 'orch-105' },
        });
        published.push(publishedAsk);
        const answer = await awaitWorkerAskAnswer(
          mailbox,
          publishedAsk.request.key,
          { maxPendingMs: 1_000, pollMs: 5 },
        );
        if (!answer.approved) {
          // A denial is a DISTINCT status the worker branches on — never a
          // crash. On the prod path the child reports it as its own §78
          // terminus; here it is surfaced so the manager's is asserted too.
          lines.push(`worker ${agentId}: ${answer.code} — ${answer.reason}`);
        }
      }
      const hunks: MergedHunk[] = [
        { path: `${agentId}.txt`, hunk: `@@ -0,0 +1 @@ +${agentId}` },
      ];
      return hunks;
    },
    mergeBranch: () => undefined,
    reapWorker: () => undefined,
    requestApproval: () => true,
    approvals: () => approvals,
  };
  return { deps, lines, debugLines, raised, published, approvals, dir };
}

describe('per-worker approvals on the delegation path (issue #105)', () => {
  it('AC1: routes two workers’ asks to the user with distinct keys; the denied worker ends with the named code', async () => {
    const h = harness((request) =>
      request.agentId === 'worker-1'
        ? { approved: true }
        : { approved: false, reason: 'removing /tmp/scratch is not needed' },
    );
    const code = await runOrchestrateCommand(TWO_WORKER_ARGS, h.deps);

    // Both workers raised asks; the decider answered one, denied the other.
    expect(h.raised.map((request) => request.agentId)).toEqual([
      'worker-1',
      'worker-2',
    ]);
    const [first, second] = h.raised as [
      OrchestratorApprovalRequest,
      OrchestratorApprovalRequest,
    ];
    // Distinct keys, and each is the RECOMPUTED key bound to
    // session + agent + justification + worktree + canonical args.
    expect(first.key).not.toBe(second.key);
    for (const [index, request] of h.raised.entries()) {
      const published = h.published[index] as PublishedWorkerAsk;
      expect(request.key).toMatch(/^[0-9a-f]{16}$/);
      expect(request.key).toBe(
        orchestratorRequestKeyFor(
          published.request.toolName,
          published.request.trigger,
          published.args,
          published.request.worktree,
          {
            sessionId: published.request.sessionId,
            agentId: published.request.agentId,
            justification: published.request.justification,
          },
        ),
      );
    }
    // The denial is the run's terminus, named: exit 4, code approval_denied,
    // the offending worker and trigger in the message.
    expect(code).toBe(4);
    const text = h.lines.join('\n');
    expect(text).toContain('code=approval_denied');
    expect(text).toContain('worker-2');
    expect(text).toContain('destructive-shell');
    // Durable decisions: the granted key and the denied key both settled.
    expect(h.approvals.decisions.decided(first.key)).toEqual({
      approved: true,
      by: 'user',
    });
    expect(h.approvals.decisions.decided(second.key)).toEqual({
      approved: false,
      reason: 'removing /tmp/scratch is not needed',
    });
    // One user prompt per worker; ask and denial are both audited.
    const audit = h.approvals.audit().map((event) => event.type);
    expect(
      audit.filter((type) => type === 'orchestrator-ask-raised'),
    ).toHaveLength(2);
    expect(audit).toContain('orchestrator-approval-denied');
    expect(h.approvals.decisions.pendingKeys()).toEqual([]);
  });

  it('AC2: a bounded wait times out to a denial with the named reason and never hangs', async () => {
    const h = harness(() => ({ approved: true }), {
      noSeat: true,
      maxPendingMs: 30,
      agents: ['worker-1'],
    });
    const started = Date.now();
    const code = await runOrchestrateCommand(ORCHESTRATE_ARGS, h.deps);
    const elapsed = Date.now() - started;

    expect(code).toBe(4);
    const text = h.lines.join('\n');
    // The worker side's own bound produced the named status...
    expect(text).toContain('approval_timeout');
    expect(text).toContain('timed out');
    // ...the user was never asked (no surface), and the manager's own bound
    // denied closed as well.
    expect(h.raised).toEqual([]);
    expect(h.approvals.decisions.pendingKeys()).toEqual([]);
    const denial = h.lines.find((line) => line.includes('code='));
    // The bound is the named terminus: approval_timeout (exit 4), with the
    // reason stating it timed out — never a hang and never a silent success.
    expect(denial).toContain('code=approval_timeout');
    expect(denial).toContain('timed out');
    // Bounded: the ask cannot outlive a small multiple of the configured
    // bound and the run cannot hang.
    expect(elapsed).toBeLessThan(10_000);
  });

  it('AC3: a configured budget terminates a worker as BUDGET_EXHAUSTED (exit 3); none configured applies no limit', async () => {
    // Configured for this spawn: maxToolCalls=1. The worker's SECOND brokered
    // dangerous call hits the gate, so the run ends 3-bound with the named
    // code.
    const limited = harness(() => ({ approved: true }), {
      agents: ['worker-1'],
      budget: { maxToolCalls: 1 },
      asksPerWorker: 2,
    });
    const code = await runOrchestrateCommand(
      ['-p', 'do the work'],
      limited.deps,
    );
    expect(code).toBe(3);
    expect(limited.lines.join('\n')).toContain('BUDGET_EXHAUSTED');
    // The second call never reached the user: the gate answers first.
    expect(limited.raised).toHaveLength(1);

    // None configured: the same two calls run to completion, no limit applied.
    const unlimited = harness(() => ({ approved: true }), {
      agents: ['worker-1'],
      asksPerWorker: 2,
    });
    const unlimitedCode = await runOrchestrateCommand(
      ORCHESTRATE_ARGS,
      unlimited.deps,
    );
    expect(unlimitedCode).toBe(0);
    expect(unlimited.lines.join('\n')).not.toContain('BUDGET_EXHAUSTED');
    expect(unlimited.approvals.budget()).toBeUndefined();
    expect(unlimited.raised).toHaveLength(2);

    // A worker self-raise of its own budget is refused, never applied.
    const raise = unlimited.approvals.requestBudgetRaise({
      agentId: 'worker-1',
      proposed: { maxToolCalls: 99 },
    });
    expect(raise.applied).toBe(false);
    expect(raise.reason).toMatch(/self-raise refused/i);
    expect(
      unlimited.approvals
        .audit()
        .some((event) => event.type === 'budget-self-raise-refused'),
    ).toBe(true);
  });

  it('AC4: the manager sees a read-only blocked indicator; a manager approve attempt is refused and audited', async () => {
    let indicators: unknown[] = [];
    let refusal: { approved: boolean; reason?: string } | undefined;
    let auditAtRefusal: readonly { type: string }[] = [];
    const h = harness(() => ({ approved: true }), { agents: ['worker-1'] });
    const deps: OrchestrateCommandDeps = {
      ...h.deps,
      runWorker: async (agentId, worktree, _prompt, info) => {
        // Publish the ask WITHOUT answering it yet, so the manager's read-only
        // view and its refused attempt are observed while it is pending.
        const published = publishWorkerAsk(join(h.dir, 'approvals'), {
          trigger: 'install',
          toolName: 'bash',
          args: { command: 'npm install left-pad' },
          justification: `worker ${agentId} needs the dependency installed`,
          sessionId: info?.sessionId ?? 'orch-105',
          agentId,
          role: 'worker',
          worktree: worktree.path,
          provenance: { parentSessionId: info?.sessionId ?? 'orch-105' },
        });
        h.published.push(published);
        indicators = h.approvals.blockedIndicators();
        refusal = h.approvals.managerApprove(published.request.key);
        auditAtRefusal = h.approvals.audit();
        await awaitWorkerAskAnswer(
          join(h.dir, 'approvals'),
          published.request.key,
          { maxPendingMs: 1_000, pollMs: 5 },
        );
        return [{ path: `${agentId}.txt`, hunk: 'x' }];
      },
    };
    const code = await runOrchestrateCommand(ORCHESTRATE_ARGS, deps);
    expect(code).toBe(0);

    // The indicator is read-only and names the user as the decider. It must
    // never be an approval: no verdict field on it at all.
    expect(indicators).toHaveLength(1);
    const indicator = indicators[0] as Record<string, unknown>;
    expect(indicator.blocked).toBe(true);
    expect(indicator.readOnly).toBe(true);
    expect(indicator.decider).toBe('user');
    expect('approved' in indicator).toBe(false);
    expect(JSON.stringify(indicator)).toContain('pending-user');

    // The manager's attempt was refused...
    expect(refusal?.approved).toBe(false);
    expect(refusal?.reason).toMatch(/manager cannot approve/i);
    // ...and lands in the audit log.
    expect(auditAtRefusal.map((event) => event.type)).toContain(
      'manager-approve-refused',
    );
    // The user's own answer still decided the ask — the refusal did not.
    expect(h.approvals.decisions.pendingKeys()).toEqual([]);
    expect(h.raised).toHaveLength(1);
  });

  it('AC5: the full-access posture is session-scoped, indicated, and enforced again for a fresh session', async () => {
    const h = harness(() => ({ approved: true }), {
      agents: ['worker-1'],
      fullAccess: true,
    });
    const code = await runOrchestrateCommand(ORCHESTRATE_ARGS, h.deps);
    expect(code).toBe(0);
    // The posture was indicated on the surface (never quiet).
    expect(h.debugLines.join('\n')).toMatch(/full-access approvals skipped/);
    expect(h.debugLines.join('\n')).toContain('orch-105');
    // The grant is session-scoped, not global.
    const granted = h.approvals.fullAccessGrant();
    expect(granted?.sessionId).toBe('orch-105');
    expect(granted?.scope).toBe('session');
    // And a fresh session with no opt-in starts enforced: the same ask prompts
    // the user again.
    const fresh = harness(() => ({ approved: true }), { agents: ['worker-1'] });
    const freshCode = await runOrchestrateCommand(ORCHESTRATE_ARGS, fresh.deps);
    expect(freshCode).toBe(0);
    expect(fresh.raised).toHaveLength(1);
    expect(fresh.approvals.fullAccessGrant()).toBeUndefined();
  });
});
