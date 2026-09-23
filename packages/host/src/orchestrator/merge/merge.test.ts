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
import { buildResolverSpec, RESOLVER_ALLOWED_ROLES } from './conflicts.js';
import { createMergeQueue } from './queue.js';
import { decideApplyAfterReview, REVIEWER_READONLY_TOOLS } from './review.js';
import { assertManagerZeroWrites, MANAGER_WRITE_TOOLS } from './settle.js';
import { recordMergeTelemetry, totalMergeMs } from './telemetry.js';

const POLICY = {
  route: 'ask-user',
  autoApprove: [],
  maxPendingMs: 60_000,
} as const;

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
      approvalPolicy: { ...POLICY },
      policyHash: 'hash-1',
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

describe('resolver under same approval + policy (issue #46)', () => {
  it('carries the identical approval snapshot and policy hash (no bypass)', () => {
    const spec = buildResolverSpec({
      agentId: 'agent-2',
      role: 'debugger',
      constraints: ['stay inside the worktree'],
      oursDiff: 'ours',
      theirsDiff: 'theirs',
      approvalPolicy: { ...POLICY },
      policyHash: 'hash-1',
    });
    expect(spec.approvalPolicy).toEqual({ ...POLICY });
    expect(spec.policyHash).toBe('hash-1');
    expect(spec.role).toBe('debugger');
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
