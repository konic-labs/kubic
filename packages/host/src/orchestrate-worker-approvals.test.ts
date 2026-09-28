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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  MergeDecisionRecord,
  OrchestrateCliOptions,
  OrchestrateCommandDeps,
  ParsedBudgetSpec,
} from './orchestrate-cli.js';
import {
  ORCHESTRATE_APPROVAL_BOUND_MS,
  parseBudgetSpec,
  runOrchestrateCommand,
  workerApprovalBoundMs,
} from './orchestrate-cli.js';
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
const ORCHESTRATE_ARGS: OrchestrateCliOptions = {
  prompt: 'do the work',
  session: 'orch-105',
  agents: ['worker-1'],
};
const TWO_WORKER_ARGS: OrchestrateCliOptions = {
  prompt: 'do the work',
  session: 'orch-105',
  agents: ['worker-1', 'worker-2'],
};

// The `--budget` value as the CLI parses it (a malformed spec is refused
// there, so a test spec must parse).
function budgetSpec(raw: string): ParsedBudgetSpec {
  const spec = parseBudgetSpec(raw);
  if (spec === undefined) throw new Error(`bad budget spec: ${raw}`);
  return spec;
}

// Every scratch dir is removed after each test (worktrees live under the repo
// root, so removing it disposes them too) — nothing accumulates in tmpdir.
const scratchDirs: string[] = [];

function scratchRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Harness {
  deps: OrchestrateCommandDeps;
  lines: string[];
  debugLines: string[];
  raised: OrchestratorApprovalRequest[];
  published: PublishedWorkerAsk[];
  /** Every merge-gate decision the CLI reported for the §60 ledger. */
  merges: MergeDecisionRecord[];
  /** How often the merge gate's decider was consulted. */
  mergeAsks: () => number;
  /** The layer the CLI constructed through `deps.approvals`. */
  readonly approvals: WorkerApprovalsRun;
  dir: string;
}

type Decision = { approved: boolean; reason?: string };

interface HarnessOptions {
  maxPendingMs?: number;
  agents?: string[];
  noSeat?: boolean;
  /** The trigger each worker raises; default `network` for worker-1. */
  triggerFor?: (agentId: string) => string;
  /** How many asks each worker raises (the child's own drive). */
  asksPerWorker?: number;
  /** The merge gate's decider; default approves every merge. */
  mergeDecider?: () => boolean;
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
  const merges: MergeDecisionRecord[] = [];
  let mergeAskCount = 0;
  let built: WorkerApprovalsRun | undefined;
  const mailbox = join(dir, 'approvals');
  const deps: OrchestrateCommandDeps = {
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
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
    requestApproval: () => {
      mergeAskCount += 1;
      return options.mergeDecider?.() ?? true;
    },
    auditMerge: (record) => merges.push(record),
    // The production seam, faithfully: the CLI owns the run options and the
    // composition root BUILDS the layer from them. A harness that fabricated
    // its own run here would pass while prod dropped an option on the floor —
    // which is exactly how the per-spawn budget override went missing.
    approvals: (cliOptions) => {
      built = createOrchestratorApprovalsRun({
        dir,
        sessionId: cliOptions.sessionId,
        // The manager's mailbox pump at the worker half's own 5ms cadence
        // (prod default 100ms): each ask settles in one tick, not a tenth of
        // a second of idle wall clock.
        pollMs: 5,
        maxPendingMs: options.maxPendingMs ?? cliOptions.maxPendingMs,
        ...(cliOptions.budget === undefined
          ? {}
          : { budget: cliOptions.budget }),
        ...(cliOptions.budgetForAgent === undefined
          ? {}
          : { budgetForAgent: cliOptions.budgetForAgent }),
        ...(cliOptions.fullAccess === true ? { fullAccess: true } : {}),
        ...(options.noSeat === true
          ? {}
          : {
              seat: async (request: OrchestratorApprovalRequest) => {
                raised.push(request);
                const verdict = decide(request);
                return verdict.approved
                  ? { approved: true, by: 'user' as const }
                  : { approved: false, reason: verdict.reason ?? 'denied' };
              },
            }),
        debug: (line) => debugLines.push(line),
      });
      return built;
    },
  };
  return {
    deps,
    lines,
    debugLines,
    raised,
    published,
    merges,
    mergeAsks: () => mergeAskCount,
    get approvals(): WorkerApprovalsRun {
      if (built === undefined) {
        throw new Error('the CLI never constructed the approvals layer');
      }
      return built;
    },
    dir,
  };
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
      asksPerWorker: 2,
    });
    const code = await runOrchestrateCommand(
      {
        prompt: 'do the work',
        agents: ['worker-1'],
        budget: budgetSpec('maxToolCalls=1'),
      },
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

  it('AC3b: `--budget <agent>:<dims>` scopes an override to THAT spawn and never widens another', async () => {
    // Shared spec: 2 tool calls (worker-2 can do its two and finish).
    // Per-spawn override for worker-1: ZERO calls allowed — the very first
    // brokered call must exhaust it, so the run ends 3-bound on worker-1.
    const h = harness(() => ({ approved: true }), {
      agents: ['worker-1'],
      // Two brokered calls: the first consumes the single allowance, the
      // second exceeds it and is blocked before it can reach the user.
      asksPerWorker: 2,
    });
    const code = await runOrchestrateCommand(
      {
        prompt: 'do the work',
        agents: ['worker-1'],
        budget: budgetSpec('worker-1:maxToolCalls=1'),
      },
      h.deps,
    );
    expect(code).toBe(3);
    expect(h.lines.join('\n')).toContain('BUDGET_EXHAUSTED');
    // The gate in force for THAT spawn was the OVERRIDE — not a default, and
    // not a shared spec (none was given here).
    const inForce = h.approvals.budgetFor('worker-1') as
      | Record<string, unknown>
      | undefined;
    expect(inForce).toEqual({ maxToolCalls: 1 });
    // No shared spec was configured, so the RUN-level budget stays empty: an
    // override never silently becomes a limit for the whole run.
    expect(h.approvals.budget()).toBeUndefined();

    // And with NO budget on the flag at all, the same worker does two calls
    // with no limit: the override cannot leak into a spawn the user did not
    // budget, and absence still enforces nothing.
    const clean = harness(() => ({ approved: true }), {
      agents: ['worker-1'],
      asksPerWorker: 2,
    });
    const cleanCode = await runOrchestrateCommand(
      { prompt: 'do the work', agents: ['worker-1'] },
      clean.deps,
    );
    expect(cleanCode).toBe(0);
    expect(clean.approvals.budget()).toBeUndefined();
    expect(clean.raised).toHaveLength(2);
  });

  it('AC5: the full-access posture is session-scoped, indicated, and enforced again for a fresh session', async () => {
    const h = harness(() => ({ approved: true }), { agents: ['worker-1'] });
    const code = await runOrchestrateCommand(
      {
        prompt: 'do the work',
        session: 'orch-105',
        agents: ['worker-1'],
        fullAccess: true,
      },
      h.deps,
    );
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

// Issue #323 (§41.2, §41.4): `--yes` is the user's standing answer for the
// MERGE gate only. It is never an inferred blanket approval of a worker's
// dangerous call — that would be undeclared full access, audited as if the
// user had answered.
describe('--yes answers the merge gate only (issue #323)', () => {
  it('a worker destructive-shell ask under --yes with no seat denies closed (exit 4) and is never approved', async () => {
    const h = harness(() => ({ approved: true }), {
      noSeat: true,
      maxPendingMs: 30,
      triggerFor: () => 'destructive-shell',
    });
    const code = await runOrchestrateCommand(
      { ...ORCHESTRATE_ARGS, yes: true },
      h.deps,
    );
    expect(code).toBe(4);
    const [ask] = h.published as [PublishedWorkerAsk];
    expect(h.approvals.decisions.decided(ask.request.key)).toMatchObject({
      approved: false,
    });
    const text = h.lines.join('\n');
    expect(text).toContain('worker worker-1: approval_');
    expect(text).not.toContain('code=completed');
    // Nothing merged: the run stopped at the denied worker.
    expect(h.merges).toEqual([]);
  });

  it('a worker ask under --yes on a run WITH a seat still reaches the seat', async () => {
    const h = harness(() => ({ approved: false, reason: 'no' }), {
      triggerFor: () => 'destructive-shell',
    });
    const code = await runOrchestrateCommand(
      { ...ORCHESTRATE_ARGS, yes: true },
      h.deps,
    );
    expect(h.raised).toHaveLength(1);
    expect(code).toBe(4);
  });

  it('--yes still auto-approves the merge gate without consulting the decider', async () => {
    const h = harness(() => ({ approved: true }), {
      mergeDecider: () => false,
    });
    const code = await runOrchestrateCommand(
      { ...ORCHESTRATE_ARGS, yes: true },
      h.deps,
    );
    expect(code).toBe(0);
    expect(h.mergeAsks()).toBe(0);
    expect(h.merges).toEqual([
      {
        agentId: 'worker-1',
        branch: 'kubic/worker-1',
        approved: true,
        by: '--yes',
        sessionId: 'orch-105',
      },
    ]);
  });

  it('an interactive merge approval is recorded as by:user, a denial as denied', async () => {
    const approved = harness(() => ({ approved: true }));
    expect(await runOrchestrateCommand(ORCHESTRATE_ARGS, approved.deps)).toBe(
      0,
    );
    expect(approved.merges).toEqual([
      {
        agentId: 'worker-1',
        branch: 'kubic/worker-1',
        approved: true,
        by: 'user',
        sessionId: 'orch-105',
      },
    ]);
    const denied = harness(() => ({ approved: true }), {
      mergeDecider: () => false,
    });
    expect(await runOrchestrateCommand(ORCHESTRATE_ARGS, denied.deps)).toBe(4);
    expect(denied.merges).toEqual([
      {
        agentId: 'worker-1',
        branch: 'kubic/worker-1',
        approved: false,
        by: 'user',
        reason: 'denied',
        sessionId: 'orch-105',
      },
    ]);
  });
});

// Issue #324: a worker write into Kubic's control plane always reaches the
// user — the session's full-access posture never answers it.
describe('kubic-state-write under --full-access (issue #324)', () => {
  it('still goes to the seat; a denial ends the run with exit 4', async () => {
    const h = harness(() => ({ approved: false, reason: 'not my config' }), {
      triggerFor: () => 'kubic-state-write',
    });
    const code = await runOrchestrateCommand(
      { ...ORCHESTRATE_ARGS, fullAccess: true },
      h.deps,
    );
    expect(h.raised.map((request) => request.trigger)).toEqual([
      'kubic-state-write',
    ]);
    expect(code).toBe(4);
  });
});

describe('the worker-ask bound reads config maxPendingMs (issue #230)', () => {
  it('builds the approvals run with the config snapshot bound', async () => {
    const h = harness(() => ({ approved: true }), { agents: ['worker-1'] });
    const bounds: number[] = [];
    const build = h.deps.approvals;
    if (build === undefined) throw new Error('harness has no approvals seam');
    const code = await runOrchestrateCommand(ORCHESTRATE_ARGS, {
      ...h.deps,
      approvalPolicy: {
        route: 'ask-user',
        autoApprove: [],
        maxPendingMs: 4321,
      },
      approvals: (options) => {
        bounds.push(options.maxPendingMs);
        return build(options);
      },
    });
    expect(code).toBe(0);
    expect(bounds).toEqual([4321]);
  });

  it('falls back to the run-level default without a config snapshot', async () => {
    const h = harness(() => ({ approved: true }), { agents: ['worker-1'] });
    const bounds: number[] = [];
    const build = h.deps.approvals;
    if (build === undefined) throw new Error('harness has no approvals seam');
    await runOrchestrateCommand(ORCHESTRATE_ARGS, {
      ...h.deps,
      approvals: (options) => {
        bounds.push(options.maxPendingMs);
        return build(options);
      },
    });
    expect(bounds).toEqual([ORCHESTRATE_APPROVAL_BOUND_MS]);
  });

  it('keeps the child bound strictly below the manager bound', () => {
    for (const manager of [2, 10, 500, 60_000, 600_000]) {
      const child = workerApprovalBoundMs(manager);
      expect(child).toBeGreaterThan(0);
      expect(child).toBeLessThan(manager);
    }
    expect(workerApprovalBoundMs(60_000)).toBe(55_000);
    expect(workerApprovalBoundMs(500)).toBe(450);
    expect(workerApprovalBoundMs(1)).toBe(1);
  });
});
