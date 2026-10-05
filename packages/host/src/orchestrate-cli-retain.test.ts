// Retained-worktree status on the live orchestrate path (issue #106; §44.1).
// RED first: the run retained every worktree and branch as evidence and never
// reported whether a retained worktree was dirty — so an operator could not
// tell a clean retain from one that still holds uncommitted work. These tests
// drive the REAL `runOrchestrateCommand` with an injected status reader (the
// composition root's `git status` seam) and assert the reaped lines carry the
// measured state.
import { describe, expect, it } from 'vitest';
import type {
  OrchestrateCommandDeps,
  OrchestrateWorktree,
  OrchestratorRunState,
} from './orchestrate-cli.js';
import {
  RETAINED_FILES_PER_LINE,
  retainedRowLines,
  runOrchestrateCommand,
} from './orchestrate-cli.js';
import type { MergedHunk } from './orchestrator/merge/attribution.js';
import type { WorktreeStatus } from './orchestrator/worktree/status.js';
import { markMerged, settleWorktree } from './orchestrator/worktree/status.js';

function statusOf(
  path: string,
  dirty: { staged?: string[]; unstaged?: string[]; untracked?: string[] },
): WorktreeStatus {
  const staged = dirty.staged ?? [];
  const unstaged = dirty.unstaged ?? [];
  const untracked = dirty.untracked ?? [];
  return {
    path,
    branch: 'kubic/agent',
    clean:
      staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
    staged,
    unstaged,
    untracked,
    renames: [],
  };
}

interface FakeWorld {
  deps: OrchestrateCommandDeps;
  lines: string[];
  debugLines: string[];
  reapOrder: string[];
  saved: OrchestratorRunState[];
}

function makeWorld(overrides: Partial<OrchestrateCommandDeps> = {}): FakeWorld {
  const lines: string[] = [];
  const debugLines: string[] = [];
  const reapOrder: string[] = [];
  const saved: OrchestratorRunState[] = [];
  const hunks: MergedHunk[] = [{ path: 'a.txt', hunk: '@@ -0,0 +1 @@ +a' }];
  const deps: OrchestrateCommandDeps = {
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
    mergeBranch: () => undefined,
    reapWorker: (agentId: string) => {
      reapOrder.push(agentId);
    },
    requestApproval: () => true,
    saveState: (state: OrchestratorRunState) => {
      saved.push(structuredClone(state));
    },
    ...overrides,
  };
  return { deps, lines, debugLines, reapOrder, saved };
}

describe('orchestrate retained-worktree status (issue #106, §44.1)', () => {
  it('reports each retained worktree and names the files when it is dirty', async () => {
    const world = makeWorld({
      worktreeStatus: (path) =>
        path.endsWith('/beta')
          ? statusOf(path, {
              unstaged: ['src/left.ts'],
              untracked: ['tmp/x.log'],
            })
          : statusOf(path, {}),
    });
    const code = await runOrchestrateCommand(
      {
        prompt: 'do it',
        agents: ['alpha', 'beta'],
        session: 'sess-1',
        yes: true,
      },
      world.deps,
    );
    expect(code).toBe(0);
    expect(world.lines).toContain(
      'retained: alpha branch=kubic/alpha worktree=/repo/.kubic/wt/alpha clean=true',
    );
    // A dirty retained worktree names its files, staged/unstaged/untracked
    // kept apart so the operator can act on the right one.
    expect(world.lines).toContain(
      'retained: beta branch=kubic/beta worktree=/repo/.kubic/wt/beta clean=false unstaged=[src/left.ts] untracked=[tmp/x.log]',
    );
  });

  it('reports every retained worktree after the run, in reap order', async () => {
    const world = makeWorld({
      worktreeStatus: (path) => statusOf(path, {}),
    });
    const code = await runOrchestrateCommand(
      {
        prompt: 'do it',
        agents: ['alpha', 'beta'],
        session: 'sess-1',
        yes: true,
      },
      world.deps,
    );
    expect(code).toBe(0);
    const retained = world.lines.filter((line) =>
      line.startsWith('retained: '),
    );
    expect(retained.map((line) => line.split(' ')[1])).toEqual([
      'alpha',
      'beta',
    ]);
    expect(world.reapOrder).toEqual(['alpha', 'beta']);
    // §44.1: the retain path states the semantics — the branch stays, and
    // `kubic clean` is the only disposer.
    expect(world.lines).toContain(
      'retain: worktree + branch kept as evidence — only `kubic clean` disposes',
    );
  });

  it('reports a retained worktree whose status cannot be read, never a false clean', async () => {
    const world = makeWorld({
      worktreeStatus: (path) => {
        if (path.endsWith('/beta')) throw new Error('git status failed');
        return statusOf(path, {});
      },
    });
    const code = await runOrchestrateCommand(
      {
        prompt: 'do it',
        agents: ['alpha', 'beta'],
        session: 'sess-1',
        yes: true,
      },
      world.deps,
    );
    // An unreadable status is not a run failure — the run settled — but it is
    // reported as unknown, never silently as clean.
    expect(code).toBe(0);
    expect(world.lines).toContain(
      'retained: beta branch=kubic/beta worktree=/repo/.kubic/wt/beta clean=unknown status-unreadable=git status failed',
    );
  });

  it('omits the retained lines entirely when no status reader is wired', async () => {
    const world = makeWorld({ worktreeStatus: undefined });
    const code = await runOrchestrateCommand(
      {
        prompt: 'do it',
        agents: ['alpha', 'beta'],
        session: 'sess-1',
        yes: true,
      },
      world.deps,
    );
    expect(code).toBe(0);
    expect(world.lines.filter((l) => l.startsWith('retained: '))).toEqual([]);
  });

  it('sanitizes and bounds the file names on a retained line', () => {
    // Names come from `git status` inside a worktree the workers wrote: a
    // name carrying control bytes must render inert, not drive the operator's
    // terminal, and a worktree with thousands of untracked files must not
    // produce an unbounded line.
    const hostile = ['\u001b[31mred.txt', 'plain.txt'];
    const [line] = retainedRowLines([
      {
        agentId: 'alpha',
        branch: 'kubic/alpha',
        worktree: '/repo/.kubic/wt/alpha',
        clean: false,
        untracked: hostile,
      },
    ]);
    expect(line).not.toContain('\u001b');
    expect(line).toContain('plain.txt');

    const many = Array.from(
      { length: RETAINED_FILES_PER_LINE + 300 },
      (_, i) => `f${i}.txt`,
    );
    const [bounded] = retainedRowLines([
      {
        agentId: 'alpha',
        branch: 'kubic/alpha',
        worktree: '/repo/.kubic/wt/alpha',
        clean: false,
        untracked: many,
      },
    ]);
    expect(bounded).toContain('(+300 more)');
    expect(bounded.length).toBeLessThan(1000);
  });

  it('the retain presenters keep the §44.1 semantics on the live path', () => {
    // What the run reports is these two shapes: a settled worktree keeps its
    // branch, a merged one stays retained and is never removed in place.
    const entry = {
      path: '/repo/.kubic/wt/alpha',
      branch: 'kubic/alpha',
      bare: false,
      detached: false,
    };
    expect(settleWorktree(entry)).toMatchObject({
      settled: true,
      branchKept: true,
    });
    expect(markMerged(entry)).toMatchObject({
      merged: true,
      retained: true,
      removed: false,
    });
  });
});
