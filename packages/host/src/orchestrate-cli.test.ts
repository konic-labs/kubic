// `kubic orchestrate` (issue #76): plans, spawns workers in git worktrees,
// settles/merges FIFO with per-agent attribution, and reaps. RED first:
// every acceptance checkbox arrives here as a failing test.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeExecutionEnv } from '../../exec/src/env.js';
import type {
  OrchestrateCommandDeps,
  OrchestrateWorktree,
  OrchestratorRunState,
  WorkerSessionRequest,
  WorkerSpawnInfo,
} from './orchestrate-cli.js';
import {
  MergeConflictError,
  managerCallsForMerge,
  runOrchestrateCommand,
  workerSessionFor,
} from './orchestrate-cli.js';
import {
  MANAGER_ALLOWLIST,
  registerManagerLane,
} from './orchestrator/manager.js';
import type { MergedHunk } from './orchestrator/merge/attribution.js';
import { assertManagerZeroWrites } from './orchestrator/merge/settle.js';
import { addWorktree } from './orchestrator/worktree/add.js';
import { SESSION_ID_PATTERN } from './run-cli.js';

interface FakeCalls {
  ensure: string[];
  create: string[];
  run: string[];
  merge: string[];
  reap: string[];
  approvals: string[];
  order: string[];
}

interface FakeWorld {
  deps: OrchestrateCommandDeps;
  lines: string[];
  debugLines: string[];
  calls: FakeCalls;
  saved: OrchestratorRunState[];
  runInfo: { agentId: string; workerSessionId: string }[];
  /** The prompt each worker actually received (issue #103). */
  prompts: { agentId: string; prompt: string }[];
}

function makeWorld(
  overrides: Partial<OrchestrateCommandDeps> = {},
  hunksPerAgent?: Record<string, number>,
): FakeWorld {
  const lines: string[] = [];
  const debugLines: string[] = [];
  const calls: FakeCalls = {
    ensure: [],
    create: [],
    run: [],
    merge: [],
    reap: [],
    approvals: [],
    order: [],
  };
  const saved: OrchestratorRunState[] = [];
  const runInfo: { agentId: string; workerSessionId: string }[] = [];
  const prompts: { agentId: string; prompt: string }[] = [];
  const deps: OrchestrateCommandDeps = {
    out: (line: string) => {
      lines.push(line);
    },
    debug: (line: string) => {
      debugLines.push(line);
    },
    now: () => 1700000000000,
    isGitRepo: () => true,
    ensureWorktree: (agentId: string) => {
      calls.ensure.push(agentId);
      return { path: `/repo/.kubic/wt/${agentId}`, branch: `kubic/${agentId}` };
    },
    createWorkerSession: (input) => {
      calls.create.push(input.agentId);
      calls.order.push(`create:${input.agentId}`);
      return { sessionId: input.workerSessionId };
    },
    runWorker: (
      agentId: string,
      _worktree: OrchestrateWorktree,
      prompt: string,
      info?: WorkerSpawnInfo,
    ) => {
      calls.run.push(agentId);
      calls.order.push(`run:${agentId}`);
      runInfo.push({
        agentId,
        workerSessionId: info?.workerSessionId ?? '(none)',
      });
      prompts.push({ agentId, prompt });
      const count = hunksPerAgent?.[agentId] ?? 1;
      const hunks: MergedHunk[] = [];
      for (let i = 0; i < count; i += 1) {
        hunks.push({
          path: `${agentId}-${i}.txt`,
          hunk: `@@ -0,0 +1 @@ +${agentId}-${i}`,
        });
      }
      return hunks;
    },
    mergeBranch: (agentId: string) => {
      calls.merge.push(agentId);
    },
    reapWorker: (agentId: string) => {
      calls.reap.push(agentId);
    },
    requestApproval: (input: { agentId: string }) => {
      calls.approvals.push(input.agentId);
      return true;
    },
    loadState: () => undefined,
    saveState: (state: OrchestratorRunState) => {
      saved.push(structuredClone(state));
    },
    ...overrides,
  };
  return { deps, lines, debugLines, calls, saved, runInfo, prompts };
}

function lastJsonLine(lines: string[]): Record<string, unknown> {
  const raw = lines[lines.length - 1] as string;
  return JSON.parse(raw) as Record<string, unknown>;
}

describe('orchestrate usage (issue #76)', () => {
  it('prints usage and exits 2 with no prompt', async () => {
    const world = makeWorld();
    const code = await runOrchestrateCommand([], world.deps);
    expect(code).toBe(2);
    expect(world.lines[0]).toMatch(/^usage: kubic orchestrate/);
    expect(world.calls.ensure).toEqual([]);
  });

  it('exits 2 on unknown flags, missing values, and bad ids', async () => {
    const world = makeWorld();
    expect(
      await runOrchestrateCommand(['-p', 'x', '--bogus'], world.deps),
    ).toBe(2);
    expect(
      await runOrchestrateCommand(
        ['--session', 'no spaces!!', '-p', 'x'],
        world.deps,
      ),
    ).toBe(2);
    expect(
      await runOrchestrateCommand(
        ['-p', 'x', '--agents', 'good,bad/id'],
        world.deps,
      ),
    ).toBe(2);
    expect(
      await runOrchestrateCommand(['-p', 'x', '--agents', 'a,a'], world.deps),
    ).toBe(2);
    expect(
      await runOrchestrateCommand(['--resume', '-p', 'x'], world.deps),
    ).toBe(2);
  });
});

describe('orchestrate non-git refusal (issue #76)', () => {
  it('refuses outside a git repo with exit 2 and never runs solo', async () => {
    const world = makeWorld({ isGitRepo: () => false });
    const code = await runOrchestrateCommand(
      ['-p', 'do things', '--agents', 'alpha,beta'],
      world.deps,
    );
    expect(code).toBe(2);
    expect(world.lines.join('\n')).toMatch(/git repository/);
    expect(world.calls.ensure).toEqual([]);
    expect(world.calls.run).toEqual([]);
    expect(world.calls.merge).toEqual([]);
    expect(world.lines.some((line) => line.startsWith('worker:'))).toBe(false);
    expect(world.lines.some((line) => line.startsWith('result:'))).toBe(false);
  });
});

describe('orchestrate two-worker FIFO merge (issue #76)', () => {
  it('spawns, runs, merges in agent order with per-agent attribution', async () => {
    const world = makeWorld({}, { alpha: 2, beta: 1 });
    const code = await runOrchestrateCommand(
      ['-p', 'demo prompt', '--agents', 'alpha,beta', '--session', 'sess-1'],
      world.deps,
    );
    expect(code).toBe(0);
    expect(world.calls.ensure).toEqual(['alpha', 'beta']);
    expect(world.calls.run).toEqual(['alpha', 'beta']);
    expect(world.calls.merge).toEqual(['alpha', 'beta']);
    expect(world.calls.reap).toEqual(['alpha', 'beta']);
    const text = world.lines.join('\n');
    expect(text).toContain('merge order: alpha -> beta');
    expect(text).toContain('worker: alpha');
    expect(text).toContain('worker: beta');
    expect(text).toContain('attribution: alpha=2 hunk(s), beta=1 hunk(s)');
    const state = world.saved[world.saved.length - 1] as OrchestratorRunState;
    expect(state.merged).toEqual(['alpha', 'beta']);
    expect(state.pending).toEqual([]);
    expect(state.stopped).toBe(false);
  });

  it('emits a machine-readable --json envelope on success', async () => {
    const world = makeWorld({}, { alpha: 2, beta: 1 });
    const code = await runOrchestrateCommand(
      ['-p', 'demo', '--agents', 'alpha,beta', '--session', 'sess-1', '--json'],
      world.deps,
    );
    expect(code).toBe(0);
    const envelope = lastJsonLine(world.lines);
    expect(envelope).toMatchObject({
      ok: true,
      exitCode: 0,
      sessionId: 'sess-1',
      status: 'completed',
      mergeOrder: ['alpha', 'beta'],
    });
    const attribution = envelope.attribution as { agent: string }[];
    expect(attribution.map((hunk) => hunk.agent).sort()).toEqual([
      'alpha',
      'alpha',
      'beta',
    ]);
  });

  it('keeps the manager write-free on the merge path', () => {
    expect(() => assertManagerZeroWrites(managerCallsForMerge())).not.toThrow();
    expect(managerCallsForMerge()).toContain('workspace_merge');
  });
});

describe('orchestrate approvals (issue #76)', () => {
  it('denies closed with exit 4 when the user decider says no', async () => {
    const world = makeWorld({
      requestApproval: () => false,
    });
    const code = await runOrchestrateCommand(
      ['-p', 'demo', '--agents', 'alpha,beta', '--session', 'sess-1'],
      world.deps,
    );
    expect(code).toBe(4);
    expect(world.calls.merge).toEqual([]);
    expect(world.lines.join('\n')).toMatch(/code=approval_denied/);
  });

  it('denies closed with exit 4 when no decider and no --yes (never silent)', async () => {
    const world = makeWorld({ requestApproval: undefined });
    const code = await runOrchestrateCommand(
      ['-p', 'demo', '--agents', 'alpha,beta', '--session', 'sess-1'],
      world.deps,
    );
    expect(code).toBe(4);
    expect(world.calls.merge).toEqual([]);
  });

  it('--yes auto-approves without asking', async () => {
    const world = makeWorld({ requestApproval: undefined });
    const code = await runOrchestrateCommand(
      ['-p', 'demo', '--agents', 'alpha,beta', '--session', 'sess-1', '--yes'],
      world.deps,
    );
    expect(code).toBe(0);
    expect(world.calls.approvals).toEqual([]);
    expect(world.calls.merge).toEqual(['alpha', 'beta']);
  });
});

describe('orchestrate failure codes (issue #76)', () => {
  it('fails closed with a machine-readable error when a worker fails', async () => {
    const world = makeWorld({
      runWorker: (agentId: string) => {
        if (agentId === 'beta') throw new Error('boom');
        return [{ path: 'a.txt', hunk: '@@ a' }];
      },
    });
    const code = await runOrchestrateCommand(
      ['-p', 'demo', '--agents', 'alpha,beta', '--session', 'sess-1'],
      world.deps,
    );
    expect(code).toBe(1);
    expect(world.lines.join('\n')).toMatch(/code=worker_failed/);
    // The spawned worker is still reaped; nothing merges.
    expect(world.calls.merge).toEqual([]);
    expect(world.calls.reap).toContain('alpha');
  });

  it('stops the queue fail-closed on an unresolvable conflict', async () => {
    const world = makeWorld({
      mergeBranch: (agentId: string) => {
        if (agentId === 'beta') {
          throw new MergeConflictError('beta', {
            oursDiff: 'ours',
            theirsDiff: 'theirs',
          });
        }
      },
    });
    const code = await runOrchestrateCommand(
      ['-p', 'demo', '--agents', 'alpha,beta', '--session', 'sess-1'],
      world.deps,
    );
    expect(code).toBe(1);
    expect(world.lines.join('\n')).toMatch(/code=merge_conflict/);
    const state = world.saved[world.saved.length - 1] as OrchestratorRunState;
    expect(state.merged).toEqual(['alpha']);
    expect(state.pending).toEqual(['beta']);
    expect(state.stopped).toBe(true);
    expect(state.blocked?.agentId).toBe('beta');
  });

  it('fails closed with a machine-readable error when reap fails', async () => {
    const world = makeWorld({
      reapWorker: (agentId: string) => {
        if (agentId === 'beta') throw new Error('zombie');
      },
    });
    const code = await runOrchestrateCommand(
      ['-p', 'demo', '--agents', 'alpha,beta', '--session', 'sess-1'],
      world.deps,
    );
    expect(code).toBe(1);
    expect(world.lines.join('\n')).toMatch(/code=reap_failed/);
    expect(world.calls.merge).toEqual(['alpha', 'beta']);
  });
});

describe('orchestrate crash-resume (issue #76)', () => {
  it('resume with no stored state fails closed and machine-readable', async () => {
    const world = makeWorld();
    const code = await runOrchestrateCommand(
      ['--resume', '--session', 'ghost'],
      world.deps,
    );
    expect(code).toBe(1);
    expect(world.lines.join('\n')).toMatch(/code=no_orchestrator_state/);
    expect(world.calls.merge).toEqual([]);
  });

  it('kill mid-run resumes pending only: no double-merge, order intact', async () => {
    // First run: killed while merging beta (alpha already merged + saved).
    const first = makeWorld({
      mergeBranch: (agentId: string) => {
        if (agentId === 'beta') throw new Error('KILLED');
      },
    });
    const code1 = await runOrchestrateCommand(
      ['-p', 'demo', '--agents', 'alpha,beta', '--session', 'sess-1'],
      first.deps,
    );
    expect(code1).toBe(1);
    const killed = first.saved[first.saved.length - 1] as OrchestratorRunState;
    expect(killed.merged).toEqual(['alpha']);
    expect(killed.pending).toEqual(['beta']);

    // Resume: the stored state continues beta only; alpha never re-merges.
    const second = makeWorld({
      loadState: () => structuredClone(killed),
    });
    const code2 = await runOrchestrateCommand(
      ['--resume', '--session', 'sess-1'],
      second.deps,
    );
    expect(code2).toBe(0);
    expect(second.calls.ensure).toEqual(['beta']);
    expect(second.calls.run).toEqual(['beta']);
    expect(second.calls.merge).toEqual(['beta']);
    expect(second.lines.join('\n')).toContain('merge order: alpha -> beta');
    const done = second.saved[second.saved.length - 1] as OrchestratorRunState;
    expect(done.merged).toEqual(['alpha', 'beta']);
    expect(done.pending).toEqual([]);
  });

  it('resume on a stopped queue re-reports blocked and merges nothing', async () => {
    const stopped: OrchestratorRunState = {
      version: 1,
      sessionId: 'sess-1',
      prompt: 'demo',
      agents: ['alpha', 'beta'],
      merged: ['alpha'],
      pending: ['beta'],
      stopped: true,
      blocked: { agentId: 'beta', oursDiff: 'o', theirsDiff: 't' },
      records: [
        {
          agentId: 'alpha',
          branch: 'kubic/alpha',
          hunks: [{ path: 'a.txt', hunk: '@@ a' }],
        },
      ],
    };
    const world = makeWorld({ loadState: () => structuredClone(stopped) });
    const code = await runOrchestrateCommand(
      ['--resume', '--session', 'sess-1'],
      world.deps,
    );
    expect(code).toBe(1);
    expect(world.calls.merge).toEqual([]);
    expect(world.calls.run).toEqual([]);
    expect(world.lines.join('\n')).toMatch(/code=merge_conflict/);
  });
});

describe('orchestrate two-worker demo on a scratch git repo (issue #76)', () => {
  it('spawn → run → settle → merge to the session branch over real git', {
    timeout: 30000,
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'kubic-orch-'));
    const lines: string[] = [];
    const createdSessions: string[] = [];
    const provenance = {
      sessionId: 'demosess',
      agentId: 'manager',
      toolCallId: 'demo',
      turnId: 0,
      operation: 'orchestrate_demo',
    };
    const git = async (args: string[]): Promise<string> => {
      const env = new NodeExecutionEnv(root);
      const done = await env.shell.spawn('git', args, { provenance }).wait();
      if (done.exitCode !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${done.stderr}`);
      }
      return done.stdout;
    };
    await git(['init', '-b', 'main']);
    await git(['config', 'user.email', 'demo@kubic.dev']);
    await git(['config', 'user.name', 'kubic demo']);
    await git(['config', 'commit.gpgsign', 'false']);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(root, 'base.txt'), 'base\n');
    await git(['add', 'base.txt']);
    await git(['commit', '-m', 'base']);

    const env = new NodeExecutionEnv(root);
    const deps: OrchestrateCommandDeps = {
      out: (line: string) => {
        lines.push(line);
      },
      now: () => 1700000000000,
      isGitRepo: () => true,
      ensureWorktree: (agentId: string) =>
        addWorktree(env, root, agentId, { sessionId: 'demosess' }).then(
          (added) => ({ path: added.path, branch: added.branch }),
        ),
      createWorkerSession: (input) => {
        createdSessions.push(input.workerSessionId);
        return { sessionId: input.workerSessionId };
      },
      runWorker: async (
        agentId: string,
        worktree: { path: string; branch: string },
      ) => {
        const wenv = new NodeExecutionEnv(worktree.path);
        const run = async (args: string[]): Promise<void> => {
          const done = await wenv.shell
            .spawn('git', args, { provenance })
            .wait();
          if (done.exitCode !== 0) {
            throw new Error(`git ${args.join(' ')} failed: ${done.stderr}`);
          }
        };
        writeFileSync(
          join(worktree.path, `task-${agentId}.txt`),
          `from ${agentId}\n`,
        );
        await run(['add', `task-${agentId}.txt`]);
        await run(['commit', '-m', `worker ${agentId}`]);
        return [
          {
            path: `task-${agentId}.txt`,
            hunk: `@@ -0,0 +1 @@ +from ${agentId}`,
          },
        ];
      },
      mergeBranch: async (agentId: string) => {
        const done = await env.shell
          .spawn(
            'git',
            ['merge', '--no-ff', `kubic/${agentId}`, '-m', `merge ${agentId}`],
            { provenance },
          )
          .wait();
        if (done.exitCode !== 0) {
          await env.shell
            .spawn('git', ['merge', '--abort'], { provenance })
            .wait();
          throw new MergeConflictError(agentId, {
            oursDiff: done.stdout,
            theirsDiff: done.stderr,
          });
        }
      },
      reapWorker: () => undefined,
      requestApproval: () => true,
      loadState: () => undefined,
      saveState: () => undefined,
    };
    const code = await runOrchestrateCommand(
      ['-p', 'demo', '--agents', 'alpha,beta', '--session', 'demosess'],
      deps,
    );
    expect(code).toBe(0);
    const log = await git(['log', '--format=%s']);
    expect(log).toContain('merge alpha');
    expect(log).toContain('merge beta');
    // Merge queue ordering: alpha merged before beta.
    expect(log.indexOf('merge alpha')).toBeGreaterThan(
      log.indexOf('merge beta'),
    );
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(root, 'task-alpha.txt'), 'utf8')).toContain(
      'from alpha',
    );
    expect(readFileSync(join(root, 'task-beta.txt'), 'utf8')).toContain(
      'from beta',
    );
    expect(lines.join('\n')).toContain('merge order: alpha -> beta');
    // Every worker's session was created before its child spawned.
    expect(createdSessions).toEqual(['demosess-alpha', 'demosess-beta']);
  });
});

describe('orchestrate pre-merge guard (issue #76 fix a)', () => {
  it('runs the pre-merge guard before every merge, in FIFO order', async () => {
    const order: string[] = [];
    const world = makeWorld({
      prepareMerge: (agentId: string) => {
        order.push(`prepare:${agentId}`);
      },
      mergeBranch: (agentId: string) => {
        order.push(`merge:${agentId}`);
        world.calls.merge.push(agentId);
      },
    });
    const code = await runOrchestrateCommand(
      ['-p', 'demo', '--agents', 'alpha,beta', '--session', 'sess-1'],
      world.deps,
    );
    expect(code).toBe(0);
    expect(order).toEqual([
      'prepare:alpha',
      'merge:alpha',
      'prepare:beta',
      'merge:beta',
    ]);
  });

  it('fails closed without merging when the guard refuses a dirty tree', async () => {
    const world = makeWorld({
      prepareMerge: (agentId: string) => {
        if (agentId === 'beta') throw new Error('working tree not clean');
      },
      mergeBranch: (agentId: string) => {
        world.calls.merge.push(agentId);
      },
    });
    const code = await runOrchestrateCommand(
      ['-p', 'demo', '--agents', 'alpha,beta', '--session', 'sess-1'],
      world.deps,
    );
    expect(code).toBe(1);
    expect(world.lines.join('\n')).toMatch(/code=merge_failed/);
    expect(world.calls.merge).toEqual(['alpha']);
    const state = world.saved[world.saved.length - 1] as OrchestratorRunState;
    expect(state.merged).toEqual(['alpha']);
    expect(state.pending).toEqual(['beta']);
  });
});

describe('orchestrate write-ahead merge intent (issue #76 fix b)', () => {
  it('persists a merging intent before each merge and clears it after', async () => {
    type MergeEvent =
      | { type: 'save'; merging: string | null }
      | { type: 'merge'; agent: string };
    const events: MergeEvent[] = [];
    const world = makeWorld({
      mergeBranch: (agentId: string) => {
        events.push({ type: 'merge', agent: agentId });
        world.calls.merge.push(agentId);
      },
      saveState: (state: OrchestratorRunState) => {
        events.push({ type: 'save', merging: state.merging ?? null });
        world.saved.push(structuredClone(state));
      },
    });
    const code = await runOrchestrateCommand(
      ['-p', 'demo', '--agents', 'alpha,beta', '--session', 'sess-1'],
      world.deps,
    );
    expect(code).toBe(0);
    for (const agent of ['alpha', 'beta']) {
      const intentIdx = events.findIndex(
        (event) => event.type === 'save' && event.merging === agent,
      );
      const mergeIdx = events.findIndex(
        (event) => event.type === 'merge' && event.agent === agent,
      );
      expect(intentIdx).toBeGreaterThanOrEqual(0);
      expect(mergeIdx).toBeGreaterThanOrEqual(0);
      expect(intentIdx).toBeLessThan(mergeIdx);
    }
    const done = world.saved[world.saved.length - 1] as OrchestratorRunState;
    expect(done.merging ?? null).toBeNull();
  });

  it('resume with an intent for an already-merged branch skips the worker without re-merging', async () => {
    const killed: OrchestratorRunState = {
      version: 1,
      sessionId: 'sess-1',
      prompt: 'demo',
      agents: ['alpha', 'beta'],
      merged: ['alpha'],
      pending: ['beta'],
      stopped: false,
      merging: 'beta',
      records: [
        {
          agentId: 'alpha',
          branch: 'kubic/alpha',
          hunks: [{ path: 'a.txt', hunk: '@@ a' }],
        },
      ],
    };
    const world = makeWorld({
      loadState: () => structuredClone(killed),
      isBranchMerged: (agentId: string) => agentId === 'beta',
    });
    const code = await runOrchestrateCommand(
      ['--resume', '--session', 'sess-1'],
      world.deps,
    );
    expect(code).toBe(0);
    expect(world.calls.run).not.toContain('beta');
    expect(world.calls.merge).not.toContain('beta');
    expect(world.lines.join('\n')).toContain('merge order: alpha -> beta');
    const done = world.saved[world.saved.length - 1] as OrchestratorRunState;
    expect(done.merged).toEqual(['alpha', 'beta']);
    expect(done.pending).toEqual([]);
  });

  it('resume with an intent for an unmerged branch clears the intent and retries the worker', async () => {
    const killed: OrchestratorRunState = {
      version: 1,
      sessionId: 'sess-1',
      prompt: 'demo',
      agents: ['alpha', 'beta'],
      merged: ['alpha'],
      pending: ['beta'],
      stopped: false,
      merging: 'beta',
      records: [
        {
          agentId: 'alpha',
          branch: 'kubic/alpha',
          hunks: [{ path: 'a.txt', hunk: '@@ a' }],
        },
      ],
    };
    const world = makeWorld({
      loadState: () => structuredClone(killed),
      isBranchMerged: () => false,
    });
    const code = await runOrchestrateCommand(
      ['--resume', '--session', 'sess-1'],
      world.deps,
    );
    expect(code).toBe(0);
    expect(world.calls.run).toEqual(['beta']);
    expect(world.calls.merge).toEqual(['beta']);
    const done = world.saved[world.saved.length - 1] as OrchestratorRunState;
    expect(done.merged).toEqual(['alpha', 'beta']);
    expect(done.pending).toEqual([]);
  });
});

describe('orchestrate state save failures (issue #76 fix c)', () => {
  it('fails closed with state_save_failed when the state store throws', async () => {
    const world = makeWorld({
      saveState: () => {
        throw new Error('disk full');
      },
    });
    const code = await runOrchestrateCommand(
      ['-p', 'demo', '--agents', 'alpha,beta', '--session', 'sess-1'],
      world.deps,
    );
    expect(code).toBe(1);
    expect(world.lines.join('\n')).toMatch(/code=state_save_failed/);
    expect(world.calls.merge).toEqual([]);
  });
});

describe('orchestrate worker session creation (issue #85)', () => {
  it('creates each worker session before its child spawns, with the attach id', async () => {
    const world = makeWorld({}, { alpha: 1, beta: 1 });
    const code = await runOrchestrateCommand(
      ['-p', 'demo', '--agents', 'alpha,beta', '--session', 'sess-1'],
      world.deps,
    );
    expect(code).toBe(0);
    // Creation strictly precedes the spawn for each worker: `kubic run`
    // with an explicit --session only ATTACHES, so a child spawned before
    // its session exists dies at attach (exit 5 "unknown session").
    expect(world.calls.order).toEqual([
      'create:alpha',
      'run:alpha',
      'create:beta',
      'run:beta',
    ]);
    // The id the manager creates is exactly the id the child attaches to.
    expect(world.runInfo).toEqual([
      { agentId: 'alpha', workerSessionId: 'sess-1-alpha' },
      { agentId: 'beta', workerSessionId: 'sess-1-beta' },
    ]);
  });

  it('names the worker session after the orchestrator session and the agent', () => {
    expect(workerSessionFor('orch-1700000000000', 'worker-1')).toBe(
      'orch-1700000000000-worker-1',
    );
    // The derived id must satisfy the CLI's --session rule, else the child
    // refuses it as a usage error (exit 2) before any attach.
    expect(SESSION_ID_PATTERN.test(workerSessionFor('sess-1', 'w-1'))).toBe(
      true,
    );
  });

  it('fails closed as spawn_failed when the creation hook is omitted', async () => {
    const world = makeWorld({ createWorkerSession: undefined });
    const code = await runOrchestrateCommand(
      ['-p', 'demo', '--agents', 'alpha,beta', '--session', 'sess-1'],
      world.deps,
    );
    expect(code).toBe(1);
    expect(world.lines.join('\n')).toMatch(/code=spawn_failed/);
    // Never a child that cannot attach, and nothing merges.
    expect(world.calls.run).toEqual([]);
    expect(world.calls.merge).toEqual([]);
    expect(world.calls.reap).toContain('alpha');
  });

  it('fails closed as spawn_failed when session creation throws', async () => {
    const world = makeWorld({
      createWorkerSession: () => {
        throw new Error('sessions root not writable');
      },
    });
    const code = await runOrchestrateCommand(
      ['-p', 'demo', '--agents', 'alpha', '--session', 'sess-1'],
      world.deps,
    );
    expect(code).toBe(1);
    const text = world.lines.join('\n');
    expect(text).toMatch(/code=spawn_failed/);
    expect(text).toMatch(/sessions root not writable/);
    expect(world.calls.run).toEqual([]);
    expect(world.calls.merge).toEqual([]);
  });

  it('carries the worker worktree on the creation request', async () => {
    const seen: WorkerSessionRequest[] = [];
    const world = makeWorld({
      createWorkerSession: (input) => {
        seen.push(input);
        world.calls.create.push(input.agentId);
        return { sessionId: input.workerSessionId };
      },
    });
    const code = await runOrchestrateCommand(
      ['-p', 'demo', '--agents', 'alpha', '--session', 'sess-1'],
      world.deps,
    );
    expect(code).toBe(0);
    // The session cwd is the WORKER's worktree: worker journals and
    // session files land with the worker, not in the parent repo.
    expect(seen).toEqual([
      {
        sessionId: 'sess-1',
        agentId: 'alpha',
        workerSessionId: 'sess-1-alpha',
        worktree: { path: '/repo/.kubic/wt/alpha', branch: 'kubic/alpha' },
      },
    ]);
  });

  it('resume creates the session again for the retried worker only', async () => {
    const killed: OrchestratorRunState = {
      version: 1,
      sessionId: 'sess-1',
      prompt: 'demo',
      agents: ['alpha', 'beta'],
      merged: ['alpha'],
      pending: ['beta'],
      stopped: false,
      records: [
        {
          agentId: 'alpha',
          branch: 'kubic/alpha',
          hunks: [{ path: 'a.txt', hunk: '@@ a' }],
        },
      ],
    };
    const world = makeWorld({ loadState: () => structuredClone(killed) });
    const code = await runOrchestrateCommand(
      ['--resume', '--session', 'sess-1'],
      world.deps,
    );
    expect(code).toBe(0);
    expect(world.calls.order).toEqual(['create:beta', 'run:beta']);
    expect(world.calls.create).toEqual(['beta']);
  });
});

describe('orchestrate spawn failures (issue #85)', () => {
  it('maps a refused worktree to spawn_failed with the named code', async () => {
    const world = makeWorld({
      ensureWorktree: () => {
        throw new Error('worktree missing for worker-1');
      },
    });
    const code = await runOrchestrateCommand(
      ['-p', 'demo', '--agents', 'alpha', '--session', 'sess-1'],
      world.deps,
    );
    expect(code).toBe(1);
    expect(world.lines.join('\n')).toMatch(/code=spawn_failed/);
    expect(world.calls.run).toEqual([]);
    expect(world.calls.merge).toEqual([]);
  });
});

describe('orchestrate resume state validation (issue #76 fix)', () => {
  const validBase: OrchestratorRunState = {
    version: 1,
    sessionId: 'sess-1',
    prompt: 'demo',
    agents: ['alpha', 'beta'],
    merged: ['alpha'],
    pending: ['beta'],
    stopped: false,
    records: [
      {
        agentId: 'alpha',
        branch: 'kubic/alpha',
        hunks: [{ path: 'a.txt', hunk: '@@ a' }],
      },
    ],
  };

  const malformed: Record<string, unknown>[] = [
    {},
    { version: 1, sessionId: 'sess-1' },
    { ...validBase, version: 2 },
    { ...validBase, merged: 'alpha' },
    { ...validBase, pending: [42] },
    { ...validBase, agents: 'alpha,beta' },
    { ...validBase, stopped: 'no' },
    { ...validBase, records: [{ agentId: 'alpha' }] },
    { ...validBase, records: 'alpha' },
    { ...validBase, merging: 42 },
    {
      ...validBase,
      blocked: { agentId: 'beta', oursDiff: 'o' },
    },
  ];

  it.each(malformed)(
    'rejects malformed stored state as no_orchestrator_state',
    async (stored) => {
      const world = makeWorld({
        loadState: () =>
          structuredClone(stored) as unknown as OrchestratorRunState,
      });
      const code = await runOrchestrateCommand(
        ['--resume', '--session', 'sess-1'],
        world.deps,
      );
      expect(code).toBe(1);
      expect(world.lines.join('\n')).toMatch(/code=no_orchestrator_state/);
      expect(world.calls.merge).toEqual([]);
      expect(world.calls.run).toEqual([]);
    },
  );
});

// Issue #103: the manager lane is live. The run registers its toolset through
// the §40 allowlist before anything spawns, the manager authors a plan whose
// steps become the prompts the workers actually receive (never a copy of -p),
// the plan rides the run state so --resume replays the same prompts, and the
// merge-path trace proves the lane write-free over the real run.
describe('orchestrate manager lane: plan → distinct worker prompts (issue #103)', () => {
  const MANAGER_PROMPT = 'apply the change across each area';

  // State as it was saved BEFORE #103 existed: no plan field at all.
  const legacyState = (): OrchestratorRunState => ({
    version: 1,
    sessionId: 'sess-1',
    prompt: MANAGER_PROMPT,
    agents: ['alpha', 'beta'],
    merged: [],
    pending: ['alpha', 'beta'],
    stopped: false,
    records: [],
  });

  it('hands each worker a prompt that differs and cites its plan step', async () => {
    const world = makeWorld({}, { alpha: 1, beta: 1 });
    const code = await runOrchestrateCommand(
      [
        '-p',
        MANAGER_PROMPT,
        '--agents',
        'alpha,beta',
        '--session',
        'sess-1',
        '--yes',
      ],
      world.deps,
    );
    expect(code).toBe(0);
    expect(world.prompts.map((entry) => entry.agentId)).toEqual([
      'alpha',
      'beta',
    ]);
    const [alpha, beta] = world.prompts;
    // ≥2 worker prompts that differ…
    expect(alpha?.prompt).not.toBe(beta?.prompt);
    // …each citing its plan step…
    expect(alpha?.prompt).toContain('step 1 of 2');
    expect(beta?.prompt).toContain('step 2 of 2');
    // …and no worker prompt is -p verbatim.
    for (const entry of world.prompts) {
      expect(entry.prompt).not.toBe(MANAGER_PROMPT);
    }
  });

  it('stores the plan in the run state for replay', async () => {
    const world = makeWorld();
    const code = await runOrchestrateCommand(
      [
        '-p',
        MANAGER_PROMPT,
        '--agents',
        'alpha,beta',
        '--session',
        'sess-1',
        '--yes',
      ],
      world.deps,
    );
    expect(code).toBe(0);
    const first = world.saved[0] as OrchestratorRunState;
    expect(first.plan?.map((step) => step.agentId)).toEqual(['alpha', 'beta']);
    expect(first.plan?.[0]?.prompt).toContain('step 1 of 2');
    expect(first.plan?.[0]?.prompt).not.toBe(MANAGER_PROMPT);
  });

  it('--resume replays the stored per-worker prompts, not -p', async () => {
    // First run is killed while merging beta; the saved state carries the
    // manager's plan.
    const first = makeWorld({
      mergeBranch: (agentId: string) => {
        if (agentId === 'beta') throw new Error('KILLED');
      },
    });
    expect(
      await runOrchestrateCommand(
        [
          '-p',
          MANAGER_PROMPT,
          '--agents',
          'alpha,beta',
          '--session',
          'sess-1',
          '--yes',
        ],
        first.deps,
      ),
    ).toBe(1);
    const killed = first.saved[first.saved.length - 1] as OrchestratorRunState;
    expect(killed.pending).toEqual(['beta']);

    // Resume with NO -p at all: the prompts must come from stored state.
    const second = makeWorld({ loadState: () => structuredClone(killed) });
    const code = await runOrchestrateCommand(
      ['--resume', '--session', 'sess-1', '--yes'],
      second.deps,
    );
    expect(code).toBe(0);
    expect(second.prompts).toHaveLength(1);
    const replayed = second.prompts[0] as {
      agentId: string;
      prompt: string;
    };
    expect(replayed.agentId).toBe('beta');
    // The replayed prompt is the stored step-2 prompt, verbatim — and is
    // not the -p text.
    expect(replayed.prompt).toBe(killed.plan?.[1]?.prompt);
    expect(replayed.prompt).toContain('step 2 of 2');
    expect(replayed.prompt).not.toBe(MANAGER_PROMPT);
  });

  it('re-derives the plan for a resumed state written before the plan existed', async () => {
    // State saved before #103 carries no plan. Resume must still hand each
    // worker its own step prompt (derived from the stored objective and
    // agent list), never the shared -p text.
    const legacy: OrchestratorRunState = {
      version: 1,
      sessionId: 'sess-1',
      prompt: MANAGER_PROMPT,
      agents: ['alpha', 'beta'],
      merged: [],
      pending: ['alpha', 'beta'],
      stopped: false,
      records: [],
    };
    const world = makeWorld({ loadState: () => structuredClone(legacy) });
    const code = await runOrchestrateCommand(
      ['--resume', '--session', 'sess-1', '--yes'],
      world.deps,
    );
    expect(code).toBe(0);
    const prompts = world.prompts.map((entry) => entry.prompt);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toBe(prompts[1]);
    expect(prompts[0]).toContain('step 1 of 2');
    expect(prompts[1]).toContain('step 2 of 2');
    for (const prompt of prompts) expect(prompt).not.toBe(MANAGER_PROMPT);
    // The derived plan is persisted, so the next resume replays it.
    const done = world.saved[world.saved.length - 1] as OrchestratorRunState;
    expect(done.plan?.map((step) => step.agentId)).toEqual(['alpha', 'beta']);
  });

  it('rejects a malformed stored plan as no_orchestrator_state', async () => {
    // A plan step that is not exactly id/step/total/prompt would reach
    // runWorker as a non-string prompt — untrusted JSON fails closed.
    const malformedPlan: Record<string, unknown>[] = [
      { ...legacyState(), plan: 'alpha: do it' },
      { ...legacyState(), plan: [{ agentId: 'alpha', step: 1, total: 1 }] },
      {
        ...legacyState(),
        plan: [{ agentId: 'alpha', step: '1', total: 1, prompt: 'p' }],
      },
      { ...legacyState(), plan: [{ agentId: 'alpha', prompt: 'p' }] },
    ];
    for (const stored of malformedPlan) {
      const world = makeWorld({
        loadState: () =>
          structuredClone(stored) as unknown as OrchestratorRunState,
      });
      const code = await runOrchestrateCommand(
        ['--resume', '--session', 'sess-1', '--yes'],
        world.deps,
      );
      expect(code).toBe(1);
      expect(world.lines.join('\n')).toMatch(/code=no_orchestrator_state/);
      expect(world.calls.run).toEqual([]);
      expect(world.calls.merge).toEqual([]);
    }
  });

  it('registers the manager toolset through the §40 allowlist when the run starts', async () => {
    const registered: (readonly string[] | undefined)[] = [];
    const world = makeWorld({
      registerManagerLane: (tools) => {
        registered.push(tools);
        return registerManagerLane(tools);
      },
    });
    const code = await runOrchestrateCommand(
      [
        '-p',
        MANAGER_PROMPT,
        '--agents',
        'alpha',
        '--session',
        'sess-1',
        '--yes',
      ],
      world.deps,
    );
    expect(code).toBe(0);
    // Registered exactly once, with no override — the lane's canonical set.
    expect(registered).toHaveLength(1);
    expect(registered[0]).toBeUndefined();
    // And that canonical registration is exactly the §40 allowlist.
    expect([...registerManagerLane().tools].sort()).toEqual(
      [...MANAGER_ALLOWLIST].sort(),
    );
    // The worker then ran (registration is not the end of the run).
    expect(world.prompts).toHaveLength(1);
  });

  it('refuses to start when the manager lane carries an exec tool', async () => {
    const world = makeWorld({
      registerManagerLane: () =>
        registerManagerLane([...MANAGER_ALLOWLIST, 'bash']),
    });
    const code = await runOrchestrateCommand(
      [
        '-p',
        MANAGER_PROMPT,
        '--agents',
        'alpha',
        '--session',
        'sess-1',
        '--yes',
      ],
      world.deps,
    );
    expect(code).toBe(1);
    const text = world.lines.join('\n');
    expect(text).toMatch(/code=manager_toolset_refused/);
    // The named error names the offending tool.
    expect(text).toMatch(/bash/);
    // Fail-closed: no worktree, no worker, no merge.
    expect(world.calls.ensure).toEqual([]);
    expect(world.calls.run).toEqual([]);
    expect(world.calls.merge).toEqual([]);
  });

  it('asserts the manager-lane trace write-free on every merge of a run', async () => {
    // The gate stays the real one: the injected wrapper records the trace
    // the run actually asserts over and then delegates to
    // assertManagerZeroWrites, so a tainted trace would still throw here.
    const asserted: string[][] = [];
    const world = makeWorld({
      assertManagerZeroWrites: (trace) => {
        asserted.push([...trace]);
        assertManagerZeroWrites(trace);
      },
    });
    const code = await runOrchestrateCommand(
      [
        '-p',
        MANAGER_PROMPT,
        '--agents',
        'alpha,beta',
        '--session',
        'sess-1',
        '--yes',
      ],
      world.deps,
    );
    expect(code).toBe(0);
    // One assertion per merge, over a trace that carries both halves: the
    // merge path and the lane's own spawn/wait/collect calls.
    expect(asserted).toHaveLength(2);
    for (const trace of asserted) {
      expect(trace).toContain('workspace_merge');
      expect(trace).toContain('spawn_agent');
      expect(trace).toContain('wait_for_agent');
      expect(trace).toContain('collect_result');
    }
  });
});
