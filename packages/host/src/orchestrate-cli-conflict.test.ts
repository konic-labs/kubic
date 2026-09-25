// Conflict delegation on the live orchestrate path (issue #106; §9.2, §45.2).
// RED first: a genuine merge conflict stopped the queue with the candidates
// preserved, but the §45.2 writer-resolver spec — the module that exists
// precisely so the manager never resolves a conflict itself — was never built
// and no resolver was ever spawned. These tests drive the REAL
// `runOrchestrateCommand`; the resolver runs through an injected spawn seam
// (the composition root's worker seam) under the SAME approval snapshot the
// manager holds (no second policy, no bypass).
import { describe, expect, it } from 'vitest';
import type {
  OrchestrateCommandDeps,
  OrchestrateWorktree,
  OrchestratorRunState,
} from './orchestrate-cli.js';
import {
  MANAGER_INSPECTION_SEQUENCE,
  MergeConflictError,
  runOrchestrateCommand,
} from './orchestrate-cli.js';
import type { MergedHunk } from './orchestrator/merge/attribution.js';
import type {
  ApprovalSnapshot,
  ResolverRequest,
} from './orchestrator/merge/conflicts.js';
import {
  hashApprovalPolicy,
  IMPLEMENTER_TOOLSET,
  REVIEWER_READONLY_TOOLS,
  ResolverPolicyError,
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

// Every merge attempt is recorded BEFORE it is judged, so the recorded
// sequence proves how many times the manager actually tried to merge — the
// resolver leg has to show up as a real second attempt, not as a claim.
function conflictOnce(merged: string[]): (agentId: string) => void {
  let attempts = 0;
  return (agentId: string) => {
    merged.push(agentId);
    if (agentId === 'beta') {
      attempts += 1;
      if (attempts === 1) {
        throw new MergeConflictError('beta', CONFLICT_DIFFS);
      }
    }
  };
}

interface FakeWorld {
  deps: OrchestrateCommandDeps;
  lines: string[];
  debugLines: string[];
  merged: string[];
  resolverRuns: ResolverRequest[];
  saved: OrchestratorRunState[];
}

function makeWorld(overrides: Partial<OrchestrateCommandDeps> = {}): FakeWorld {
  const lines: string[] = [];
  const debugLines: string[] = [];
  const merged: string[] = [];
  const resolverRuns: ResolverRequest[] = [];
  const saved: OrchestratorRunState[] = [];
  const hunks: MergedHunk[] = [{ path: 'a.txt', hunk: '@@ -0,0 +1 @@ +a' }];
  const world: FakeWorld = {
    deps: {} as OrchestrateCommandDeps,
    lines,
    debugLines,
    merged,
    resolverRuns,
    saved,
  };
  world.deps = {
    out: (line: string) => {
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
      merged.push(agentId);
    },
    reapWorker: () => undefined,
    requestApproval: () => true,
    approvalPolicy: POLICY,
    runResolver: async (request) => {
      resolverRuns.push(request);
      return { resolved: true };
    },
    saveState: (state: OrchestratorRunState) => {
      saved.push(structuredClone(state));
    },
    ...overrides,
  };
  return world;
}

describe('orchestrate conflict delegation (issue #106, §45.2)', () => {
  it('delegates a genuine conflict to a resolver and settles through it', async () => {
    const world = makeWorld({ mergeBranch: conflictOnce([]) });
    world.deps.mergeBranch = conflictOnce(world.merged);
    const code = await runOrchestrateCommand(
      ['-p', 'do it', '--agents', 'alpha,beta', '--session', 'sess-1', '--yes'],
      world.deps,
    );
    expect(code).toBe(0);
    // alpha merged, beta conflicted, the resolver settled it, beta re-merged.
    expect(world.merged).toEqual(['alpha', 'beta', 'beta']);
    expect(world.resolverRuns).toHaveLength(1);
    const state = world.saved[world.saved.length - 1] as OrchestratorRunState;
    expect(state.stopped).toBe(false);
    expect(state.merged).toEqual(['alpha', 'beta']);
    expect(state.pending).toEqual([]);
    expect(state.records.map((record) => record.agentId)).toEqual([
      'alpha',
      'beta',
    ]);
    expect(world.debugLines.join('\n')).toMatch(/resolved: beta/);
  });

  it('spawns the resolver under the manager approval snapshot and toolset', async () => {
    const world = makeWorld({ mergeBranch: conflictOnce([]) });
    world.deps.mergeBranch = conflictOnce(world.merged);
    await runOrchestrateCommand(
      ['-p', 'do it', '--agents', 'alpha,beta', '--session', 'sess-1', '--yes'],
      world.deps,
    );
    const request = world.resolverRuns[0] as ResolverRequest;
    const { spec } = request;
    // Same approval rules as the manager — the §45.2 no-bypass claim is a
    // value here, not a sentence.
    expect(spec.approvalPolicy).toEqual(POLICY);
    expect(spec.approvalPolicy).toEqual(world.deps.approvalPolicy);
    expect(spec.policyHash).toBe(hashApprovalPolicy(POLICY));
    // The writer tool set, never the manager's.
    expect(spec.tools).toEqual([...IMPLEMENTER_TOOLSET]);
    expect(spec.role).toBe('implementer');
    // Both diffs travel with the spec, and the files come from BOTH sides.
    expect(spec.conflict.oursDiff).toContain('+ours');
    expect(spec.conflict.theirsDiff).toContain('+theirs');
    expect(spec.conflict.files).toEqual(['shared.ts']);
    // The resolver reworks the conflicted worker's own worktree.
    expect(request.agentId).toBe('beta');
    expect(request.worktree.path).toBe('/repo/.kubic/wt/beta');
    expect(request.prompt).toContain('shared.ts');
  });

  it('stops the queue exactly as today when the resolver cannot settle it', async () => {
    const world = makeWorld({
      mergeBranch: conflictOnce([]),
      runResolver: async (request) => {
        world.resolverRuns.push(request);
        return {
          resolved: false,
          reason: 'both sides rewrite the same symbol',
        };
      },
    });
    world.deps.mergeBranch = conflictOnce(world.merged);
    const code = await runOrchestrateCommand(
      ['-p', 'do it', '--agents', 'alpha,beta', '--session', 'sess-1', '--yes'],
      world.deps,
    );
    expect(code).toBe(1);
    expect(world.lines.join('\n')).toMatch(/code=merge_conflict/);
    // Exactly one merge attempt for beta and no re-merge: a resolver that
    // reports it could not settle never gets a second chance.
    expect(world.merged).toEqual(['alpha', 'beta']);
    expect(world.resolverRuns).toHaveLength(1);
    const state = world.saved[world.saved.length - 1] as OrchestratorRunState;
    expect(state.stopped).toBe(true);
    expect(state.merged).toEqual(['alpha']);
    expect(state.pending).toEqual(['beta']);
    expect(state.blocked?.agentId).toBe('beta');
  });

  it('stops the queue exactly as today when no resolver seam is wired', async () => {
    const world = makeWorld({
      mergeBranch: conflictOnce([]),
      runResolver: undefined,
    });
    world.deps.mergeBranch = conflictOnce(world.merged);
    const code = await runOrchestrateCommand(
      ['-p', 'do it', '--agents', 'alpha,beta', '--session', 'sess-1', '--yes'],
      world.deps,
    );
    expect(code).toBe(1);
    expect(world.lines.join('\n')).toMatch(/code=merge_conflict/);
    expect(world.resolverRuns).toEqual([]);
    const state = world.saved[world.saved.length - 1] as OrchestratorRunState;
    expect(state.stopped).toBe(true);
  });

  it('refuses to delegate without the manager snapshot (no fabricated policy)', async () => {
    // A resolver spawn needs a snapshot to carry. Absent one, the run fails
    // closed as today rather than inventing a policy the manager never held.
    const world = makeWorld({
      mergeBranch: conflictOnce([]),
      approvalPolicy: undefined,
    });
    world.deps.mergeBranch = conflictOnce(world.merged);
    const code = await runOrchestrateCommand(
      ['-p', 'do it', '--agents', 'alpha,beta', '--session', 'sess-1', '--yes'],
      world.deps,
    );
    expect(code).toBe(1);
    expect(world.lines.join('\n')).toMatch(/code=merge_conflict/);
    expect(world.resolverRuns).toEqual([]);
  });

  it('fails closed when the carried policy hash does not match the snapshot', async () => {
    // The resolver spec re-checks the carried hash (self-consistency). A
    // stale hash must refuse the spawn, never widen the policy.
    const world = makeWorld({
      mergeBranch: conflictOnce([]),
      policyHash: 'stale-hash',
    });
    world.deps.mergeBranch = conflictOnce(world.merged);
    const code = await runOrchestrateCommand(
      ['-p', 'do it', '--agents', 'alpha,beta', '--session', 'sess-1', '--yes'],
      world.deps,
    );
    expect(code).toBe(1);
    expect(world.resolverRuns).toEqual([]);
    expect(world.lines.join('\n')).toMatch(/code=merge_conflict/);
    expect(world.lines.join('\n')).toMatch(
      /resolver approval hash mismatch|no bypass/,
    );
  });

  it('the manager inspection toolset is the reviewer read-only set', () => {
    // The §45.2 reviewer-before-resolver step inspects the conflict with the
    // manager's own read-only tools. Pin the live set equal to the reviewer's,
    // so dispatchResolverSpec's read-only assert proves the REAL toolset
    // instead of a filtered copy of itself.
    expect([...MANAGER_INSPECTION_SEQUENCE]).toEqual([
      ...REVIEWER_READONLY_TOOLS,
    ]);
    expect(MANAGER_INSPECTION_SEQUENCE.length).toBeGreaterThan(0);
    expect(ResolverPolicyError.name).toBe('ResolverPolicyError');
  });
});
