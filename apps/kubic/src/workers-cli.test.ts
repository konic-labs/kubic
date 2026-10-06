// `kubic workers [--json] [--debug]` (issue #42; §50, §49.3, §13): live
// procs with age/owner/resources, startup span surfaced, --debug spawn +
// clean-exit lines. Presentation only — rows arrive injected, and the
// options arrive already parsed (argv, `--help` and unknown flags are the
// commander program's job: apps/kubic/src/commands/orchestrator.test.ts).
//
// Issue #151 splits the row's one status into the §13 PAIR: the AGENT state
// (what the work did) and the PROCESS phase (spawning | ready | exiting), so
// an exited-but-settling worker reads as `settling [exiting]` instead of
// `crashed`.
import { describe, expect, it } from 'vitest';
import { createCliTheme } from '../../../packages/core/src/cli/theme.js';
import {
  parsePsSample,
  runWorkerInspectCommand,
  runWorkersCommand,
  runWorkerTerminateCommand,
  type WorkerInspectDeps,
  type WorkerListRow,
  type WorkersCommandDeps,
  type WorkerTerminateDeps,
} from '../../../packages/host/src/workers-cli.js';

const ROW: WorkerListRow = {
  workerId: 'w-1',
  sessionId: 's-1',
  generation: 2,
  status: 'ready',
  agentStatus: 'running',
  startedAtMs: 90_000,
  owner: 'parent-session',
  resources: { skills: ['review'] },
  pid: 4242,
  startupMs: 40,
};

function deps(
  lines: string[],
  rows: WorkerListRow[] = [ROW],
  errs: string[] = [],
): WorkersCommandDeps {
  return {
    list: () => rows,
    now: () => 100_000,
    out: (line: string) => lines.push(line),
    err: (line: string) => errs.push(line),
  };
}

describe('kubic workers (issue #42)', () => {
  it('shows live procs with age/owner/resources as an aligned table', async () => {
    const lines: string[] = [];
    const code = await runWorkersCommand({}, deps(lines));
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.split('\n')).toEqual([
      'WORKER  AGENT    PROCESS  GEN  AGE  OWNER            PID  STARTUP  RESOURCES      BUDGET',
      'w-1     running  ready      2  10s  parent-session  4242     40ms  skills=review  -',
    ]);
  });

  it('renders placeholders for a row with no pid, startup span or resources', async () => {
    const lines: string[] = [];
    const bare: WorkerListRow = {
      workerId: 'w-2',
      sessionId: 's-1',
      generation: 1,
      status: 'exiting',
      agentStatus: 'failed',
      signal: 'SIGKILL',
      startedAtMs: 100_000 - 3 * 60 * 60 * 1000,
      owner: 'o',
    };
    await runWorkersCommand({}, deps(lines, [bare]));
    expect(lines[0]?.split('\n')[1]).toBe(
      'w-2     failed  exiting(SIGKILL)    1  3h   o        -        -  -          -',
    );
    // A row that only knows its process phase (an embedder) still renders.
    await runWorkersCommand(
      {},
      deps(lines, [{ ...bare, agentStatus: undefined, signal: undefined }]),
    );
    expect(lines[1]?.split('\n')[1]).toMatch(/^w-2\s+-\s+exiting\s+1\s/);
  });

  it('colours the status through the theme and draws the kit table when fancy', async () => {
    const lines: string[] = [];
    const theme = createCliTheme('16');
    await runWorkersCommand({}, { ...deps(lines), theme, fancy: true });
    const text = lines.join('\n');
    expect(text).toContain('──');
    expect(text).not.toContain('┌');
    expect(text).toContain(theme.success('running'));
  });

  // Issue #285 (§71): a budgeted worker's row names its effective limits
  // with burn-down from the settled consumption; --json carries the same
  // block. Unbounded rows stay silent (no invented budget).
  it('shows budget burn-down in a BUDGET column when limits are stored', async () => {
    const lines: string[] = [];
    const row: WorkerListRow = {
      ...ROW,
      budget: { shared: { maxToolCalls: 10, maxCostUsd: 0.5 } },
      consumption: {
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.12,
        toolCalls: 3,
      },
    };
    await runWorkersCommand({}, deps(lines, [row]));
    expect(lines[0]?.split('\n')[0]).toContain('BUDGET');
    expect(lines[0]).toContain('tools 3/10');
    expect(lines[0]).toContain('$0.12/$0.50');
  });

  it('shows limits without burn-down while the worker is still live', async () => {
    const lines: string[] = [];
    const row: WorkerListRow = {
      ...ROW,
      budget: { worker: { maxToolCalls: 4 } },
      consumption: undefined,
    };
    await runWorkersCommand({}, deps(lines, [row]));
    expect(lines[0]).toContain('maxToolCalls=4');
    expect(lines[0]).not.toContain('tools 0/4');
  });

  it('carries budget:{limits,usage} in --json only when bounded', async () => {
    const lines: string[] = [];
    const bounded: WorkerListRow = {
      ...ROW,
      budget: { shared: { maxToolCalls: 10 }, worker: { maxCostUsd: 0.5 } },
      consumption: {
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.12,
        toolCalls: 3,
      },
    };
    await runWorkersCommand({ json: true }, deps(lines, [bounded, ROW]));
    const doc = JSON.parse(lines[0] ?? '');
    expect(doc[0]?.budget).toEqual({
      limits: { maxToolCalls: 10, maxCostUsd: 0.5 },
      usage: { tokens: 150, costUsd: 0.12, toolCalls: 3 },
    });
    expect(doc[1]?.budget).toBeUndefined();
  });

  it('prints --json rows carrying the §13 status and startup span ms', async () => {
    const lines: string[] = [];
    const code = await runWorkersCommand({ json: true }, deps(lines));
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual([
      {
        workerId: 'w-1',
        sessionId: 's-1',
        generation: 2,
        status: 'ready',
        agentStatus: 'running',
        ageMs: 10_000,
        owner: 'parent-session',
        resources: { skills: ['review'] },
        pid: 4242,
        startupMs: 40,
      },
    ]);
    // Two-space indented: the one `formatJson` serializer.
    expect(lines[0]).toContain('[\n  {\n    "workerId": "w-1"');
  });

  it('names the failure a FAILED row settled on (issue #163)', async () => {
    const lines: string[] = [];
    const failed: WorkerListRow = {
      ...ROW,
      agentStatus: 'failed',
      failure: {
        code: 'resource_disk_exceeded',
        message: "worker 'w-1' exceeded its worktree disk quota",
      },
    };
    const code = await runWorkersCommand({}, deps(lines, [failed]));
    expect(code).toBe(0);
    // The AGENT cell carries the code, like PROCESS carries its signal.
    expect(lines[0]?.split('\n')[1]).toContain(
      'failed(resource_disk_exceeded)',
    );
    const jsonLines: string[] = [];
    const jsonCode = await runWorkersCommand(
      { json: true },
      deps(jsonLines, [failed]),
    );
    expect(jsonCode).toBe(0);
    expect(JSON.parse(jsonLines[0] ?? '')).toEqual([
      {
        workerId: 'w-1',
        sessionId: 's-1',
        generation: 2,
        status: 'ready',
        agentStatus: 'failed',
        failure: {
          code: 'resource_disk_exceeded',
          message: "worker 'w-1' exceeded its worktree disk quota",
        },
        ageMs: 10_000,
        owner: 'parent-session',
        resources: { skills: ['review'] },
        pid: 4242,
        startupMs: 40,
      },
    ]);
  });

  it('an empty record prints nothing on stdout (`[]` under --json) and says so on stderr', async () => {
    const lines: string[] = [];
    const errs: string[] = [];
    expect(await runWorkersCommand({}, deps(lines, [], errs))).toBe(0);
    expect(lines).toEqual([]);
    expect(errs).toEqual([
      'info: no orchestrator workers recorded in this repo',
    ]);

    const json: string[] = [];
    const jsonErrs: string[] = [];
    expect(
      await runWorkersCommand({ json: true }, deps(json, [], jsonErrs)),
    ).toBe(0);
    expect(json).toEqual(['[]']);
    expect(jsonErrs).toEqual([]);
  });

  it('--debug emits spawn and clean-exit lines per §50', async () => {
    const lines: string[] = [];
    const debug: string[] = [];
    const code = await runWorkersCommand(
      { debug: true },
      {
        ...deps(lines),
        debug: (line: string) => debug.push(line),
      },
    );
    expect(code).toBe(0);
    expect(debug).toEqual([
      '[worker] spawn id=w-1 session=s-1 gen=2 pid=4242 startup=40ms',
      '[exit] code=0 (kubic workers command exit)',
    ]);
  });

  it('without --debug the debug channel stays silent', async () => {
    const debug: string[] = [];
    await runWorkersCommand(
      {},
      { ...deps([]), debug: (line: string) => debug.push(line) },
    );
    expect(debug).toEqual([]);
  });
});

describe('kubic workers inspect (issue #167)', () => {
  const INSPECT_ROW: WorkerListRow = {
    ...ROW,
    sessionId: 'run-1-w-1',
    owner: 'orchestrate:run-1',
  };
  function inspectDeps(
    lines: string[],
    errs: string[],
    overrides: Partial<WorkerInspectDeps> = {},
  ): WorkerInspectDeps {
    return {
      find: (id) => (id === 'w-1' ? INSPECT_ROW : undefined),
      worktree: () => ({
        path: '/repo/.kubic/wt/run-1/w-1',
        branch: 'kubic/run-1/w-1',
        clean: false,
        changed: 3,
      }),
      run: () => ({
        budget: { worker: { maxTokens: 1000 } },
        usageHint: 'kubic cost --session run-1-w-1',
        pendingApproval: false,
      }),
      now: () => 100_000,
      out: (line: string) => lines.push(line),
      err: (line: string) => errs.push(line),
      ...overrides,
    };
  }

  it('prints the row plus worktree, budget, usage and approvals', async () => {
    const lines: string[] = [];
    const errs: string[] = [];
    const code = await runWorkerInspectCommand(
      'w-1',
      {},
      inspectDeps(lines, errs),
    );
    expect(code).toBe(0);
    expect(errs).toEqual([]);
    expect(lines.join('\n')).toContain('w-1');
    // The 10-cell overflow from the #248 review: the header row must
    // carry all nine cells — the STARTUP value and the grants cell.
    expect(lines[0]?.split('\n')).toHaveLength(2);
    expect(lines[0]?.split('\n')[1]).toContain('40ms');
    expect(lines[0]?.split('\n')[1]).toContain('skills=review');
    expect(lines.join('\n')).toContain(
      'worktree: /repo/.kubic/wt/run-1/w-1 (kubic/run-1/w-1, dirty: 3 files)',
    );
    expect(lines.join('\n')).toContain('budget: worker maxTokens=1000');
    expect(lines.join('\n')).toContain(
      'usage: accruing (kubic cost --session run-1-w-1)',
    );
    expect(lines.join('\n')).toContain('approvals: none pending');
  });

  it('names a waiting worker and its last decision, and a settled usage rollup', async () => {
    const lines: string[] = [];
    const waiting: WorkerListRow = {
      ...INSPECT_ROW,
      agentStatus: 'waiting',
    };
    const code = await runWorkerInspectCommand(
      'w-1',
      {},
      inspectDeps(lines, [], {
        find: () => waiting,
        run: () => ({
          usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
          pendingApproval: true,
          lastDecision: 'deny tool:exec — needs approval',
        }),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain(
      'approvals: 1 ask pending (worker is waiting); last: deny tool:exec — needs approval',
    );
    expect(lines.join('\n')).toContain(
      'usage: input=100 output=50 costUsd=0.01',
    );
  });

  it('is honest about missing facets instead of inventing them', async () => {
    const lines: string[] = [];
    const code = await runWorkerInspectCommand(
      'w-1',
      {},
      inspectDeps(lines, [], {
        worktree: () => undefined,
        run: () => undefined,
      }),
    );
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('worktree: not found');
    expect(lines.join('\n')).toContain('budget: none recorded');
    expect(lines.join('\n')).toContain('usage: no record yet');
    expect(lines.join('\n')).toContain('approvals: none pending');
  });

  it('--json prints one object with every facet', async () => {
    const lines: string[] = [];
    const code = await runWorkerInspectCommand(
      'w-1',
      { json: true },
      inspectDeps(lines, []),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join('\n')) as Record<string, unknown>;
    expect(parsed.workerId).toBe('w-1');
    expect(parsed.worktree).toEqual({
      path: '/repo/.kubic/wt/run-1/w-1',
      branch: 'kubic/run-1/w-1',
      clean: false,
      changed: 3,
    });
    expect(parsed.budget).toEqual({ worker: { maxTokens: 1000 } });
    expect(parsed.usageHint).toBe('kubic cost --session run-1-w-1');
  });

  it('adds the task, the change summary and the tool count when known (issue #464)', async () => {
    const run = () => ({
      pendingApproval: false,
      task: 'Fix the cart total',
      toolCount: 12,
      diffStat: { files: 2, added: 14, removed: 3 },
    });
    const lines: string[] = [];
    expect(
      await runWorkerInspectCommand('w-1', {}, inspectDeps(lines, [], { run })),
    ).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('task: Fix the cart total');
    expect(text).toContain('changes: 2 files +14 −3');
    expect(text).toContain('tools: 12 calls');
    const json: string[] = [];
    await runWorkerInspectCommand(
      'w-1',
      { json: true },
      inspectDeps(json, [], { run }),
    );
    expect(JSON.parse(json.join('\n'))).toMatchObject({
      task: 'Fix the cart total',
      toolCount: 12,
      diffStat: { files: 2, added: 14, removed: 3 },
    });
    // Unknown stays absent — never an invented zero.
    const bare: string[] = [];
    await runWorkerInspectCommand('w-1', {}, inspectDeps(bare, []));
    expect(bare.join('\n')).not.toMatch(/^(task|changes|tools):/m);
  });

  it('an unknown id exits 1 with the documented code', async () => {
    const lines: string[] = [];
    const errs: string[] = [];
    const code = await runWorkerInspectCommand(
      'ghost',
      {},
      inspectDeps(lines, errs),
    );
    expect(code).toBe(1);
    expect(lines).toEqual([]);
    expect(errs.join('\n')).toMatch(/code=no_such_worker/);
  });
});

describe('kubic workers terminate (issue #167)', () => {
  function terminateDeps(
    lines: string[],
    errs: string[],
    overrides: Partial<WorkerTerminateDeps> = {},
  ): WorkerTerminateDeps & { signalled: number[] } {
    const signalled: number[] = [];
    const deps: WorkerTerminateDeps & { signalled: number[] } = {
      find: (id) => (id === 'w-1' ? ROW : undefined),
      command: () =>
        Promise.resolve('node bin/kubic.js run -p x --session s-1'),
      signal: (pid) => {
        signalled.push(pid);
      },
      out: (line: string) => lines.push(line),
      err: (line: string) => errs.push(line),
      ...overrides,
      signalled,
    };
    return deps;
  }

  it('signals the verified pid and names the worker it stopped', async () => {
    const lines: string[] = [];
    const deps = terminateDeps(lines, []);
    const code = await runWorkerTerminateCommand('w-1', {}, deps);
    expect(code).toBe(0);
    expect(deps.signalled).toEqual([4242]);
    expect(lines.join('\n')).toContain("terminated worker 'w-1'");
    expect(lines.join('\n')).toContain('pid 4242');
  });

  it('a matching --generation proceeds; a stale one exits 2 without signalling', async () => {
    const lines: string[] = [];
    const errs: string[] = [];
    const deps = terminateDeps(lines, errs);
    expect(
      await runWorkerTerminateCommand('w-1', { generation: 2 }, deps),
    ).toBe(0);
    expect(deps.signalled).toEqual([4242]);
    const errs2: string[] = [];
    const deps2 = terminateDeps([], errs2);
    expect(
      await runWorkerTerminateCommand('w-1', { generation: 1 }, deps2),
    ).toBe(2);
    expect(deps2.signalled).toEqual([]);
    expect(errs2.join('\n')).toMatch(/code=stale_generation/);
  });

  it('an unknown id exits 1 with the documented code', async () => {
    const errs: string[] = [];
    const deps = terminateDeps([], errs);
    expect(await runWorkerTerminateCommand('ghost', {}, deps)).toBe(1);
    expect(deps.signalled).toEqual([]);
    expect(errs.join('\n')).toMatch(/code=no_such_worker/);
  });

  it('a settled worker is refused, never signalled', async () => {
    const errs: string[] = [];
    const settled: WorkerListRow = { ...ROW, agentStatus: 'completed' };
    const deps = terminateDeps([], errs, { find: () => settled });
    expect(await runWorkerTerminateCommand('w-1', {}, deps)).toBe(1);
    expect(deps.signalled).toEqual([]);
    expect(errs.join('\n')).toMatch(/code=worker_not_running/);
  });

  it('a reused pid (command line is foreign) is refused, never signalled', async () => {
    const errs: string[] = [];
    const deps = terminateDeps([], errs, {
      command: () => Promise.resolve('postgres: checkpointer'),
    });
    expect(await runWorkerTerminateCommand('w-1', {}, deps)).toBe(1);
    expect(deps.signalled).toEqual([]);
    expect(errs.join('\n')).toMatch(/code=worker_not_running/);
  });

  it('a gone pid (no command line) is refused, never signalled blind', async () => {
    const errs: string[] = [];
    const deps = terminateDeps([], errs, {
      command: () => Promise.resolve(undefined),
    });
    expect(await runWorkerTerminateCommand('w-1', {}, deps)).toBe(1);
    expect(deps.signalled).toEqual([]);
    expect(errs.join('\n')).toMatch(/code=worker_not_running/);
  });
});

describe('kubic workers resources (issue #248)', () => {
  it('shows sampled rss/cpu in RESOURCES for a live pid', async () => {
    const lines: string[] = [];
    const code = await runWorkersCommand(
      {},
      {
        ...deps(lines),
        sample: (pid) =>
          pid === 4242 ? { rssKb: 12_800, cpuPct: 3.5 } : undefined,
      },
    );
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('rss=12.5MB');
    expect(lines.join('\n')).toContain('cpu=3.5%');
  });

  it('omits rss/cpu when the sample fails', async () => {
    const lines: string[] = [];
    await runWorkersCommand({}, { ...deps(lines), sample: () => undefined });
    expect(lines.join('\n')).not.toContain('rss=');
    expect(lines.join('\n')).not.toContain('cpu=');
  });

  it('shows tok/cost/calls from the usage summary', async () => {
    const lines: string[] = [];
    await runWorkersCommand(
      {},
      {
        ...deps(lines, [
          {
            ...ROW,
            consumption: {
              inputTokens: 1200,
              outputTokens: 300,
              cachedTokens: 500,
              toolCalls: 5,
              costUsd: 0.012,
            },
          },
        ]),
      },
    );
    const text = lines.join('\n');
    // Settled cached tokens count toward the total (review #248).
    expect(text).toContain('tok=2k');
    expect(text).toContain('cost=$0.012');
    expect(text).toContain('calls=5');
  });

  it('--json gains resourceUsage and consumption (additive)', async () => {
    const lines: string[] = [];
    await runWorkersCommand(
      { json: true },
      {
        ...deps(lines, [
          {
            ...ROW,
            consumption: { inputTokens: 100, costUsd: 0.001 },
          },
        ]),
        sample: () => ({ rssKb: 8192, cpuPct: 0 }),
      },
    );
    const doc = JSON.parse(lines.join('\n')) as Record<string, unknown>[];
    expect(doc[0]?.resourceUsage).toEqual({ rssMb: 8, cpuPct: 0 });
    expect(doc[0]?.consumption).toEqual({
      inputTokens: 100,
      costUsd: 0.001,
    });
    // Everything the old document carried is still there.
    expect(doc[0]?.workerId).toBe('w-1');
    expect(doc[0]?.pid).toBe(4242);
  });

  it('labels the --debug exit line as the command exit, not a worker exit', async () => {
    const lines: string[] = [];
    const debug: string[] = [];
    await runWorkersCommand(
      { debug: true },
      { ...deps(lines), debug: (line: string) => debug.push(line) },
    );
    expect(debug.at(-1)).toContain('(kubic workers command exit)');
    expect(debug.join('\n')).not.toContain('exited cleanly');
  });

  it('parsePsSample reads `ps -o rss=,pcpu=` output and refuses garbage', () => {
    expect(parsePsSample(' 12800  3.5\n')).toEqual({
      rssKb: 12_800,
      cpuPct: 3.5,
    });
    expect(parsePsSample('')).toBeUndefined();
    expect(parsePsSample('nope\n')).toBeUndefined();
    expect(parsePsSample('12800\n')).toBeUndefined();
  });
});
