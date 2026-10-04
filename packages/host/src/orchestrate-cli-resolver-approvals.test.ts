// The conflict resolver is a DELEGATED child too (issue #156; §45.2, §41.2).
// A challenged call it raises (installing dependencies to settle a conflict is
// the shipped example) must reach the USER through the run's approval layer
// exactly as a worker's does. Before this, the resolver was spawned without
// the mailbox and never wrapped in beginWorker/pump/endWorker: the child had
// no surface, denied closed, exited 1, and the merge was reported
// `merge_conflict` — the "resolver runs under the same approval rules" claim
// held on paper only.
//
// Fakes only (faux in-process child, no provider, no network) and no temp
// files: the resolver's own mailbox traffic is real (the module under test is
// the real one), driven through the run's approvals layer.
import { describe, expect, it } from 'vitest';
import {
  MergeConflictError,
  type OrchestrateCommandDeps,
  type OrchestrateWorktree,
  type OrchestratorRunState,
  runOrchestrateCommand,
} from './orchestrate-cli.js';
import {
  awaitWorkerAskAnswer,
  createOrchestratorApprovalsRun,
  publishWorkerAsk,
  type WorkerApprovalsRun,
} from './orchestrator/approvals/worker-asks.js';
import type { MergedHunk } from './orchestrator/merge/attribution.js';
import type {
  ApprovalSnapshot,
  ResolverRequest,
} from './orchestrator/merge/conflicts.js';

const POLICY: ApprovalSnapshot = {
  route: 'ask-user',
  autoApprove: [],
  maxPendingMs: 60_000,
};

const CONFLICT_DIFFS = {
  oursDiff: 'diff --git a/shared.ts b/shared.ts\n+ours',
  theirsDiff: 'diff --git a/shared.ts b/shared.ts\n+theirs',
};

interface FakeWorld {
  deps: OrchestrateCommandDeps;
  lines: string[];
  debugLines: string[];
  raised: { agentId: string; trigger: string; role: string }[];
  saved: OrchestratorRunState[];
  resolverRuns: ResolverRequest[];
}

// One world per test: the real `runOrchestrateCommand` over fake seams, with a
// real approvals run behind the `approvals` factory (the same construction the
// composition root performs) and a resolver child that speaks the mailbox
// contract in-process, exactly as a spawned resolver does.
function makeWorld(options: {
  decide?: (request: {
    agentId: string;
    trigger: string;
  }) => { approved: true; by: 'user' } | { approved: false; reason: string };
}): FakeWorld {
  const lines: string[] = [];
  const debugLines: string[] = [];
  const raised: FakeWorld['raised'] = [];
  const saved: OrchestratorRunState[] = [];
  const resolverRuns: ResolverRequest[] = [];
  const hunks: MergedHunk[] = [{ path: 'a.txt', hunk: '@@ -0,0 +1 @@ +a' }];
  let approvals: WorkerApprovalsRun | undefined;
  let betaMerges = 0;
  const decide = options.decide ?? (() => ({ approved: true, by: 'user' }));
  const world: FakeWorld = {
    deps: {} as OrchestrateCommandDeps,
    lines,
    debugLines,
    raised,
    saved,
    resolverRuns,
  };
  world.deps = {
    out: (line: string) => {
      lines.push(line);
    },
    err: (line: string) => {
      lines.push(line);
    },
    debug: (line: string) => {
      debugLines.push(line);
    },
    now: () => 1700000000000,
    isGitRepo: () => true,
    ensureWorktree: (agentId: string): OrchestrateWorktree => ({
      path: `/repo/.kubic/wt/${agentId}`,
      branch: `kubic/${agentId}`,
    }),
    createWorkerSession: (input) => ({ sessionId: input.workerSessionId }),
    runWorker: () => hunks,
    mergeBranch: (agentId: string) => {
      // beta conflicts on its FIRST merge only: a resolver that settles it
      // lets the re-merge run clean, exactly as the real path does.
      if (agentId !== 'beta') return;
      betaMerges += 1;
      if (betaMerges === 1) {
        throw new MergeConflictError('beta', CONFLICT_DIFFS);
      }
    },
    reapWorker: () => undefined,
    requestApproval: () => true,
    approvalPolicy: POLICY,
    approvals: (approvalOptions) => {
      approvals = createOrchestratorApprovalsRun({
        dir: `/repo/.kubic/orchestrator-${approvalOptions.sessionId}`,
        sessionId: approvalOptions.sessionId,
        maxPendingMs: approvalOptions.maxPendingMs,
        pollMs: 5,
        seat: async (request) => {
          raised.push({
            agentId: request.agentId,
            trigger: request.trigger,
            role: request.role,
          });
          return decide(request);
        },
      });
      return approvals;
    },
    runResolver: async (request) => {
      resolverRuns.push(request);
      if (approvals === undefined) throw new Error('no approvals layer');
      // The resolver child's challenged call, as `headless-run` publishes it:
      // through the mailbox it was told about, under its own identity.
      const published = publishWorkerAsk(approvals.mailboxDir(), {
        trigger: 'install',
        toolName: 'bash',
        args: { command: 'npm install left-pad' },
        justification:
          'the resolver needs the dependency to settle the conflict',
        sessionId: 'sess-1-beta',
        agentId: request.agentId,
        role: 'implementer',
        worktree: request.worktree.path,
        provenance: { parentSessionId: 'sess-1' },
      });
      const answer = await awaitWorkerAskAnswer(
        approvals.mailboxDir(),
        published.request.key,
        {
          maxPendingMs: 300,
          pollMs: 5,
          verifyKey: approvals.verifyKey(),
          nonce: published.nonce,
        },
      );
      return answer.approved
        ? { resolved: true }
        : { resolved: false, reason: answer.reason };
    },
    saveState: (state: OrchestratorRunState) => {
      saved.push(structuredClone(state));
    },
  };
  return world;
}

const ARGS = {
  prompt: 'edit shared.ts in every worktree',
  agents: ['alpha', 'beta'],
  session: 'sess-1',
  yes: true,
};

describe('a resolver ask reaches the user through the run approval layer (issue #156)', () => {
  it('routes the challenged call to the seat and settles the conflict', async () => {
    const world = makeWorld({});
    const code = await runOrchestrateCommand(ARGS, world.deps);
    expect(code, world.lines.join('\n')).toBe(0);
    expect(world.resolverRuns).toHaveLength(1);
    // The ask the resolver raised reached the USER's seat, named the worker
    // whose worktree it reworked, and the role it ran as.
    expect(world.raised).toEqual([
      { agentId: 'beta', trigger: 'install', role: 'implementer' },
    ]);
  });

  it('still settles when nobody is asked (no approvals layer wired)', async () => {
    const world = makeWorld({});
    world.deps.approvals = undefined;
    world.deps.runResolver = async (request) => {
      world.resolverRuns.push(request);
      return { resolved: true };
    };
    const code = await runOrchestrateCommand(ARGS, world.deps);
    expect(code, world.lines.join('\n')).toBe(0);
    expect(world.raised).toEqual([]);
  });
});

describe('a denied resolver ask stops the queue with the denial named (issue #156)', () => {
  it('reports merge_conflict naming the refusal, never a silent resolver exit', async () => {
    const world = makeWorld({
      decide: () => ({
        approved: false,
        reason: 'the user declined the resolver ask',
      }),
    });
    const code = await runOrchestrateCommand(ARGS, world.deps);
    // The shipped conflict terminus, with the delegation outcome appended.
    expect(code).toBe(1);
    const failure = world.lines.join('\n');
    expect(failure).toMatch(/code=merge_conflict/);
    expect(failure).toContain('(resolver: ');
    expect(failure).toContain('the user declined the resolver ask');
    // The queue stopped where it always does: beta is preserved, not merged.
    const state = world.saved[world.saved.length - 1] as OrchestratorRunState;
    expect(state.stopped).toBe(true);
    expect(state.pending).toEqual(['beta']);
    // The denial is named on the debug channel too, with its named code.
    expect(world.debugLines.join('\n')).toMatch(/resolver 'beta' ended on/);
  });
});
