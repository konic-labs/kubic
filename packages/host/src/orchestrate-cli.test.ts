// `kubic orchestrate` (issue #76): plans, spawns workers in git worktrees,
// settles/merges FIFO with per-agent attribution, and reaps. RED first:
// every acceptance checkbox arrives here as a failing test.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCliTheme } from '../../core/src/cli/theme.js';
import { NodeExecutionEnv } from '../../exec/src/env.js';
import type { AgentResult } from '../../worker/src/result.js';
import { buildAgentResult } from '../../worker/src/result.js';
import type {
  OrchestrateCommandDeps,
  OrchestrateWorktree,
  OrchestratorRunState,
  WorkerCredentialRequest,
  WorkerSessionRequest,
  WorkerSpawnInfo,
} from './orchestrate-cli.js';
import {
  MergeConflictError,
  managerCallsForMerge,
  parseOrchestratorRunState,
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
  /** stderr: the logger's `error: …` diagnostics. */
  errLines: string[];
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
  const errLines: string[] = [];
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
    err: (line: string) => {
      errLines.push(line);
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
  return { deps, lines, errLines, debugLines, calls, saved, runInfo, prompts };
}

function lastJsonLine(lines: string[]): Record<string, unknown> {
  const raw = lines[lines.length - 1] as string;
  return JSON.parse(raw) as Record<string, unknown>;
}

describe('orchestrate usage (issue #76)', () => {
  // Argv syntax (unknown flags, missing values, malformed --agents /
  // --budget / --session) is refused by the commander program before this
  // handler runs: apps/kubic/src/commands/orchestrator.test.ts. What stays
  // here are the cross-option rules the run itself owns.
  it('exits 2 with no prompt, naming what is missing on stderr', async () => {
    const world = makeWorld();
    const code = await runOrchestrateCommand({}, world.deps);
    expect(code).toBe(2);
    expect(world.lines).toEqual([]);
    expect(world.errLines).toEqual([
      'error: missing -p, --prompt <text> (the objective), or --resume --session <id>',
    ]);
    expect(world.calls.ensure).toEqual([]);
  });

  it('exits 2 on --resume without --session', async () => {
    const world = makeWorld();
    expect(
      await runOrchestrateCommand({ resume: true, prompt: 'x' }, world.deps),
    ).toBe(2);
    expect(world.errLines).toEqual([
      'error: --resume needs --session <id> (the run to re-attach to)',
    ]);
    expect(world.calls.ensure).toEqual([]);
  });

  it('refuses unsafe or duplicate agent ids from a library caller (they name worktrees)', async () => {
    for (const agents of [['good', 'bad/id'], ['a', 'a'], [], ['a,b']]) {
      const world = makeWorld();
      expect(
        await runOrchestrateCommand({ prompt: 'x', agents }, world.deps),
        JSON.stringify(agents),
      ).toBe(2);
      expect(world.errLines).toEqual([
        expect.stringMatching(/^error: invalid --agents/),
      ]);
      expect(world.calls.ensure).toEqual([]);
    }
  });

  it('refuses an unsafe session id from a library caller (it names a state file)', async () => {
    const world = makeWorld();
    expect(
      await runOrchestrateCommand(
        { session: '../escape', prompt: 'x' },
        world.deps,
      ),
    ).toBe(2);
    expect(world.errLines).toEqual([
      'error: invalid --session id "../escape" (use [A-Za-z0-9_-])',
    ]);
    expect(world.calls.ensure).toEqual([]);
  });
});

describe('per-agent role and model binding (issue #178)', () => {
  // The role-plan hook echoes the binding it was given, so the test reads
  // what the run resolved (the loader itself is covered by
  // roles/worker-roles.test.ts and the prod orchestrate tests).
  function echoRoles(
    seen: Array<{
      agents: readonly string[];
      binding?: {
        roles: Record<string, string>;
        models: Record<string, string>;
      };
    }>,
  ): NonNullable<OrchestrateCommandDeps['loadWorkerRoles']> {
    return (agents, binding) => {
      seen.push({ agents, ...(binding === undefined ? {} : { binding }) });
      return {
        assignments: agents.map((agentId) => ({
          agentId,
          role: binding?.roles[agentId] ?? 'implementer',
          promptText: `role:${binding?.roles[agentId] ?? 'implementer'}`,
          tools: [],
          modelRef: binding?.models[agentId],
          thinking: undefined,
        })),
        refused: [],
      };
    };
  }

  it('binds each worker to the role its --agents entry names (issue #178)', async () => {
    const world = makeWorld();
    const seen: Parameters<typeof echoRoles>[0] = [];
    const roles: Array<{ agentId: string; role?: string }> = [];
    const code = await runOrchestrateCommand(
      {
        prompt: 'demo',
        agents: ['a:implementer', 'b:reviewer'],
        session: 'binding',
        yes: true,
      },
      {
        ...world.deps,
        loadWorkerRoles: echoRoles(seen),
        runWorker: async (agentId, worktree, prompt, info) => {
          roles.push({ agentId, role: info?.role });
          return world.deps.runWorker(agentId, worktree, prompt, info);
        },
      },
    );
    expect(code).toBe(0);
    // The ids are the entry heads; the binding is the parsed roles.
    expect(seen[0]?.agents).toEqual(['a', 'b']);
    expect(seen[0]?.binding).toEqual({
      roles: { a: 'implementer', b: 'reviewer' },
      models: {},
    });
    expect(roles).toEqual([
      { agentId: 'a', role: 'implementer' },
      { agentId: 'b', role: 'reviewer' },
    ]);
  });

  it('carries an explicit per-agent model pin through the same entry (issue #178)', async () => {
    const world = makeWorld();
    const seen: Parameters<typeof echoRoles>[0] = [];
    const models: Array<string | undefined> = [];
    const code = await runOrchestrateCommand(
      {
        prompt: 'demo',
        agents: ['a:tester:acme/m2'],
        session: 'binding-model',
        yes: true,
      },
      {
        ...world.deps,
        loadWorkerRoles: echoRoles(seen),
        runWorker: async (agentId, worktree, prompt, info) => {
          models.push(info?.modelRef);
          return world.deps.runWorker(agentId, worktree, prompt, info);
        },
      },
    );
    expect(code).toBe(0);
    expect(seen[0]?.binding).toEqual({
      roles: { a: 'tester' },
      models: { a: 'acme/m2' },
    });
    expect(models).toEqual(['acme/m2']);
  });

  it('refuses an unknown role as a usage error before anything spawns (issue #178)', async () => {
    const world = makeWorld();
    const code = await runOrchestrateCommand(
      { prompt: 'demo', agents: ['a:teleporter'], session: 'badrole' },
      world.deps,
    );
    expect(code).toBe(2);
    expect(world.errLines.join('\n')).toMatch(/Unknown role "teleporter"/);
    expect(world.calls.ensure).toEqual([]);
    expect(world.calls.run).toEqual([]);
    expect(world.saved).toEqual([]);
  });

  it('persists the explicit assignment and replays it on --resume (issue #178)', async () => {
    const first = makeWorld({
      mergeBranch: (agentId: string) => {
        if (agentId === 'b') throw new Error('KILLED');
      },
    });
    const code1 = await runOrchestrateCommand(
      {
        prompt: 'demo',
        agents: ['a:planner', 'b:reviewer'],
        session: 'sess-bind',
        yes: true,
      },
      first.deps,
    );
    expect(code1).toBe(1);
    const stored = first.saved[first.saved.length - 1] as OrchestratorRunState;
    expect(stored.roles).toEqual({ a: 'planner', b: 'reviewer' });

    // The resume carries no --agents: the stored assignment is the one the
    // role plan gets, so every retried worker keeps the role it had.
    const seen: Parameters<typeof echoRoles>[0] = [];
    const second = makeWorld({
      loadState: () => structuredClone(stored),
      loadWorkerRoles: echoRoles(seen),
    });
    const code2 = await runOrchestrateCommand(
      { resume: true, session: 'sess-bind' },
      second.deps,
    );
    expect(code2).toBe(0);
    expect(seen[0]?.agents).toEqual(['a', 'b']);
    expect(seen[0]?.binding).toEqual({
      roles: { a: 'planner', b: 'reviewer' },
      models: {},
    });
    expect(second.calls.run).toEqual(['b']);
  });

  it('adopts an --agents assignment for a state written before the binding persisted (issue #178)', async () => {
    // The pre-#178 state has nothing to differ from (the --budget rule,
    // issue #208): the flag is adopted and persisted, never refused.
    const legacy: OrchestratorRunState = {
      version: 1,
      sessionId: 'sess-legacy',
      prompt: 'demo',
      agents: ['a', 'b'],
      merged: [],
      pending: ['a', 'b'],
      stopped: false,
      records: [],
    };
    const seen: Parameters<typeof echoRoles>[0] = [];
    const world = makeWorld({
      loadState: () => structuredClone(legacy),
      loadWorkerRoles: echoRoles(seen),
    });
    const code = await runOrchestrateCommand(
      {
        resume: true,
        session: 'sess-legacy',
        agents: ['a:planner', 'b:reviewer'],
      },
      world.deps,
    );
    expect(code).toBe(0);
    expect(seen[0]?.binding).toEqual({
      roles: { a: 'planner', b: 'reviewer' },
      models: {},
    });
    const saved = world.saved[world.saved.length - 1] as OrchestratorRunState;
    expect(saved.roles).toEqual({ a: 'planner', b: 'reviewer' });
  });

  it('accepts a bare --agents on resume: the ids are ignored and carry no assignment (issue #178)', async () => {
    const stored: OrchestratorRunState = {
      version: 1,
      sessionId: 'sess-bind',
      prompt: 'demo',
      agents: ['a', 'b'],
      roles: { a: 'planner' },
      merged: [],
      pending: ['a', 'b'],
      stopped: false,
      records: [],
    };
    const world = makeWorld({ loadState: () => structuredClone(stored) });
    const code = await runOrchestrateCommand(
      { resume: true, session: 'sess-bind', agents: ['a', 'b'] },
      world.deps,
    );
    expect(code).toBe(0);
    expect(world.errLines.join('\n')).not.toMatch(
      /differs from the assignment/,
    );
  });

  it('refuses a --resume whose --agents binding differs from the stored one (issue #178)', async () => {
    const stored: OrchestratorRunState = {
      version: 1,
      sessionId: 'sess-bind',
      prompt: 'demo',
      agents: ['a', 'b'],
      roles: { a: 'planner', b: 'reviewer' },
      merged: [],
      pending: ['a', 'b'],
      stopped: false,
      records: [],
    };
    const world = makeWorld({ loadState: () => structuredClone(stored) });
    const code = await runOrchestrateCommand(
      {
        resume: true,
        session: 'sess-bind',
        agents: ['a:tester', 'b:reviewer'],
      },
      world.deps,
    );
    expect(code).toBe(2);
    expect(world.errLines.join('\n')).toMatch(
      /differs from the assignment stored/,
    );
    expect(world.calls.run).toEqual([]);
  });
});

describe('orchestrate non-git refusal (issue #76, recoded by #372)', () => {
  it('refuses outside a git repo with exit 5 and never runs solo', async () => {
    const world = makeWorld({ isGitRepo: () => false });
    const code = await runOrchestrateCommand(
      { prompt: 'do things', agents: ['alpha', 'beta'] },
      world.deps,
    );
    expect(code).toBe(5);
    expect(world.lines).toEqual([]);
    expect(world.errLines).toEqual([
      expect.stringMatching(/^error: orchestrator mode needs a git repository/),
    ]);
    expect(world.calls.ensure).toEqual([]);
    expect(world.calls.run).toEqual([]);
    expect(world.calls.merge).toEqual([]);
    expect(world.lines.some((line) => line.startsWith('worker:'))).toBe(false);
    expect(world.lines.some((line) => line.startsWith('result:'))).toBe(false);
  });

  it('under --json prints the not_a_repo envelope on stdout, the prose on stderr', async () => {
    const world = makeWorld({ isGitRepo: () => false });
    const code = await runOrchestrateCommand(
      { prompt: 'do things', json: true },
      world.deps,
    );
    expect(code).toBe(5);
    expect(world.lines).toHaveLength(1);
    expect(JSON.parse(world.lines[0] as string)).toMatchObject({
      ok: false,
      exitCode: 5,
      status: 'workspace_unavailable',
      error: {
        kind: 'workspace_unavailable',
        code: 'not_a_repo',
        message: 'not a git repository',
      },
    });
    expect(world.errLines).toEqual([
      'error: not a git repository code=not_a_repo',
    ]);
  });
});

describe('orchestrate report colours (shared CLI theme)', () => {
  it('colours the report labels through the theme, never under --json', async () => {
    const theme = createCliTheme('16');
    const text = makeWorld({ theme });
    expect(
      await runOrchestrateCommand(
        { prompt: 'demo', agents: ['alpha'], session: 'sess-1', yes: true },
        text.deps,
      ),
    ).toBe(0);
    expect(text.lines).toContain(`${theme.accent('session:')} sess-1`);
    expect(text.lines).toContain(`${theme.success('merged:')} alpha`);
    expect(
      text.lines.some((line) => line.startsWith(theme.success('result:'))),
    ).toBe(true);

    const json = makeWorld({ theme });
    await runOrchestrateCommand(
      {
        prompt: 'demo',
        agents: ['alpha'],
        session: 'sess-1',
        yes: true,
        json: true,
      },
      json.deps,
    );
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no ANSI escapes
    expect(json.lines.join('\n')).not.toMatch(/\u001b\[/);
  });
});

describe('orchestrate two-worker FIFO merge (issue #76)', () => {
  it('spawns, runs, merges in agent order with per-agent attribution', async () => {
    const world = makeWorld({}, { alpha: 2, beta: 1 });
    const code = await runOrchestrateCommand(
      { prompt: 'demo prompt', agents: ['alpha', 'beta'], session: 'sess-1' },
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
      {
        prompt: 'demo',
        agents: ['alpha', 'beta'],
        session: 'sess-1',
        json: true,
      },
      world.deps,
    );
    expect(code).toBe(0);
    // Exactly one two-space-indented document on stdout; stderr silent.
    expect(world.lines).toHaveLength(1);
    expect(world.lines[0]).toMatch(/^\{\n {2}"ok": true,/);
    expect(world.errLines).toEqual([]);
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
      { prompt: 'demo', agents: ['alpha', 'beta'], session: 'sess-1' },
      world.deps,
    );
    expect(code).toBe(4);
    expect(world.calls.merge).toEqual([]);
    expect(world.errLines.join('\n')).toMatch(/code=approval_denied/);
  });

  it('denies closed with exit 4 when no decider and no --yes (never silent)', async () => {
    const world = makeWorld({ requestApproval: undefined });
    const code = await runOrchestrateCommand(
      { prompt: 'demo', agents: ['alpha', 'beta'], session: 'sess-1' },
      world.deps,
    );
    expect(code).toBe(4);
    expect(world.calls.merge).toEqual([]);
    // Never silent: the denial is reported by its named code.
    expect(world.errLines.join('\n')).toMatch(/code=approval_denied/);
  });

  it('--yes auto-approves without asking', async () => {
    const world = makeWorld({ requestApproval: undefined });
    const code = await runOrchestrateCommand(
      {
        prompt: 'demo',
        agents: ['alpha', 'beta'],
        session: 'sess-1',
        yes: true,
      },
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
      { prompt: 'demo', agents: ['alpha', 'beta'], session: 'sess-1' },
      world.deps,
    );
    expect(code).toBe(1);
    expect(world.errLines.join('\n')).toMatch(/code=worker_failed/);
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
      { prompt: 'demo', agents: ['alpha', 'beta'], session: 'sess-1' },
      world.deps,
    );
    expect(code).toBe(1);
    expect(world.errLines.join('\n')).toMatch(/code=merge_conflict/);
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
      { prompt: 'demo', agents: ['alpha', 'beta'], session: 'sess-1' },
      world.deps,
    );
    expect(code).toBe(1);
    expect(world.errLines.join('\n')).toMatch(/code=reap_failed/);
    expect(world.calls.merge).toEqual(['alpha', 'beta']);
  });
});

describe('orchestrate crash-resume (issue #76)', () => {
  it('resume with no stored state fails closed and machine-readable', async () => {
    const world = makeWorld();
    const code = await runOrchestrateCommand(
      { resume: true, session: 'ghost' },
      world.deps,
    );
    expect(code).toBe(1);
    expect(world.errLines.join('\n')).toMatch(/code=no_orchestrator_state/);
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
      { prompt: 'demo', agents: ['alpha', 'beta'], session: 'sess-1' },
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
      { resume: true, session: 'sess-1' },
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
      { resume: true, session: 'sess-1' },
      world.deps,
    );
    expect(code).toBe(1);
    expect(world.calls.merge).toEqual([]);
    expect(world.calls.run).toEqual([]);
    expect(world.errLines.join('\n')).toMatch(/code=merge_conflict/);
  });

  it('reports the resumed session agents in the envelope graph, not the CLI defaults', async () => {
    // Review finding F5: `fail` built the DAG from `parsed.agents`, which on a
    // resume run (no -p/--agents) is the command-line default list — so the
    // envelope named workers that are not in the run while `workers` described
    // the stored session. The graph must agree with `workers`.
    const stopped: OrchestratorRunState = {
      version: 1,
      sessionId: 'sess-g',
      prompt: 'demo',
      agents: ['a1', 'a2', 'a3'],
      merged: ['a1'],
      pending: ['a2', 'a3'],
      stopped: true,
      blocked: { agentId: 'a2', oursDiff: 'o', theirsDiff: 't' },
      records: [
        {
          agentId: 'a1',
          branch: 'kubic/a1',
          hunks: [{ path: 'a.txt', hunk: '@@ a' }],
        },
      ],
    };
    const world = makeWorld({ loadState: () => structuredClone(stopped) });
    const code = await runOrchestrateCommand(
      { resume: true, session: 'sess-g', json: true },
      world.deps,
    );
    expect(code).toBe(1);
    const envelope = lastJsonLine(world.lines);
    const workers = envelope.workers as { agentId: string }[];
    const graph = envelope.graph as string[];
    const nodes = graph.filter((line) => line.startsWith('node '));
    // The stored agents, and nothing else — no worker-1/worker-2 defaults.
    expect(nodes).toEqual([
      'node sess-g',
      'node sess-g-a1',
      'node sess-g-a2',
      'node sess-g-a3',
    ]);
    for (const worker of workers) {
      expect(graph).toContain(`node sess-g-${worker.agentId}`);
    }
  });

  it('drains a real admission queue: every worker runs once, in agent order', async () => {
    // Review finding F2 (issue #106) recorded a false queue: the loop was
    // strictly sequential and released each slot before the next request, so
    // a `queued:` line could only come from bookkeeping that was never
    // released. #206 makes the queue real — six agents against the default
    // cap of four queue exactly two, and both are drained on release.
    const world = makeWorld();
    const code = await runOrchestrateCommand(
      { prompt: 'do it', agents: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'] },
      world.deps,
    );
    expect(code).toBe(0);
    expect(world.calls.merge).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
    // Exactly the two past the cap were queued, and each names a slot.
    expect(world.debugLines.filter((l) => l.includes('queued'))).toHaveLength(
      2,
    );
    // Every worker ran exactly once, merges in agent order.
    expect(world.calls.run).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
    expect(world.calls.order.filter((l) => l.startsWith('run:'))).toEqual([
      'run:a1',
      'run:a2',
      'run:a3',
      'run:a4',
      'run:a5',
      'run:a6',
    ]);
  });
});

describe('orchestrate two-worker demo on a scratch git repo (issue #76)', () => {
  it('spawn → run → settle → merge to the session branch over real git', {
    timeout: 30000,
  }, async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'kubic-orch-'));
    // The scratch repo (and the worktrees under it) never outlive the test.
    context.onTestFinished(() =>
      rmSync(root, { recursive: true, force: true }),
    );
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
    writeFileSync(join(root, 'base.txt'), 'base\n');
    await git(['add', 'base.txt']);
    await git(['commit', '-m', 'base']);

    const env = new NodeExecutionEnv(root);
    const deps: OrchestrateCommandDeps = {
      out: (line: string) => {
        lines.push(line);
      },
      err: (line: string) => {
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
      { prompt: 'demo', agents: ['alpha', 'beta'], session: 'demosess' },
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
      { prompt: 'demo', agents: ['alpha', 'beta'], session: 'sess-1' },
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
      { prompt: 'demo', agents: ['alpha', 'beta'], session: 'sess-1' },
      world.deps,
    );
    expect(code).toBe(1);
    expect(world.errLines.join('\n')).toMatch(/code=merge_failed/);
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
      { prompt: 'demo', agents: ['alpha', 'beta'], session: 'sess-1' },
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
      { resume: true, session: 'sess-1' },
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
      { resume: true, session: 'sess-1' },
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

describe('merge denial messages name --yes only where it exists (issue #327)', () => {
  const denyingWorld = (
    verdict: 'deny' | { verdict: 'timeout'; maxPendingMs: number },
    overrides: Partial<OrchestrateCommandDeps> = {},
  ) =>
    makeWorld({
      requestApproval: () =>
        verdict === 'deny' ? { verdict: 'deny' } : verdict,
      ...overrides,
    });

  it('a CLI run keeps the --yes hint on a denial and on a timeout', async () => {
    const denied = denyingWorld('deny');
    expect(
      await runOrchestrateCommand(
        { prompt: 'demo', agents: ['alpha'], session: 'sess-1' },
        denied.deps,
      ),
    ).toBe(4);
    expect(denied.errLines.join('\n')).toContain(
      "approval denied for worker 'alpha': the decider is the user — rerun with --yes to auto-approve merges",
    );
    const timedOut = denyingWorld({ verdict: 'timeout', maxPendingMs: 25 });
    await runOrchestrateCommand(
      { prompt: 'demo', agents: ['alpha'], session: 'sess-1' },
      timedOut.deps,
    );
    expect(timedOut.errLines.join('\n')).toContain(
      "approval timed out after 25ms for worker 'alpha': nobody answered the merge gate — rerun with --yes to auto-approve merges",
    );
  });

  it('a surface with no --yes flag (the TUI) gets a message that does not mention it', async () => {
    const denied = denyingWorld('deny', { yesHint: false });
    expect(
      await runOrchestrateCommand(
        { prompt: 'demo', agents: ['alpha'], session: 'sess-1' },
        denied.deps,
      ),
    ).toBe(4);
    const text = denied.errLines.join('\n');
    expect(text).toContain(
      "approval denied for worker 'alpha': the decider is the user",
    );
    expect(text).not.toContain('--yes');
    const timedOut = denyingWorld(
      { verdict: 'timeout', maxPendingMs: 25 },
      { yesHint: false },
    );
    await runOrchestrateCommand(
      { prompt: 'demo', agents: ['alpha'], session: 'sess-1' },
      timedOut.deps,
    );
    const timeoutText = timedOut.errLines.join('\n');
    expect(timeoutText).toContain(
      "approval timed out after 25ms for worker 'alpha': nobody answered the merge gate",
    );
    expect(timeoutText).not.toContain('--yes');
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
      { prompt: 'demo', agents: ['alpha', 'beta'], session: 'sess-1' },
      world.deps,
    );
    expect(code).toBe(1);
    expect(world.errLines.join('\n')).toMatch(/code=state_save_failed/);
    expect(world.calls.merge).toEqual([]);
  });
});

describe('orchestrate worker session creation (issue #85)', () => {
  it('creates each worker session before its child spawns, with the attach id', async () => {
    const world = makeWorld({}, { alpha: 1, beta: 1 });
    const code = await runOrchestrateCommand(
      { prompt: 'demo', agents: ['alpha', 'beta'], session: 'sess-1' },
      world.deps,
    );
    expect(code).toBe(0);
    // Creation strictly precedes the SPAWN for each worker: `kubic run`
    // with an explicit --session only ATTACHES, so a child spawned before
    // its session exists dies at attach (exit 5 "unknown session"). Workers
    // run concurrently since #206, so the two workers' legs interleave — the
    // per-worker order is the invariant, not one global sequence.
    for (const agentId of ['alpha', 'beta']) {
      expect(
        world.calls.order.indexOf(`create:${agentId}`),
        `create:${agentId} before run:${agentId}`,
      ).toBeGreaterThanOrEqual(0);
      expect(world.calls.order.indexOf(`create:${agentId}`)).toBeLessThan(
        world.calls.order.indexOf(`run:${agentId}`),
      );
    }
    // The id the manager creates is exactly the id the child attaches to.
    expect(
      [...world.runInfo].sort((a, b) => a.agentId.localeCompare(b.agentId)),
    ).toEqual([
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
      { prompt: 'demo', agents: ['alpha', 'beta'], session: 'sess-1' },
      world.deps,
    );
    expect(code).toBe(1);
    expect(world.errLines.join('\n')).toMatch(/code=spawn_failed/);
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
      { prompt: 'demo', agents: ['alpha'], session: 'sess-1' },
      world.deps,
    );
    expect(code).toBe(1);
    const text = world.errLines.join('\n');
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
      { prompt: 'demo', agents: ['alpha'], session: 'sess-1' },
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
      { resume: true, session: 'sess-1' },
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
      { prompt: 'demo', agents: ['alpha'], session: 'sess-1' },
      world.deps,
    );
    expect(code).toBe(1);
    expect(world.errLines.join('\n')).toMatch(/code=spawn_failed/);
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
        { resume: true, session: 'sess-1' },
        world.deps,
      );
      expect(code).toBe(1);
      expect(world.errLines.join('\n')).toMatch(/code=no_orchestrator_state/);
      expect(world.calls.merge).toEqual([]);
      expect(world.calls.run).toEqual([]);
    },
  );

  it('refuses every malformed stored role/model binding shape (issue #178)', () => {
    // The same table discipline as the stored budget (issue #220): a
    // half-read assignment must refuse the resume, never apply partly.
    const bindings: unknown[] = [
      { roles: null },
      { roles: [] },
      { roles: 'planner' },
      { roles: { alpha: 42 } },
      // A key that names no worker of the stored run.
      { roles: { ghost: 'planner' } },
      // A role outside the five.
      { roles: { alpha: 'teleporter' } },
      { models: null },
      { models: { alpha: 'not-a-ref' } },
      { models: { alpha: '/m1' } },
      { models: { ghost: 'acme/m1' } },
      { models: { alpha: 7 } },
    ];
    for (const binding of bindings) {
      expect(
        parseOrchestratorRunState(
          { ...validBase, ...(binding as Record<string, unknown>) },
          'sess-1',
        ),
        JSON.stringify(binding),
      ).toBeUndefined();
    }
    // A valid assignment round-trips.
    const ok = parseOrchestratorRunState(
      {
        ...validBase,
        roles: { alpha: 'planner' },
        models: { alpha: 'acme/m1' },
      },
      'sess-1',
    );
    expect(ok?.roles).toEqual({ alpha: 'planner' });
    expect(ok?.models).toEqual({ alpha: 'acme/m1' });
  });
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
      {
        prompt: MANAGER_PROMPT,
        agents: ['alpha', 'beta'],
        session: 'sess-1',
        yes: true,
      },
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
      {
        prompt: MANAGER_PROMPT,
        agents: ['alpha', 'beta'],
        session: 'sess-1',
        yes: true,
      },
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
        {
          prompt: MANAGER_PROMPT,
          agents: ['alpha', 'beta'],
          session: 'sess-1',
          yes: true,
        },
        first.deps,
      ),
    ).toBe(1);
    const killed = first.saved[first.saved.length - 1] as OrchestratorRunState;
    expect(killed.pending).toEqual(['beta']);

    // Resume with NO -p at all: the prompts must come from stored state.
    const second = makeWorld({ loadState: () => structuredClone(killed) });
    const code = await runOrchestrateCommand(
      { resume: true, session: 'sess-1', yes: true },
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
      { resume: true, session: 'sess-1', yes: true },
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
        { resume: true, session: 'sess-1', yes: true },
        world.deps,
      );
      expect(code).toBe(1);
      expect(world.errLines.join('\n')).toMatch(/code=no_orchestrator_state/);
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
      {
        prompt: MANAGER_PROMPT,
        agents: ['alpha'],
        session: 'sess-1',
        yes: true,
      },
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
      {
        prompt: MANAGER_PROMPT,
        agents: ['alpha'],
        session: 'sess-1',
        yes: true,
      },
      world.deps,
    );
    expect(code).toBe(1);
    // A diagnostic on stderr; stdout carries no report for a refused start.
    expect(world.lines).toEqual([]);
    const text = world.errLines.join('\n');
    expect(text).toMatch(/^error: .*code=manager_toolset_refused$/);
    // The named error names the offending tool.
    expect(text).toMatch(/bash/);
    // Fail-closed: no worktree, no worker, no merge.
    expect(world.calls.ensure).toEqual([]);
    expect(world.calls.run).toEqual([]);
    expect(world.calls.merge).toEqual([]);
  });

  it('reports a refused lane as one machine-readable envelope under --json', async () => {
    const world = makeWorld({
      registerManagerLane: () =>
        registerManagerLane([...MANAGER_ALLOWLIST, 'bash']),
    });
    const code = await runOrchestrateCommand(
      {
        prompt: MANAGER_PROMPT,
        agents: ['alpha'],
        session: 'sess-1',
        yes: true,
        json: true,
      },
      world.deps,
    );
    expect(code).toBe(1);
    // --json is one parseable envelope on every failure path, including this
    // one: a machine consumer must not have to parse prose. stdout holds
    // exactly that document; the prose line went to stderr.
    expect(world.lines).toHaveLength(1);
    expect(world.errLines).toEqual([
      expect.stringMatching(/^error: .*code=manager_toolset_refused$/),
    ]);
    const envelope = JSON.parse(
      world.lines[world.lines.length - 1] as string,
    ) as {
      ok?: boolean;
      status?: string;
      error?: { code?: string; message?: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('manager_toolset_refused');
    expect(envelope.error?.message).toMatch(/bash/);
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
      {
        prompt: MANAGER_PROMPT,
        agents: ['alpha', 'beta'],
        session: 'sess-1',
        yes: true,
      },
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
      // Per worker, not once per run: the lane drove TWO workers, so its
      // own record holds two spawn → wait → collect sequences (the merge
      // plumbing contributes one further spawn_agent of its own).
      expect(trace.filter((call) => call === 'wait_for_agent')).toHaveLength(2);
      expect(trace.filter((call) => call === 'collect_result')).toHaveLength(2);
      expect(trace.filter((call) => call === 'spawn_agent')).toHaveLength(3);
      // The whole trace is still write-free.
      expect(() => assertManagerZeroWrites(trace)).not.toThrow();
    }
  });
});

describe('per-worker §68 results reach the output (issue #185)', () => {
  const resultFor = (agentId: string, summary: string) => ({
    status: 'completed' as const,
    summary,
    filesChanged: [`${agentId}.txt`],
    provenance: {
      workerId: agentId,
      sessionId: `s-${agentId}`,
      pid: 4242,
      generation: 1,
      worktree: `/repo/.kubic/wt/s/${agentId}`,
      model: 'faux/faux-1',
      role: 'implementer',
    },
    metrics: {
      inputTokens: 120,
      outputTokens: 30,
      cachedTokens: 7,
      toolCalls: 3,
      latencyMs: 2,
      wallMs: 50,
      costUsd: 0.25,
    },
  });
  const withResults = () =>
    makeWorld({
      runWorker: (agentId: string) => ({
        hunks: [{ path: `${agentId}.txt`, hunk: '@@ +1 @@' }],
        result: resultFor(agentId, agentId === 'worker-1' ? 'did X' : 'did Y'),
      }),
    });

  it('prints one summary line per worker in text mode', async () => {
    const world = withResults();
    const code = await runOrchestrateCommand(
      { prompt: 'x', agents: ['worker-1', 'worker-2'], yes: true },
      world.deps,
    );
    expect(code).toBe(0);
    expect(world.lines).toContain('worker-1 (implementer): did X');
    expect(world.lines).toContain('worker-2 (implementer): did Y');
  });

  it('carries role/status/summary/usage per worker in --json and persists the result', async () => {
    const world = withResults();
    await runOrchestrateCommand(
      { prompt: 'x', agents: ['worker-1'], yes: true, json: true },
      world.deps,
    );
    const envelope = lastJsonLine(world.lines) as {
      workers: {
        summary?: string;
        role?: string;
        status?: string;
        usage?: { inputTokens: number; toolCalls: number };
        provenance?: { pid: number };
      }[];
    };
    expect(envelope.workers[0]?.summary).toBe('did X');
    expect(envelope.workers[0]?.role).toBe('implementer');
    expect(envelope.workers[0]?.status).toBe('completed');
    expect(envelope.workers[0]?.usage).toMatchObject({
      inputTokens: 120,
      toolCalls: 3,
    });
    expect(envelope.workers[0]?.provenance?.pid).toBe(4242);
    const saved = world.saved[world.saved.length - 1];
    expect(saved?.records[0]?.result?.summary).toBe('did X');
    expect(JSON.stringify(saved)).not.toMatch(/"transcript"|"messages"/);
  });

  it('a failed worker still reports its result with error.kind in --json', async () => {
    const failed = {
      ...resultFor('worker-1', 'worker run exited 6'),
      status: 'failed' as const,
      error: { kind: 'provider' as const, message: 'exited 6' },
    };
    const world = makeWorld({
      runWorker: () => {
        throw Object.assign(new Error('worker run exited 6'), {
          code: 'worker_failed',
          result: failed,
        });
      },
    });
    const code = await runOrchestrateCommand(
      { prompt: 'x', agents: ['worker-1'], yes: true, json: true },
      world.deps,
    );
    expect(code).toBe(1);
    const envelope = lastJsonLine(world.lines) as {
      workers: { status?: string; error?: { kind: string } }[];
    };
    expect(envelope.workers[0]?.status).toBe('failed');
    expect(envelope.workers[0]?.error?.kind).toBe('provider');
  });
});

describe('worker credential preflight (issue #200)', () => {
  const rolePlan = {
    assignments: [
      {
        agentId: 'alpha',
        role: 'planner',
        promptText: 'You are the planner.',
        tools: ['read'],
        modelRef: 'gw/m1',
        thinking: undefined,
      },
    ],
    refused: [],
  };

  it('fails closed with exit 6 naming the provider before any worktree exists', async () => {
    const seen: WorkerCredentialRequest[] = [];
    const world = makeWorld({
      loadWorkerRoles: () => rolePlan,
      preflightWorkerCredentials: (requests) => {
        seen.push(...requests);
        return {
          agentId: 'alpha',
          role: 'planner',
          provider: 'gw',
          message:
            "no credential for provider 'gw': $GW_API_KEY not set in the orchestrator's environment",
        };
      },
    });
    const code = await runOrchestrateCommand(
      { prompt: 'x', agents: ['alpha'], yes: true, session: 'creds' },
      world.deps,
    );
    expect(code).toBe(6);
    // Nothing created: no worktree, no worker session, no spawn.
    expect(world.calls.ensure).toEqual([]);
    expect(world.calls.create).toEqual([]);
    expect(world.calls.run).toEqual([]);
    // The hook saw the resolved role and its model pin, not a made-up one.
    expect(seen).toEqual([
      { agentId: 'alpha', role: 'planner', modelRef: 'gw/m1' },
    ]);
    const text = world.errLines.join('\n');
    expect(text).toMatch(/code=credential_unavailable/);
    expect(text).toContain("provider 'gw'");
  });

  it('reports the same refusal in the --json envelope', async () => {
    const world = makeWorld({
      preflightWorkerCredentials: () => ({
        agentId: 'alpha',
        role: 'worker',
        provider: 'gw',
        message: "no credential for provider 'gw'",
      }),
    });
    const code = await runOrchestrateCommand(
      { prompt: 'x', agents: ['alpha'], yes: true, json: true },
      world.deps,
    );
    expect(code).toBe(6);
    const envelope = lastJsonLine(world.lines) as {
      ok: boolean;
      exitCode: number;
      error: { code: string; message: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.exitCode).toBe(6);
    expect(envelope.error.code).toBe('credential_unavailable');
    expect(envelope.error.message).toContain("provider 'gw'");
  });

  it('asks for the fallback worker role when no role document is assigned', async () => {
    const seen: WorkerCredentialRequest[] = [];
    const world = makeWorld({
      preflightWorkerCredentials: (requests) => {
        seen.push(...requests);
        return undefined;
      },
    });
    const code = await runOrchestrateCommand(
      { prompt: 'x', agents: ['alpha'], yes: true },
      world.deps,
    );
    expect(code).toBe(0);
    expect(seen).toEqual([{ agentId: 'alpha', role: 'worker' }]);
  });

  it('proceeds with the run when the preflight delivers every credential', async () => {
    const world = makeWorld({
      loadWorkerRoles: () => rolePlan,
      preflightWorkerCredentials: () => undefined,
    });
    const code = await runOrchestrateCommand(
      { prompt: 'x', agents: ['alpha'], yes: true },
      world.deps,
    );
    expect(code).toBe(0);
    expect(world.calls.ensure).toEqual(['alpha']);
    expect(world.calls.run).toEqual(['alpha']);
  });
});

// Issue #185: a worker's failure result reaches the SAVED state, not just the
// envelope, and a worker that never launched gets one too.
describe('failure results persist in the saved records (issue #185)', () => {
  const lastState = (world: FakeWorld): OrchestratorRunState =>
    world.saved[world.saved.length - 1] as OrchestratorRunState;
  const failureRecord = (
    world: FakeWorld,
    agentId: string,
  ): OrchestratorRunState['records'][number] | undefined =>
    lastState(world).records.find((record) => record.agentId === agentId);
  const priorFailure = (agentId: string): AgentResult =>
    buildAgentResult({
      status: 'failed',
      summary: 'the earlier attempt died',
      provenance: {
        workerId: agentId,
        sessionId: `sess-1-${agentId}`,
        pid: 4242,
        generation: 1,
        worktree: `/repo/.kubic/wt/${agentId}`,
        model: 'faux/faux-1',
      },
      metrics: { wallMs: 5, latencyMs: 1 },
      error: { kind: 'process', message: 'the earlier attempt died' },
    });

  it('a worker that throws without a report leaves a synthesized failed result, and stays pending', async () => {
    const world = makeWorld({
      runWorker: () => {
        throw new Error('boom');
      },
    });
    const code = await runOrchestrateCommand(
      { prompt: 'demo', agents: ['alpha', 'beta'], session: 'sess-1' },
      world.deps,
    );
    expect(code).toBe(1);
    expect(world.errLines.join('\n')).toMatch(/code=worker_failed/);
    const record = failureRecord(world, 'alpha');
    expect(record).toMatchObject({
      agentId: 'alpha',
      branch: 'kubic/alpha',
      hunks: [],
    });
    expect(record?.result).toMatchObject({
      status: 'failed',
      summary: "worker 'alpha' failed: boom",
      error: {
        kind: 'process',
        message: "worker 'alpha' failed: boom",
        details: { code: 'worker_failed' },
      },
      provenance: {
        workerId: 'alpha',
        sessionId: 'sess-1-alpha',
        pid: null,
        generation: 0,
        worktree: '/repo/.kubic/wt/alpha',
        model: 'unresolved',
      },
      metrics: { wallMs: 0, latencyMs: 0 },
    });
    // Both workers ran concurrently (#206) and both failed: each gets its own
    // synthesized record, both stay pending for the retry, and nothing merged.
    expect(failureRecord(world, 'beta')?.result).toMatchObject({
      status: 'failed',
      error: { details: { code: 'worker_failed' } },
    });
    expect(lastState(world).pending).toEqual(['alpha', 'beta']);
    expect(lastState(world).merged).toEqual([]);
    // One record per agent, in agent order — no double-record from the
    // concurrent failure path.
    expect(lastState(world).records.map((entry) => entry.agentId)).toEqual([
      'alpha',
      'beta',
    ]);
  });

  it('a lifecycle spawn_failed error is a spawn_failed result', async () => {
    const world = makeWorld({
      runWorker: () => {
        throw Object.assign(new Error('never ready'), {
          code: 'spawn_failed',
        });
      },
    });
    await runOrchestrateCommand(
      { prompt: 'demo', agents: ['alpha'], session: 'sess-1' },
      world.deps,
    );
    expect(failureRecord(world, 'alpha')?.result).toMatchObject({
      status: 'spawn_failed',
      error: { kind: 'process', details: { code: 'spawn_failed' } },
    });
  });

  it('an approval terminus is recorded as an approval failure carrying its code', async () => {
    const world = makeWorld({
      runWorker: () => {
        throw Object.assign(new Error('denied by the user'), {
          approval: { code: 'approval_denied', exitCode: 4 },
        });
      },
    });
    const code = await runOrchestrateCommand(
      { prompt: 'demo', agents: ['alpha'], session: 'sess-1' },
      world.deps,
    );
    expect(code).toBe(4);
    expect(failureRecord(world, 'alpha')?.result).toMatchObject({
      status: 'failed',
      error: { kind: 'approval', details: { code: 'approval_denied' } },
    });
  });

  it('the result the worker reported wins over a synthesized one', async () => {
    const reported = buildAgentResult({
      status: 'timeout',
      summary: 'ran out of time',
      provenance: {
        workerId: 'alpha',
        sessionId: 'sess-1-alpha',
        pid: 77,
        generation: 1,
        worktree: '/repo/.kubic/wt/alpha',
        model: 'faux/faux-1',
      },
      metrics: { wallMs: 9, latencyMs: 2 },
    });
    const world = makeWorld({
      runWorker: () => {
        throw Object.assign(new Error('timed out'), { result: reported });
      },
    });
    await runOrchestrateCommand(
      { prompt: 'demo', agents: ['alpha'], session: 'sess-1' },
      world.deps,
    );
    expect(failureRecord(world, 'alpha')?.result).toEqual(reported);
  });

  it('a worktree-stage failure is a spawn_failed workspace result with no worktree path', async () => {
    const world = makeWorld({
      ensureWorktree: () => {
        throw Object.assign(new Error('retained from an earlier run'), {
          code: 'worktree_exists',
        });
      },
    });
    const code = await runOrchestrateCommand(
      { prompt: 'demo', agents: ['alpha'], session: 'sess-1' },
      world.deps,
    );
    expect(code).toBe(1);
    const record = failureRecord(world, 'alpha');
    expect(record?.branch).toBe('kubic/sess-1/alpha');
    expect(record?.result).toMatchObject({
      status: 'spawn_failed',
      summary: "spawn failed for worker 'alpha': retained from an earlier run",
      error: { kind: 'workspace', details: { code: 'worktree_exists' } },
      provenance: {
        workerId: 'alpha',
        sessionId: 'sess-1-alpha',
        pid: null,
        generation: 0,
        worktree: '(no worktree)',
        model: 'unresolved',
      },
    });
  });

  it('a session-creation failure is recorded against the worker with its worktree', async () => {
    const world = makeWorld({
      createWorkerSession: () => {
        throw new Error('store is read-only');
      },
    });
    await runOrchestrateCommand(
      { prompt: 'demo', agents: ['alpha'], session: 'sess-1' },
      world.deps,
    );
    const record = failureRecord(world, 'alpha');
    expect(record?.branch).toBe('kubic/alpha');
    expect(record?.result).toMatchObject({
      status: 'spawn_failed',
      error: { kind: 'process', details: { code: 'spawn_failed' } },
      provenance: { worktree: '/repo/.kubic/wt/alpha' },
    });
    expect(record?.result?.summary).toContain(
      "could not create session 'sess-1-alpha': store is read-only",
    );
  });

  it('a missing session-creation hook is recorded the same way', async () => {
    const world = makeWorld({ createWorkerSession: () => undefined });
    await runOrchestrateCommand(
      { prompt: 'demo', agents: ['alpha'], session: 'sess-1' },
      world.deps,
    );
    expect(failureRecord(world, 'alpha')?.result?.summary).toContain(
      'no session-creation hook is wired',
    );
    expect(failureRecord(world, 'alpha')?.result?.status).toBe('spawn_failed');
  });

  it('an admission denial is recorded as a spawn_failed result naming the reason', async () => {
    const world = makeWorld({
      scheduler: {
        requestSpawn: () => ({ outcome: 'denied', reason: 'cap reached' }),
        complete: () => undefined,
        runningCount: () => 0,
        queuedCount: () => 0,
        maxConcurrency: () => 1,
        // The run reconciles its queue view after every scheduler
        // interaction (issue #206 review): a fake must answer these too.
        pendingIds: () => [],
        runningIds: () => [],
        maxPendingMs: () => 60_000,
      } as unknown as OrchestrateCommandDeps['scheduler'],
    });
    const code = await runOrchestrateCommand(
      { prompt: 'demo', agents: ['alpha'], session: 'sess-1' },
      world.deps,
    );
    expect(code).toBe(1);
    expect(failureRecord(world, 'alpha')?.result).toMatchObject({
      status: 'spawn_failed',
      summary: "spawn denied for worker 'alpha': cap reached",
      error: { kind: 'process', details: { code: 'spawn_denied' } },
    });
  });

  it('a failure before the worker launched replaces a stale failure record from an earlier attempt', async () => {
    const world = makeWorld({
      loadState: () => ({
        version: 1,
        sessionId: 'sess-1',
        prompt: 'demo',
        agents: ['alpha'],
        merged: [],
        pending: ['alpha'],
        stopped: false,
        records: [
          {
            agentId: 'alpha',
            branch: 'kubic/alpha',
            hunks: [],
            result: priorFailure('alpha'),
          },
        ],
      }),
      createWorkerSession: () => {
        throw new Error('store is read-only');
      },
    });
    await runOrchestrateCommand(
      { resume: true, session: 'sess-1' },
      world.deps,
    );
    expect(lastState(world).records).toHaveLength(1);
    expect(failureRecord(world, 'alpha')?.result?.summary).not.toContain(
      'the earlier attempt died',
    );
    expect(failureRecord(world, 'alpha')?.result?.provenance.pid).toBeNull();
  });

  it('a worktree-stage failure on resume replaces the earlier attempt\u2019s failure record and result view', async () => {
    const world = makeWorld({
      loadState: () => ({
        version: 1,
        sessionId: 'sess-1',
        prompt: 'demo',
        agents: ['alpha'],
        merged: [],
        pending: ['alpha'],
        stopped: false,
        records: [
          {
            agentId: 'alpha',
            branch: 'kubic/alpha',
            hunks: [],
            result: priorFailure('alpha'),
          },
        ],
      }),
      ensureWorktree: () => {
        throw Object.assign(new Error('worktree gone'), {
          code: 'worktree_missing',
        });
      },
    });
    const code = await runOrchestrateCommand(
      { resume: true, session: 'sess-1', json: true },
      world.deps,
    );
    expect(code).toBe(1);
    // The saved record is THIS attempt's spawn_failed, not attempt 1's.
    expect(lastState(world).records).toHaveLength(1);
    const result = failureRecord(world, 'alpha')?.result;
    expect(result?.status).toBe('spawn_failed');
    expect(result?.summary).toBe(
      "spawn failed for worker 'alpha': worktree gone",
    );
    expect(result?.summary).not.toContain('the earlier attempt died');
    expect(result?.provenance.pid).toBeNull();
    expect(result?.provenance.generation).toBe(0);
    // And so is the envelope's worker view.
    const envelope = JSON.parse(world.lines.join('\n')) as {
      workers: { summary?: string; status?: string }[];
    };
    expect(envelope.workers[0]?.status).toBe('spawn_failed');
    expect(envelope.workers[0]?.summary).toBe(
      "spawn failed for worker 'alpha': worktree gone",
    );
  });

  it('a worktree failure while reconciling a write-ahead merge intent records its own result, not the earlier attempt\u2019s', async () => {
    const world = makeWorld({
      loadState: () => ({
        version: 1,
        sessionId: 'sess-1',
        prompt: 'demo',
        agents: ['alpha'],
        merged: [],
        pending: ['alpha'],
        stopped: false,
        merging: 'alpha',
        records: [
          {
            agentId: 'alpha',
            branch: 'kubic/alpha',
            hunks: [],
            result: priorFailure('alpha'),
          },
        ],
      }),
      ensureWorktree: () => {
        throw new Error('worktree gone');
      },
    });
    const code = await runOrchestrateCommand(
      { resume: true, session: 'sess-1' },
      world.deps,
    );
    expect(code).toBe(1);
    expect(failureRecord(world, 'alpha')?.result?.summary).toBe(
      "spawn failed for worker 'alpha': worktree gone",
    );
    expect(lastState(world).records).toHaveLength(1);
  });

  describe('a manager-side termination decides the stored outcome (issue #185)', () => {
    // A run whose worker child died on its own (its report says a plain
    // process failure) while the manager's approvals layer had already ended
    // the worker on a named terminus: the run exits on THAT code, so the saved
    // result must say the same thing.
    const childReport = (agentId: string): AgentResult =>
      buildAgentResult({
        status: 'failed',
        summary: 'worker run exited 1: it just stopped',
        provenance: {
          workerId: agentId,
          sessionId: `sess-1-${agentId}`,
          pid: 7331,
          generation: 1,
          worktree: `/repo/.kubic/wt/${agentId}`,
          model: 'faux/faux-1',
        },
        metrics: { wallMs: 42, latencyMs: 3, toolCalls: 2 },
        error: { kind: 'process', message: 'worker run exited 1' },
      });
    const runWith = async (termination: {
      code: string;
      exitCode: number;
      message: string;
    }) => {
      const approvals = {
        beginWorker: () => undefined,
        endWorker: () => undefined,
        pump: async () => undefined,
        takeTermination: (agentId: string) => ({ agentId, ...termination }),
      } as unknown as ReturnType<
        NonNullable<OrchestrateCommandDeps['approvals']>
      >;
      const world = makeWorld({
        approvals: () => approvals,
        runWorker: (agentId: string) => {
          throw Object.assign(new Error('it just stopped'), {
            result: childReport(agentId),
          });
        },
      });
      const code = await runOrchestrateCommand(
        { prompt: 'demo', agents: ['alpha'], session: 'sess-1' },
        world.deps,
      );
      return { world, code };
    };

    it('a budget termination is recorded as budget_exhausted / kind budget, keeping the child\u2019s provenance and metrics', async () => {
      const { world, code } = await runWith({
        code: 'BUDGET_EXHAUSTED',
        exitCode: 3,
        message:
          'budget BUDGET_EXHAUSTED (limit=toolCalls): the call is blocked',
      });
      expect(code).toBe(3);
      const result = failureRecord(world, 'alpha')?.result;
      expect(result).toMatchObject({
        status: 'budget_exhausted',
        summary:
          'budget BUDGET_EXHAUSTED (limit=toolCalls): the call is blocked',
        error: {
          kind: 'budget',
          message:
            'budget BUDGET_EXHAUSTED (limit=toolCalls): the call is blocked',
          details: { code: 'BUDGET_EXHAUSTED' },
        },
        provenance: { pid: 7331, generation: 1, model: 'faux/faux-1' },
        metrics: { wallMs: 42, toolCalls: 2 },
      });
    });

    it('an approval denial is recorded as a failed result of kind approval carrying its code', async () => {
      const { world, code } = await runWith({
        code: 'approval_denied',
        exitCode: 4,
        message: "approval denied for worker 'alpha' (network): not now",
      });
      expect(code).toBe(4);
      expect(failureRecord(world, 'alpha')?.result).toMatchObject({
        status: 'failed',
        error: {
          kind: 'approval',
          details: { code: 'approval_denied' },
        },
        provenance: { pid: 7331 },
      });
    });

    it('with no worker result the termination is synthesized in the same shape', async () => {
      const approvals = {
        beginWorker: () => undefined,
        endWorker: () => undefined,
        pump: async () => undefined,
        takeTermination: (agentId: string) => ({
          agentId,
          code: 'approval_timeout',
          exitCode: 4,
          message: 'approval timed out after 25ms',
        }),
      } as unknown as ReturnType<
        NonNullable<OrchestrateCommandDeps['approvals']>
      >;
      const world = makeWorld({
        approvals: () => approvals,
        runWorker: () => {
          throw new Error('stopped');
        },
      });
      await runOrchestrateCommand(
        { prompt: 'demo', agents: ['alpha'], session: 'sess-1' },
        world.deps,
      );
      expect(failureRecord(world, 'alpha')?.result).toMatchObject({
        status: 'failed',
        summary: 'approval timed out after 25ms',
        error: { kind: 'approval', details: { code: 'approval_timeout' } },
      });
    });
  });

  it('a failure record that cannot be saved never replaces the failure the run exits with', async () => {
    const world = makeWorld({
      runWorker: () => {
        throw new Error('boom');
      },
    });
    const store = world.deps.saveState;
    world.deps.saveState = (state: OrchestratorRunState) => {
      // The run's own saves succeed; only the failure record's save throws.
      if (state.records.length > 0) throw new Error('disk full');
      return store?.(state);
    };
    const code = await runOrchestrateCommand(
      { prompt: 'demo', agents: ['alpha'], session: 'sess-1' },
      world.deps,
    );
    expect(code).toBe(1);
    const text = world.errLines.join('\n');
    expect(text).toMatch(/code=worker_failed/);
    expect(text).not.toMatch(/state_save_failed/);
    expect(world.debugLines.join('\n')).toContain(
      "state: failure record for 'alpha' not saved — disk full",
    );
  });

  it('a retry that succeeds replaces the failure record; reconciling an already-merged retry drops the stale failure result', async () => {
    const killed = (result: AgentResult): OrchestratorRunState => ({
      version: 1,
      sessionId: 'sess-1',
      prompt: 'demo',
      agents: ['alpha'],
      merged: [],
      pending: ['alpha'],
      stopped: false,
      merging: 'alpha',
      records: [{ agentId: 'alpha', branch: 'kubic/alpha', hunks: [], result }],
    });
    // The branch is already merged on disk: the failure result belonged to
    // an earlier attempt, so the merge record carries none.
    const failed = makeWorld({
      loadState: () => killed(priorFailure('alpha')),
      isBranchMerged: () => true,
    });
    await runOrchestrateCommand(
      { resume: true, session: 'sess-1' },
      failed.deps,
    );
    expect(lastState(failed).records).toEqual([
      { agentId: 'alpha', branch: 'kubic/alpha', hunks: [] },
    ]);
    expect(lastState(failed).merged).toEqual(['alpha']);
    // A completed result already on record is kept as it is.
    const completed = buildAgentResult({
      status: 'completed',
      summary: 'did the work',
      provenance: {
        workerId: 'alpha',
        sessionId: 'sess-1-alpha',
        pid: 1,
        generation: 1,
        worktree: '/repo/.kubic/wt/alpha',
        model: 'faux/faux-1',
      },
      metrics: { wallMs: 1, latencyMs: 0 },
    });
    const kept = makeWorld({
      loadState: () => killed(completed),
      isBranchMerged: () => true,
    });
    await runOrchestrateCommand({ resume: true, session: 'sess-1' }, kept.deps);
    expect(lastState(kept).records).toEqual([
      { agentId: 'alpha', branch: 'kubic/alpha', hunks: [], result: completed },
    ]);
  });
});
