// Merge coordination + conflict delegation (issue #46; §9.2, §44.2,
// §45.2, §70). RED first: ordered settlement queue, workspace_diff per
// candidate → workspace_merge, conflict → writer resolver (implementer /
// debugger set, constraints + both diffs) → re-merge → apply or discard,
// unresolvable → stop + both sides preserved, journal attribution
// (diff --agent), per-agent merge telemetry (§61), reviewer-before-apply.
// The manager never authors: zero direct writes by construction.
import { describe, expect, it } from 'vitest';
import {
  attributeMergedHunks,
  diffArgsForAgent,
  filterEntriesByAgent,
} from './attribution.js';
import type { ResolverSpecInput } from './conflicts.js';
import {
  buildResolverSpec,
  dispatchResolverSpec,
  filesInDiff,
  hashApprovalPolicy,
  IMPLEMENTER_TOOLSET,
  RESOLVER_ALLOWED_ROLES,
  ResolverPolicyError,
} from './conflicts.js';
import { createMergeQueue, QueueStoppedError } from './queue.js';
import {
  assertReviewerReadonly,
  decideApplyAfterReview,
  REVIEWER_READONLY_TOOLS,
  ReviewerScopeError,
} from './review.js';
import {
  applySettlementAfterReview,
  assertManagerZeroWrites,
  MANAGER_MERGE_ALLOWLIST,
  MANAGER_WRITE_TOOLS,
  ManagerAuthoringError,
} from './settle.js';
import { recordMergeTelemetry, totalMergeMs } from './telemetry.js';

const POLICY = {
  route: 'ask-user',
  autoApprove: [],
  maxPendingMs: 60_000,
} as const;

function livePolicy(): {
  route: string;
  autoApprove: string[];
  maxPendingMs: number;
} {
  return {
    route: POLICY.route,
    autoApprove: [...POLICY.autoApprove],
    maxPendingMs: POLICY.maxPendingMs,
  };
}

function policyCarriage(): {
  approvalPolicy: {
    route: string;
    autoApprove: string[];
    maxPendingMs: number;
  };
  policyHash: string;
} {
  const approvalPolicy = livePolicy();
  return {
    approvalPolicy,
    policyHash: hashApprovalPolicy(approvalPolicy),
  };
}

describe('ordered settlement queue (issue #46)', () => {
  it('settles candidates in FIFO order', () => {
    const queue = createMergeQueue();
    queue.enqueue({ agentId: 'agent-1', branch: 'kubic/agent-1' });
    queue.enqueue({ agentId: 'agent-2', branch: 'kubic/agent-2' });
    expect(queue.list().map((entry) => entry.agentId)).toEqual([
      'agent-1',
      'agent-2',
    ]);
    expect(queue.dequeue()?.agentId).toBe('agent-1');
    expect(queue.dequeue()?.agentId).toBe('agent-2');
  });
});

describe('two-branch shared/types.ts conflict (issue #46 §85)', () => {
  it('reports the conflict, spawns a writer, re-merges; manager zero writes', () => {
    const spec = buildResolverSpec({
      agentId: 'agent-2',
      role: 'implementer',
      constraints: ['stay inside the worktree', 'no network installs'],
      oursDiff: 'diff --git a/shared/types.ts b/shared/types.ts\n+ours',
      theirsDiff: 'diff --git a/shared/types.ts b/shared/types.ts\n+theirs',
      ...policyCarriage(),
    });
    expect(spec.conflict.files).toContain('shared/types.ts');
    expect(RESOLVER_ALLOWED_ROLES).toEqual(['implementer', 'debugger']);
    expect(spec.tools).toContain('write');
    expect(spec.tools).toContain('bash');
    const managerCalls = [
      'spawn_agent',
      'workspace_diff',
      'workspace_merge',
      'spawn_agent',
      'workspace_merge',
      'workspace_apply',
    ];
    expect(() => assertManagerZeroWrites(managerCalls)).not.toThrow();
    expect(
      managerCalls.some((call) => MANAGER_WRITE_TOOLS.includes(call)),
    ).toBe(false);
  });
});

describe('unresolvable conflict (issue #46)', () => {
  it('stops the queue, surfaces both diffs, picks no winner', () => {
    const queue = createMergeQueue();
    queue.enqueue({ agentId: 'agent-1', branch: 'kubic/agent-1' });
    queue.enqueue({ agentId: 'agent-2', branch: 'kubic/agent-2' });
    queue.markUnresolvable('agent-1', {
      oursDiff: 'ours-patch',
      theirsDiff: 'theirs-patch',
    });
    expect(queue.status()).toBe('stopped');
    const blocked = queue.blocked();
    expect(blocked?.oursDiff).toBe('ours-patch');
    expect(blocked?.theirsDiff).toBe('theirs-patch');
    expect(blocked?.winner).toBeUndefined();
    expect(queue.list().map((entry) => entry.agentId)).toEqual([
      'agent-1',
      'agent-2',
    ]);
  });
});

describe('stopped queue refuses settlement (issue #46 fix)', () => {
  it('post-stop dequeue throws and preserves every candidate', () => {
    const queue = createMergeQueue();
    queue.enqueue({ agentId: 'agent-1', branch: 'kubic/agent-1' });
    queue.enqueue({ agentId: 'agent-2', branch: 'kubic/agent-2' });
    queue.markUnresolvable('agent-1', {
      oursDiff: 'ours-patch',
      theirsDiff: 'theirs-patch',
    });
    expect(queue.status()).toBe('stopped');
    expect(() => queue.dequeue()).toThrow(QueueStoppedError);
    expect(queue.list().map((entry) => entry.agentId)).toEqual([
      'agent-1',
      'agent-2',
    ]);
  });

  it('keeps a blocked record per agent instead of one overwritable slot', () => {
    const queue = createMergeQueue();
    queue.markUnresolvable('agent-1', {
      oursDiff: 'ours-1',
      theirsDiff: 'theirs-1',
    });
    queue.markUnresolvable('agent-2', {
      oursDiff: 'ours-2',
      theirsDiff: 'theirs-2',
    });
    expect(queue.blockedFor('agent-1')).toMatchObject({
      agentId: 'agent-1',
      oursDiff: 'ours-1',
    });
    expect(queue.blockedFor('agent-2')).toMatchObject({
      agentId: 'agent-2',
      oursDiff: 'ours-2',
    });
    expect(queue.blockedAll()).toHaveLength(2);
    expect(queue.blocked()?.agentId).toBe('agent-1');
  });

  it('same-agent double mark keeps the first record (first wins)', () => {
    const queue = createMergeQueue();
    queue.markUnresolvable('agent-1', {
      oursDiff: 'ours-first',
      theirsDiff: 'theirs-first',
    });
    queue.markUnresolvable('agent-1', {
      oursDiff: 'ours-second',
      theirsDiff: 'theirs-second',
    });
    expect(queue.blockedFor('agent-1')).toMatchObject({
      agentId: 'agent-1',
      oursDiff: 'ours-first',
      theirsDiff: 'theirs-first',
    });
    expect(queue.blockedAll()).toHaveLength(1);
  });

  it('enqueue after stop throws QueueStoppedError and preserves candidates', () => {
    const queue = createMergeQueue();
    queue.enqueue({ agentId: 'agent-1', branch: 'kubic/agent-1' });
    queue.markUnresolvable('agent-1', {
      oursDiff: 'ours-patch',
      theirsDiff: 'theirs-patch',
    });
    expect(() =>
      queue.enqueue({ agentId: 'agent-2', branch: 'kubic/agent-2' }),
    ).toThrow(QueueStoppedError);
    expect(queue.list().map((entry) => entry.agentId)).toEqual(['agent-1']);
  });
});

describe('manager merge allowlist (issue #46 fix)', () => {
  it('refuses authoring calls including the git_* write tools (fail-closed)', () => {
    for (const tool of [
      'write',
      'edit',
      'bash',
      'git_stage',
      'git_commit',
      'git_checkpoint',
      'git_branch',
      'totally_unknown_tool',
    ]) {
      expect(() => assertManagerZeroWrites([tool])).toThrow(/policy block/);
    }
  });

  it('passes read-only inspection plus the merge plumbing', () => {
    expect(() =>
      assertManagerZeroWrites([...MANAGER_MERGE_ALLOWLIST]),
    ).not.toThrow();
    expect(() => assertManagerZeroWrites(['read'])).not.toThrow();
  });

  it('the manager guard blocks git_commit the writer resolver keeps', () => {
    expect(IMPLEMENTER_TOOLSET).toContain('git_commit');
    expect(() => assertManagerZeroWrites(['git_commit'])).toThrow(
      /policy block/,
    );
  });

  it('MANAGER_WRITE_TOOLS names real authoring tools, never reads', () => {
    for (const tool of [
      'write',
      'edit',
      'bash',
      'git_stage',
      'git_commit',
      'git_checkpoint',
      'git_branch',
    ]) {
      expect(MANAGER_WRITE_TOOLS).toContain(tool);
    }
    for (const tool of ['read', 'ls', 'find', 'grep']) {
      expect(MANAGER_WRITE_TOOLS).not.toContain(tool);
    }
  });
});

describe('resolver under same approval + policy (issue #46)', () => {
  it('carries the identical approval snapshot and policy hash (no bypass)', () => {
    const spec = buildResolverSpec({
      agentId: 'agent-2',
      role: 'debugger',
      constraints: ['stay inside the worktree'],
      oursDiff: 'ours',
      theirsDiff: 'theirs',
      ...policyCarriage(),
    });
    expect(spec.approvalPolicy).toEqual(livePolicy());
    expect(spec.policyHash).toBe(hashApprovalPolicy(livePolicy()));
    expect(spec.role).toBe('debugger');
  });
});

describe('resolver spec verifies the approval policy (issue #46 fix)', () => {
  it('TRUSTED-CALLER contract: no live-policy parameter to forge through', () => {
    // Compile-time pin: ResolverSpecInput must not carry a live snapshot —
    // re-adding the parameter breaks tsc on this assertion.
    type HasLivePolicy = 'livePolicy' extends keyof ResolverSpecInput
      ? true
      : false;
    const contract: HasLivePolicy extends false ? true : never = true;
    expect(contract).toBe(true);
    // Runtime half: a self-consistent snapshot passes here even when weak.
    // Authenticity is established at the trust boundary (the manager lane
    // composition root passes its own live snapshot as approvalPolicy),
    // never by comparing against a caller-supplied second snapshot.
    const weak = livePolicy();
    weak.maxPendingMs = 3_600_000;
    const spec = buildResolverSpec({
      agentId: 'agent-2',
      role: 'implementer',
      constraints: [],
      oursDiff: 'ours',
      theirsDiff: 'theirs',
      approvalPolicy: weak,
      policyHash: hashApprovalPolicy(weak),
    });
    expect(spec.policyHash).toBe(hashApprovalPolicy(weak));
  });

  it('rejects a carried hash that does not match the snapshot', () => {
    const snapshot = livePolicy();
    expect(() =>
      buildResolverSpec({
        agentId: 'agent-2',
        role: 'implementer',
        constraints: [],
        oursDiff: 'ours',
        theirsDiff: 'theirs',
        approvalPolicy: snapshot,
        policyHash: 'stale-hash',
      }),
    ).toThrow(ResolverPolicyError);
  });

  it('freezes the carried snapshot so downstream cannot widen it', () => {
    const spec = buildResolverSpec({
      agentId: 'agent-2',
      role: 'debugger',
      constraints: [],
      oursDiff: 'ours',
      theirsDiff: 'theirs',
      ...policyCarriage(),
    });
    expect(Object.isFrozen(spec.approvalPolicy)).toBe(true);
    expect(Object.isFrozen(spec.approvalPolicy.autoApprove)).toBe(true);
  });
});

describe('filesInDiff hardening (issue #46 fix)', () => {
  it('parses quoted paths containing spaces', () => {
    expect(
      filesInDiff('diff --git "a/my file.ts" "b/my file.ts"\n+change'),
    ).toEqual(['my file.ts']);
  });

  it('returns the union of rename sides (a-side and b-side)', () => {
    expect(filesInDiff('diff --git a/old.ts b/new.ts\n+change')).toEqual([
      'new.ts',
      'old.ts',
    ]);
  });

  it('decodes git C-style octal UTF-8 in quoted paths', () => {
    expect(
      filesInDiff(
        'diff --git "a/\\303\\251 Selon.ts" "b/\\303\\251 Selon.ts"\n+change',
      ),
    ).toEqual(['é Selon.ts']);
  });

  it('decodes escaped quotes in quoted paths', () => {
    expect(
      filesInDiff('diff --git "a/we\\"ird.ts" "b/we\\"ird.ts"\n+change'),
    ).toEqual(['we"ird.ts']);
  });

  it('ignores non-diff inputs instead of crashing', () => {
    expect(filesInDiff('')).toEqual([]);
    expect(filesInDiff('just some log output\n--- a/file\n+++ b/file')).toEqual(
      [],
    );
  });

  it('surfaces quoted paths through the resolver spec', () => {
    const spec = buildResolverSpec({
      agentId: 'agent-1',
      role: 'implementer',
      constraints: [],
      oursDiff: 'diff --git "a/my file.ts" "b/my file.ts"\n+ours',
      theirsDiff: 'diff --git a/plain.ts b/plain.ts\n+theirs',
      ...policyCarriage(),
    });
    expect(spec.conflict.files).toEqual(['my file.ts', 'plain.ts']);
  });
});

describe('journal attribution post-merge (issue #46)', () => {
  it('diff --agent attributes merged hunks to the settling agent', () => {
    expect(diffArgsForAgent('agent-1')).toEqual(['diff', '--agent', 'agent-1']);
    const entries = [
      { path: 'shared/types.ts', agent: 'agent-1', hunk: '@@ -1 +1 @@' },
      { path: 'shared/types.ts', agent: 'agent-2', hunk: '@@ -9 +9 @@' },
    ];
    expect(filterEntriesByAgent(entries, 'agent-1')).toHaveLength(1);
    const hunks = attributeMergedHunks(
      [{ path: 'shared/types.ts', hunk: '@@ -1 +1 @@' }],
      'agent-1',
    );
    expect(hunks[0]).toMatchObject({ agent: 'agent-1' });
  });
});

describe('reviewer-before-apply (issue #46 §70)', () => {
  it('read-only reviewer verdicts; the manager applies or discards', () => {
    for (const banned of ['write', 'edit', 'bash', 'git_commit']) {
      expect(REVIEWER_READONLY_TOOLS).not.toContain(banned);
    }
    expect(decideApplyAfterReview({ verdict: 'accept' })).toBe('apply');
    expect(decideApplyAfterReview({ verdict: 'request-changes' })).toBe(
      'discard',
    );
    expect(decideApplyAfterReview({ verdict: 'escalate' })).toBe('discard');
  });
});

describe('reviewer read-only assert (issue #46 fix)', () => {
  it('passes the read-only toolset', () => {
    expect(() =>
      assertReviewerReadonly([...REVIEWER_READONLY_TOOLS]),
    ).not.toThrow();
  });

  it('fails write/edit/bash/git_commit', () => {
    for (const tool of ['write', 'edit', 'bash', 'git_commit']) {
      expect(() => assertReviewerReadonly([tool])).toThrow(ReviewerScopeError);
    }
  });
});

describe('settle apply path enforces the manager guard (issue #46 fix)', () => {
  it('applies after accept when the manager trace is clean', () => {
    let applied = 0;
    const decision = applySettlementAfterReview(
      ['spawn_agent', 'workspace_diff', 'workspace_merge'],
      { verdict: 'accept' },
      () => {
        applied += 1;
      },
    );
    expect(decision).toBe('apply');
    expect(applied).toBe(1);
  });

  it('discards without applying on request-changes', () => {
    let applied = 0;
    const decision = applySettlementAfterReview(
      ['spawn_agent', 'workspace_diff', 'workspace_merge'],
      { verdict: 'request-changes' },
      () => {
        applied += 1;
      },
    );
    expect(decision).toBe('discard');
    expect(applied).toBe(0);
  });

  it('blocks a tainted manager trace before applying (fail-closed)', () => {
    let applied = 0;
    expect(() =>
      applySettlementAfterReview(
        ['workspace_diff', 'write'],
        { verdict: 'accept' },
        () => {
          applied += 1;
        },
      ),
    ).toThrow(ManagerAuthoringError);
    expect(applied).toBe(0);
  });
});

describe('resolver-dispatch path enforces reviewer readonly (issue #46 fix)', () => {
  it('dispatches the resolver spec when the reviewer toolset is read-only', () => {
    const spec = dispatchResolverSpec(
      {
        agentId: 'agent-2',
        role: 'implementer',
        constraints: [],
        oursDiff: 'diff --git a/a.ts b/a.ts\n+ours',
        theirsDiff: 'diff --git a/a.ts b/a.ts\n+theirs',
        ...policyCarriage(),
      },
      [...REVIEWER_READONLY_TOOLS],
    );
    expect(spec.conflict.files).toEqual(['a.ts']);
    expect(spec.tools).toContain('write');
  });

  it('refuses dispatch when the reviewer toolset authors', () => {
    expect(() =>
      dispatchResolverSpec(
        {
          agentId: 'agent-2',
          role: 'implementer',
          constraints: [],
          oursDiff: 'ours',
          theirsDiff: 'theirs',
          ...policyCarriage(),
        },
        ['read', 'write'],
      ),
    ).toThrow(ReviewerScopeError);
  });
});

describe('manager lane plumbing on the merge path (issue #103)', () => {
  // The live manager lane records its own delegation calls as it drives a
  // worker to completion (spawn → wait → collect), and the merge path
  // asserts over the combined trace. Lane plumbing authors nothing, so the
  // authoring-scoped guard must pass it — while still refusing every
  // authoring tool, with or without plumbing alongside.
  it('passes the delegation trace a live lane records', () => {
    expect(() =>
      assertManagerZeroWrites([
        'spawn_agent',
        'workspace_diff',
        'workspace_merge',
        'workspace_apply',
        'spawn_agent',
        'wait_for_agent',
        'collect_result',
      ]),
    ).not.toThrow();
    expect(() => assertManagerZeroWrites(['send_to_agent'])).not.toThrow();
    expect(() => assertManagerZeroWrites(['ask_user'])).not.toThrow();
  });

  it('still refuses authoring even when lane plumbing is present', () => {
    for (const tool of ['write', 'edit', 'bash', 'git_commit']) {
      expect(() =>
        assertManagerZeroWrites(['wait_for_agent', 'collect_result', tool]),
      ).toThrow(new RegExp(tool));
    }
    // The forbidden set is unchanged: lane plumbing never becomes a write.
    expect(() => assertManagerZeroWrites(['send_to_agent', 'git_stage'])).toThrow(
      /policy block/,
    );
  });
});

describe('per-agent merge telemetry (issue #46 §61)', () => {
  it('records phase timings and totals per agent', () => {
    const record = recordMergeTelemetry({
      agentId: 'agent-1',
      queueMs: 5,
      diffMs: 10,
      mergeMs: 20,
      resolveMs: 0,
      applyMs: 7,
      outcome: 'merged',
    });
    expect(record.agentId).toBe('agent-1');
    expect(totalMergeMs(record)).toBe(42);
  });
});
