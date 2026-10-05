// Budget enforcement on the delegation path (issue #208, §71). RED first:
// `--budget maxCostUsd=0.10` let a worker spend $5 and exit 0,
// `maxToolCalls=3` never stopped 50 read calls, a per-agent clause naming a
// worker that was not in the run enforced nothing, and `--resume` dropped the
// budget entirely. This file pins the shipped behaviour:
//
//   - the child's own lane enforces toolCalls (every attempt) and tokens/cost
//     from its usage roll-up, ending BUDGET_EXHAUSTED exit 3 with the limit;
//   - the manager hands each worker its resolved budget through the §3.8
//     allowlisted KUBIC_BUDGET env (asserted across a real process boundary);
//   - maxRuntimeMs is the MANAGER's watchdog: a sleeping child is killed and
//     the run reports limit=wallClock (distinct from --timeout);
//   - a per-agent clause naming an agent not in the run is a usage error;
//   - the budget spec persists in OrchestratorRunState and --resume
//     re-applies it, refusing a differing spec;
//   - a --budget no approvals layer could enforce is refused, never dropped.
//
// Zero network, zero paid tokens: the lane runs on the `faux` provider and
// the process-boundary tests use fixture children. Every scratch dir is
// removed after each test; every env change is unstubbed.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Provenance } from '../../../packages/exec/src/env.js';
import {
  FakeExecutionEnv,
  NodeExecutionEnv,
} from '../../../packages/exec/src/env.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import type {
  OrchestrateCommandDeps,
  OrchestratorRunState,
  ParsedBudgetSpec,
  WorkerSpawnInfo,
} from '../../../packages/host/src/orchestrate-cli.js';
import {
  budgetSpecsEqual,
  parseBudgetSpec,
  parseOrchestratorRunState,
  parseStoredBudgetSpec,
  runOrchestrateCommand,
} from '../../../packages/host/src/orchestrate-cli.js';
import { createOrchestratorApprovalsRun } from '../../../packages/host/src/orchestrator/approvals/worker-asks.js';
import type { MergedHunk } from '../../../packages/host/src/orchestrator/merge/attribution.js';
import { planWorkerRoles } from '../../../packages/host/src/roles/worker-roles.js';
import { mapTerminusToExitCode } from '../../../packages/host/src/run-cli.js';
import {
  createSession,
  openSessionStore,
} from '../../../packages/worker/src/lane/session-store.js';
import { fauxToolUse } from '../../../packages/worker/src/lane/test-harness.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from '../../../packages/worker/src/pi-boundary.js';
import { BudgetExceededError, runHeadlessPrompt } from './headless-run.js';
import { orchestrateDepsWithDefaults } from './orchestrate-run.js';

const PROVENANCE: Provenance = {
  sessionId: 'issue-208',
  agentId: 'manager',
  toolCallId: 'issue-208-budget',
  turnId: 0,
  operation: 'issue_208_budget',
};

// Every scratch dir is removed after each test (worktrees live under the repo
// root, so removing it disposes them too) — nothing accumulates in tmpdir.
const scratchDirs: string[] = [];

function scratchRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  // The solo no-isolation notice is not under test here; the documented
  // opt-out keeps it off the test runner's stderr.
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

function budgetSpec(raw: string): ParsedBudgetSpec {
  const spec = parseBudgetSpec(raw);
  if (spec === undefined) throw new Error(`bad budget spec: ${raw}`);
  return spec;
}

function fauxToolCallModels(calls: number): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const responses = [];
  for (let index = 0; index < calls; index += 1) {
    responses.push(fauxToolUse([fauxToolCall('read', { path: 'a.txt' })]));
  }
  responses.push(fauxAssistantMessage('done'));
  faux.setResponses(responses);
  return models;
}

interface World {
  deps: OrchestrateCommandDeps;
  lines: string[];
  errLines: string[];
  debugLines: string[];
  calls: string[];
  saved: OrchestratorRunState[];
  /** The resolved budget each spawn's gate saw, as the run handed it down. */
  spawnBudgets: (unknown | undefined)[];
  approvalsDir: string;
  /** The approvals layer the CLI constructed (available after the first spawn). */
  readonly approvals: {
    budget: () => unknown;
    budgetFor: (agentId: string) => unknown;
  };
}

interface WorldOptions {
  overrides?: Partial<OrchestrateCommandDeps>;
  /** Absent means the CLI gets no approvals layer at all. */
  withoutApprovals?: boolean;
  runWorker?: OrchestrateCommandDeps['runWorker'];
}

function makeWorld(options: WorldOptions = {}): World {
  const root = scratchRoot('kubic-208-');
  const approvalsDir = join(root, 'approvals');
  const lines: string[] = [];
  const errLines: string[] = [];
  const debugLines: string[] = [];
  const calls: string[] = [];
  const saved: OrchestratorRunState[] = [];
  const spawnBudgets: (unknown | undefined)[] = [];
  let built: ReturnType<typeof createOrchestratorApprovalsRun> | undefined;
  const deps: OrchestrateCommandDeps = {
    out: (line) => {
      lines.push(line);
    },
    err: (line) => {
      errLines.push(line);
    },
    debug: (line) => {
      debugLines.push(line);
    },
    now: () => 1700000000000,
    isGitRepo: () => true,
    ensureWorktree: (agentId: string) => ({
      path: `/repo/.kubic/wt/${agentId}`,
      branch: `kubic/${agentId}`,
    }),
    createWorkerSession: (input) => ({ sessionId: input.workerSessionId }),
    runWorker: async (
      agentId: string,
      _worktree,
      _prompt: string,
      _info?: WorkerSpawnInfo,
    ): Promise<MergedHunk[]> => {
      calls.push(agentId);
      spawnBudgets.push(built?.budgetFor(agentId));
      return [{ path: `${agentId}.txt`, hunk: `@@ -0,0 +1 @@ +${agentId}` }];
    },
    mergeBranch: () => undefined,
    reapWorker: () => undefined,
    requestApproval: () => true,
    loadState: () => undefined,
    saveState: (state) => {
      saved.push(structuredClone(state));
    },
    ...(options.withoutApprovals === true
      ? {}
      : {
          approvals: (cliOptions: {
            sessionId: string;
            maxPendingMs: number;
            budget?: unknown;
            budgetForAgent?: (agentId: string) => unknown;
          }) => {
            built = createOrchestratorApprovalsRun({
              dir: approvalsDir,
              sessionId: cliOptions.sessionId,
              maxPendingMs: cliOptions.maxPendingMs,
              pollMs: 5,
              ...(cliOptions.budget === undefined
                ? {}
                : { budget: cliOptions.budget }),
              ...(cliOptions.budgetForAgent === undefined
                ? {}
                : { budgetForAgent: cliOptions.budgetForAgent }),
              debug: (line) => debugLines.push(line),
            });
            return built;
          },
        }),
    ...(options.runWorker === undefined
      ? {}
      : { runWorker: options.runWorker }),
    ...options.overrides,
  };
  return {
    deps,
    lines,
    errLines,
    debugLines,
    calls,
    saved,
    spawnBudgets,
    approvalsDir,
    get approvals(): World['approvals'] {
      if (built === undefined) {
        throw new Error('the CLI never constructed the approvals layer');
      }
      return {
        budget: () => built?.budget(),
        budgetFor: (agentId: string) => built?.budgetFor(agentId),
      };
    },
  };
}

async function gitIn(
  cwd: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env = new NodeExecutionEnv(cwd);
  return env.shell.spawn('git', args, { provenance: PROVENANCE }).wait();
}

async function initRepo(): Promise<string> {
  const root = scratchRoot('kubic-208-prod-');
  await gitIn(root, ['init', '-b', 'main']);
  await gitIn(root, ['config', 'user.email', 'issue208@kubic.dev']);
  await gitIn(root, ['config', 'user.name', 'kubic issue 208']);
  await gitIn(root, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  await gitIn(root, ['add', 'base.txt']);
  await gitIn(root, ['commit', '-m', 'base']);
  return root;
}

describe('budget spec validation helpers (issue #208)', () => {
  it('parseBudgetSpec refuses a maxRuntimeMs above the setTimeout ceiling', () => {
    expect(parseBudgetSpec('maxRuntimeMs=2147483648')).toBeUndefined();
    expect(parseBudgetSpec('maxRuntimeMs=2147483647')).toEqual({
      byAgent: {},
      shared: { maxRuntimeMs: 2_147_483_647 },
    });
  });

  it('budgetSpecsEqual compares dims and agent clauses order-insensitively', () => {
    const a = {
      shared: { maxTokens: 1, maxCostUsd: 2 },
      byAgent: { 'worker-1': { maxToolCalls: 3 } },
    };
    const b = {
      byAgent: { 'worker-1': { maxToolCalls: 3 } },
      shared: { maxCostUsd: 2, maxTokens: 1 },
    };
    expect(budgetSpecsEqual(a, b)).toBe(true);
    // A missing/extra dimension or agent differs, in either direction.
    expect(budgetSpecsEqual(a, { ...b, shared: { maxTokens: 1 } })).toBe(false);
    expect(budgetSpecsEqual(a, { shared: a.shared, byAgent: {} })).toBe(false);
    expect(
      budgetSpecsEqual(a, {
        shared: a.shared,
        byAgent: { 'worker-1': { maxToolCalls: 4 } },
      }),
    ).toBe(false);
    expect(
      budgetSpecsEqual(a, {
        shared: a.shared,
        byAgent: { 'worker-2': { maxToolCalls: 3 } },
      }),
    ).toBe(false);
  });
});

describe('aggregate task budget clause total: (issue #207)', () => {
  it('parseBudgetSpec routes a total: clause to the aggregate spec, never to an agent', () => {
    expect(parseBudgetSpec('total:maxCostUsd=5')).toEqual({
      total: { maxCostUsd: 5 },
      byAgent: {},
    });
    expect(
      parseBudgetSpec('maxTokens=10;total:maxCostUsd=5;w1:maxTokens=3'),
    ).toEqual({
      shared: { maxTokens: 10 },
      total: { maxCostUsd: 5 },
      byAgent: { w1: { maxTokens: 3 } },
    });
    // A repeated total: clause merges, like the shared spec.
    expect(
      parseBudgetSpec('total:maxTokens=5;total:maxCostUsd=1'),
    ).toMatchObject({ total: { maxTokens: 5, maxCostUsd: 1 } });
  });

  it('parseBudgetSpec refuses a malformed total: clause', () => {
    expect(parseBudgetSpec('total:bogus=1')).toBeUndefined();
    expect(parseBudgetSpec('total:')).toBeUndefined();
    expect(parseBudgetSpec('total:maxCostUsd=0')).toBeUndefined();
  });

  it('parseStoredBudgetSpec round-trips total: and refuses malformed ones', () => {
    const stored = {
      shared: { maxTokens: 10 },
      total: { maxCostUsd: 5 },
      byAgent: { w1: { maxTokens: 3 } },
    };
    expect(parseStoredBudgetSpec(stored)).toEqual(stored);
    expect(
      parseStoredBudgetSpec({ ...stored, total: { bogus: 1 } }),
    ).toBeUndefined();
    expect(
      parseStoredBudgetSpec({ ...stored, total: { maxCostUsd: -2 } }),
    ).toBeUndefined();
  });

  it('budgetSpecsEqual compares the aggregate clause', () => {
    const a = {
      total: { maxCostUsd: 5 },
      byAgent: {},
    };
    expect(budgetSpecsEqual(a, { total: { maxCostUsd: 5 }, byAgent: {} })).toBe(
      true,
    );
    expect(budgetSpecsEqual(a, { total: { maxCostUsd: 6 }, byAgent: {} })).toBe(
      false,
    );
    expect(budgetSpecsEqual(a, { byAgent: {} })).toBe(false);
  });

  it('a total: clause is not mistaken for an agent the run never named', async () => {
    const world = makeWorld();
    const code = await runOrchestrateCommand(
      {
        prompt: 'demo',
        agents: ['a', 'b'],
        session: 'sess-207-total',
        yes: true,
        budget: parseBudgetSpec('total:maxCostUsd=5'),
      },
      world.deps,
    );
    // Not exit 2 (unknown agent): `total` names the aggregate gate.
    expect(code).toBe(0);
    expect(world.calls).toEqual(['a', 'b']);
  });
});

describe('budget spec parsing and stored-spec validation (issue #208)', () => {
  const base = (): OrchestratorRunState => ({
    version: 1,
    sessionId: 'orch-208',
    prompt: 'do the work',
    agents: ['worker-1'],
    merged: [],
    pending: ['worker-1'],
    stopped: false,
    records: [],
  });

  it('parseBudgetSpec bounds only maxRuntimeMs at the setTimeout ceiling', () => {
    expect(parseBudgetSpec('maxRuntimeMs=5')).toEqual({
      byAgent: {},
      shared: { maxRuntimeMs: 5 },
    });
    // The ceiling belongs to the wall-clock dimension alone: a large token
    // budget is a valid (if unwise) configuration.
    expect(parseBudgetSpec('maxTokens=2147483648')).toEqual({
      byAgent: {},
      shared: { maxTokens: 2_147_483_648 },
    });
    // Non-positive and non-numeric values are refused at parse time...
    expect(parseBudgetSpec('maxToolCalls=0')).toBeUndefined();
    expect(parseBudgetSpec('maxToolCalls=-1')).toBeUndefined();
    expect(parseBudgetSpec('maxCostUsd=abc')).toBeUndefined();
    // ...including inside a per-agent clause.
    expect(parseBudgetSpec('worker-1:maxRuntimeMs=2147483648')).toBeUndefined();
    expect(parseBudgetSpec('worker-1:maxRuntimeMs=2147483647')).toEqual({
      byAgent: { 'worker-1': { maxRuntimeMs: 2_147_483_647 } },
    });
  });

  it('parseOrchestratorRunState refuses every malformed stored budget shape', () => {
    const budgets: unknown[] = [
      null,
      [],
      42,
      'x',
      { shared: null, byAgent: {} },
      { shared: 1, byAgent: {} },
      { shared: { maxRuntimeMs: 2_147_483_648 }, byAgent: {} },
      { shared: {}, byAgent: {} },
      { shared: { maxTokens: 1 }, byAgent: [] },
      { shared: { maxTokens: 1 }, byAgent: 'x' },
      { byAgent: { 'worker-1': null } },
      { byAgent: { 'worker-1': {} } },
      { byAgent: { 'worker-1': { nope: 1 } } },
      { byAgent: { 'worker-1': { maxTokens: true } } },
      { shared: { maxTokens: 1 }, byAgent: {}, extra: true },
    ];
    for (const budget of budgets) {
      expect(
        parseOrchestratorRunState({ ...base(), budget }, 'orch-208'),
        JSON.stringify(budget),
      ).toBeUndefined();
    }
    // A byAgent-only spec is valid and round-trips.
    expect(
      parseOrchestratorRunState(
        { ...base(), budget: { byAgent: { 'worker-1': { maxTokens: 1 } } } },
        'orch-208',
      )?.budget,
    ).toEqual({ byAgent: { 'worker-1': { maxTokens: 1 } } });
  });

  it('budgetSpecsEqual compares key sets and pairings, not insertion order', () => {
    expect(budgetSpecsEqual({ byAgent: {} }, { byAgent: {} })).toBe(true);
    // One side carrying a shared spec differs from one that does not.
    expect(
      budgetSpecsEqual(
        { byAgent: {} },
        { shared: { maxTokens: 1 }, byAgent: {} },
      ),
    ).toBe(false);
    // Different key-set sizes differ.
    expect(
      budgetSpecsEqual({ byAgent: { a: { maxTokens: 1 } } }, { byAgent: {} }),
    ).toBe(false);
    // Insertion order is irrelevant; the dims still match their agent.
    expect(
      budgetSpecsEqual(
        { byAgent: { a: { maxTokens: 1 }, b: { maxCostUsd: 2 } } },
        { byAgent: { b: { maxCostUsd: 2 }, a: { maxTokens: 1 } } },
      ),
    ).toBe(true);
    // Cross-paired values are NOT equal even though the key sets match.
    expect(
      budgetSpecsEqual(
        { byAgent: { a: { maxTokens: 1 }, b: { maxCostUsd: 2 } } },
        { byAgent: { a: { maxCostUsd: 2 }, b: { maxTokens: 1 } } },
      ),
    ).toBe(false);
    // A dim value change in either direction differs.
    expect(
      budgetSpecsEqual(
        { shared: { maxTokens: 1 }, byAgent: {} },
        { shared: { maxTokens: 2 }, byAgent: {} },
      ),
    ).toBe(false);
  });

  it('__proto__ is a real agent key, never a prototype write (issue #208 review)', () => {
    // `__proto__` satisfies the agent-id charset, but on a plain {} accumulator
    // an assignment to it sets the PROTOTYPE instead of an own key: the clause
    // would vanish from Object.keys and from the JSON state. The accumulators
    // are null-prototype, so the clause survives as data.
    const spec = parseBudgetSpec('__proto__:maxToolCalls=5');
    if (spec === undefined) throw new Error('spec must parse');
    expect(Object.hasOwn(spec.byAgent, '__proto__')).toBe(true);
    expect(Object.keys(spec.byAgent)).toEqual(['__proto__']);
    // The accumulator is null-prototype: the clause is data, and no
    // prototype anywhere was replaced by the parsed dims.
    expect(Object.getPrototypeOf(spec.byAgent)).toBeNull();
    expect(
      Object.getOwnPropertyDescriptor(spec.byAgent, '__proto__')?.value,
    ).toEqual({ maxToolCalls: 5 });
    expect(JSON.parse(JSON.stringify(spec)) as unknown).toEqual({
      byAgent: { ['__proto__']: { maxToolCalls: 5 } },
    });
    // No pollution of anything that merely read the parsed map.
    expect(({} as Record<string, unknown>).maxToolCalls).toBeUndefined();

    // The stored-spec path has the same rule: a JSON-parsed `__proto__` key
    // (JSON.parse creates an own property) validates and round-trips.
    const state = parseOrchestratorRunState(
      {
        ...base(),
        agents: ['__proto__'],
        budget: JSON.parse('{"byAgent":{"__proto__":{"maxTokens":1}}}'),
      },
      'orch-208',
    );
    if (state?.budget === undefined) throw new Error('budget must parse');
    expect(Object.hasOwn(state.budget.byAgent, '__proto__')).toBe(true);
    expect(JSON.parse(JSON.stringify(state.budget)) as unknown).toEqual({
      byAgent: { ['__proto__']: { maxTokens: 1 } },
    });
  });
});

describe('child budget enforcement ends the run BUDGET_EXHAUSTED (issue #208, AC1/AC2)', () => {
  it('AC1: maxToolCalls=2 with 3 non-dangerous tool calls ends BUDGET_EXHAUSTED (limit=toolCalls); orchestrate exits 3', async () => {
    const sessionsRoot = scratchRoot('kubic-208-sessions-');
    const store = openSessionStore(
      sessionsRoot,
      createNodeFileBridge(sessionsRoot),
    );
    const models = fauxToolCallModels(3);
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('a.txt', 'budget fixture\n');
    let childResult: string | undefined;
    let childMessage: string | undefined;
    const world = makeWorld({
      runWorker: async (agentId, _worktree, _prompt, info) => {
        // The resolved budget, exactly as the prod spawn env hands it down:
        // the manager's gate for THIS worker, read from the layer the CLI
        // built. No budget configured for the agent would mean no limit.
        const resolved = world.approvals.budgetFor(agentId);
        if (resolved !== undefined) {
          vi.stubEnv('KUBIC_BUDGET', JSON.stringify(resolved));
        }
        const result = await runHeadlessPrompt(
          'work',
          { sessionId: info?.workerSessionId },
          { sessionsRoot, models, env },
        );
        childResult = result.terminus;
        childMessage = result.error?.message;
        if (result.terminus !== 'completed') {
          const error = new Error(
            result.error?.message ?? result.terminus,
          ) as Error & { approval?: { code: string; exitCode: number } };
          error.approval =
            result.terminus === 'budget_exhausted'
              ? { code: 'BUDGET_EXHAUSTED', exitCode: 3 }
              : {
                  code: result.terminus,
                  exitCode: mapTerminusToExitCode(result.terminus),
                };
          throw error;
        }
        return [{ path: `${agentId}.txt`, hunk: 'x' }];
      },
      overrides: {
        createWorkerSession: async (input) => {
          const session = await createSession(
            store,
            { cwd: '/fake', id: input.workerSessionId },
            BACKGROUND_CONTEXT,
          );
          await session.release(BACKGROUND_CONTEXT);
          return { sessionId: input.workerSessionId };
        },
      },
    });
    const code = await runOrchestrateCommand(
      {
        prompt: 'do the work',
        agents: ['worker-1'],
        session: 'orch-208',
        budget: budgetSpec('maxToolCalls=2'),
      },
      world.deps,
    );

    // The child lane itself ended on the budget: three attempts, the third
    // blocked, with the dimension named.
    expect(childResult).toBe('budget_exhausted');
    expect(childMessage).toContain('BUDGET_EXHAUSTED');
    expect(childMessage).toContain('limit=toolCalls');
    // ...and the orchestration surfaced it as exit 3 with the same limit.
    // The failure message is the stderr diagnostic in text mode.
    expect(code).toBe(3);
    const err = world.errLines.join('\n');
    expect(err).toContain('BUDGET_EXHAUSTED');
    expect(err).toContain('limit=toolCalls');
  }, 60_000);

  it('AC2: a faux usage row over maxTokens ends BUDGET_EXHAUSTED (limit=tokens)', async () => {
    // The faux provider estimates the context tokens, so the very first
    // response already breaches a one-token window. The script keeps the
    // drive alive after that response (a tool call follows), so the usage
    // roll-up — not the drive's natural settlement — is what ends the run.
    const sessionsRoot = scratchRoot('kubic-208-sessions-');
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('a.txt', 'budget fixture\n');
    vi.stubEnv('KUBIC_BUDGET', JSON.stringify({ maxTokens: 1 }));
    const result = await runHeadlessPrompt(
      'work',
      {},
      { sessionsRoot, models: fauxToolCallModels(1), env },
    );
    expect(result.terminus).toBe('budget_exhausted');
    expect(result.error?.message).toContain('BUDGET_EXHAUSTED');
    expect(result.error?.message).toContain('limit=tokens');
  }, 60_000);

  it('AC1b: maxToolCalls counts attempts the policy guards BLOCK, not only executed calls', async () => {
    // Every scripted call is a destructive `rm -rf` the installed policy
    // denies (a headless run has no approval surface). Pi's before_tool
    // chain stops at the FIRST block, so a meter subscribed after the guards
    // would count zero attempts and the run would end approval_denied. The
    // meter must be subscribed before them: the third attempt trips
    // maxToolCalls=2 and the run ends budget_exhausted instead.
    const sessionsRoot = scratchRoot('kubic-208-blocked-');
    const env = new FakeExecutionEnv({});
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const destructive = { command: 'rm -rf scratch' };
    faux.setResponses([
      fauxToolUse([fauxToolCall('bash', destructive)]),
      fauxToolUse([fauxToolCall('bash', destructive)]),
      fauxToolUse([fauxToolCall('bash', destructive)]),
      fauxAssistantMessage('done'),
    ]);
    vi.stubEnv('KUBIC_BUDGET', JSON.stringify({ maxToolCalls: 2 }));
    const result = await runHeadlessPrompt(
      'work',
      {},
      { sessionsRoot, models, env },
    );
    expect(result.terminus).toBe('budget_exhausted');
    expect(result.error?.message).toContain('BUDGET_EXHAUSTED');
    expect(result.error?.message).toContain('limit=toolCalls');
  }, 60_000);

  it('a malformed KUBIC_BUDGET is a usage terminus (exit 2), never a silently dropped limit', async () => {
    const sessionsRoot = scratchRoot('kubic-208-sessions-');
    vi.stubEnv('KUBIC_BUDGET', '{not json');
    const result = await runHeadlessPrompt(
      'work',
      {},
      {
        sessionsRoot,
        models: fauxToolCallModels(0),
        env: new FakeExecutionEnv({}),
      },
    );
    expect(result.terminus).toBe('usage');
    expect(result.error?.message).toMatch(/KUBIC_BUDGET|budget/);
    expect(result.sessionId).toBe('unassigned');
  }, 60_000);

  it('BudgetExceededError names the dimension and the §78 terminus', () => {
    const error = new BudgetExceededError('tokens');
    expect(error.name).toBe('BudgetExceededError');
    expect(error.limit).toBe('tokens');
    expect(error.message).toContain('BUDGET_EXHAUSTED');
    expect(error.message).toContain('limit=tokens');
    expect(error.message).toContain('exit 3');
  });
});

// The child contract shared by the process-boundary tests below: announce
// readiness, record the budget it was handed beside the worktree, then exit
// on its own §78 budget terminus.
function writeBudgetChildFixture(dir: string): string {
  const fixture = join(dir, 'budget-child.mjs');
  writeFileSync(
    fixture,
    `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
process.stdout.write('KUBIC_WORKER_READY ' + (process.env.KUBIC_WORKER_ID ?? '') + String.fromCharCode(10));
writeFileSync(join(process.cwd(), 'budget-seen.json'), process.env.KUBIC_BUDGET ?? 'ABSENT');
process.stdout.write(JSON.stringify({ ok: false, exitCode: 3, sessionId: process.argv[process.argv.indexOf('--session') + 1], status: 'budget_exhausted', error: { kind: 'budget_exhausted', message: 'budget BUDGET_EXHAUSTED (limit=toolCalls): fixture reported the cap' } }) + String.fromCharCode(10));
process.exit(3);
`,
  );
  return fixture;
}

describe('the manager hands each worker its resolved budget (issue #208)', () => {
  it('the child process receives KUBIC_BUDGET through the §3.8 allowlist, and its budget terminus maps to exit 3', async () => {
    const root = await initRepo();
    const scratch = scratchRoot('kubic-208-child-');
    const fixture = writeBudgetChildFixture(scratch);
    const lines: string[] = [];
    const deps = await orchestrateDepsWithDefaults({
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
      debug: () => undefined,
      cwd: root,
      sessionsRoot: scratchRoot('kubic-208-prod-sessions-'),
      workerEntry: { cmd: process.execPath, args: [fixture] },
    });
    const code = await runOrchestrateCommand(
      {
        prompt: 'do the work',
        session: 'orch-208',
        agents: ['worker-1'],
        budget: budgetSpec('maxToolCalls=2'),
      },
      deps,
    );
    expect(code).toBe(3);
    const text = lines.join('\n');
    expect(text).toContain('BUDGET_EXHAUSTED');
    expect(text).toContain('limit=toolCalls');
    // The child really saw the resolved spec, filtered through the allowlist.
    expect(
      JSON.parse(
        readFileSync(
          // Issue #144 (rebased onto the wave): the worktree is scoped by
          // the owning orchestrator session.
          join(
            root,
            '.kubic',
            'wt',
            'orch-208',
            'worker-1',
            'budget-seen.json',
          ),
          'utf8',
        ),
      ),
    ).toEqual({ maxToolCalls: 2 });
  }, 60_000);

  it('an ambient KUBIC_BUDGET never leaks into an unbudgeted child (issue #208 review)', async () => {
    // The manager's own environment must not become a child's budget: with no
    // resolved plan the spawn clears KUBIC_BUDGET, so a stray ambient value
    // (a leftover export, a parent run's env) cannot silently limit a worker
    // the manager did not budget.
    vi.stubEnv('KUBIC_BUDGET', JSON.stringify({ maxToolCalls: 99 }));
    const root = await initRepo();
    const scratch = scratchRoot('kubic-208-ambient-');
    const fixture = writeBudgetChildFixture(scratch);
    const lines: string[] = [];
    const deps = await orchestrateDepsWithDefaults({
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
      debug: () => undefined,
      cwd: root,
      sessionsRoot: scratchRoot('kubic-208-prod-sessions-'),
      workerEntry: { cmd: process.execPath, args: [fixture] },
    });
    const code = await runOrchestrateCommand(
      { prompt: 'do the work', session: 'orch-clear', agents: ['worker-1'] },
      deps,
    );
    // The fixture exits 3 on its own terminus; what matters is its evidence:
    // it was handed an EMPTY budget, never the manager's ambient one.
    expect(code).toBe(3);
    expect(
      readFileSync(
        join(
          root,
          '.kubic',
          'wt',
          'orch-clear',
          'worker-1',
          'budget-seen.json',
        ),
        'utf8',
      ),
    ).toBe('');
  }, 60_000);

  it('AC3: maxRuntimeMs is the MANAGER watchdog — a sleeping child is killed and the run reports limit=wallClock', async () => {
    const root = await initRepo();
    const scratch = scratchRoot('kubic-208-sleep-');
    const fixture = join(scratch, 'sleeping-child.mjs');
    // A worker that becomes ready and then never settles: only the manager's
    // own watchdog can end it. 30s is far beyond the 50ms budget under test.
    writeFileSync(
      fixture,
      `
process.stdout.write('KUBIC_WORKER_READY ' + (process.env.KUBIC_WORKER_ID ?? '') + String.fromCharCode(10));
setTimeout(() => process.exit(0), 30000);
`,
    );
    const lines: string[] = [];
    const deps = await orchestrateDepsWithDefaults({
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
      debug: () => undefined,
      cwd: root,
      sessionsRoot: scratchRoot('kubic-208-prod-sessions-'),
      workerEntry: { cmd: process.execPath, args: [fixture] },
    });
    const started = Date.now();
    const code = await runOrchestrateCommand(
      {
        prompt: 'do the work',
        session: 'orch-208',
        agents: ['worker-1'],
        budget: budgetSpec('maxRuntimeMs=50'),
      },
      deps,
    );
    // Bounded: killed on the watchdog, not after the 30s sleep.
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(code).toBe(3);
    const text = lines.join('\n');
    expect(text).toContain('BUDGET_EXHAUSTED');
    expect(text).toContain('limit=wallClock');
    // Distinct from the child's own --timeout terminus: the watchdog names
    // the wall-clock budget dimension, never a generic timeout.
    expect(text).not.toContain('run timed out after');
  }, 60_000);
});

describe('budget usage errors are refused before anything spawns (issue #208, AC4)', () => {
  it('a per-agent clause naming an agent not in the run exits 2 with a named usage error', async () => {
    const world = makeWorld();
    const code = await runOrchestrateCommand(
      {
        prompt: 'do the work',
        agents: ['a', 'b'],
        session: 'orch-208',
        budget: budgetSpec('worker-1:maxToolCalls=5'),
      },
      world.deps,
    );
    expect(code).toBe(2);
    const err = world.errLines.join('\n');
    expect(err).toContain('--budget');
    expect(err).toContain('worker-1');
    expect(world.calls).toEqual([]);
  });

  it('a per-agent clause naming an agent in the run is accepted', async () => {
    const world = makeWorld();
    const code = await runOrchestrateCommand(
      {
        prompt: 'do the work',
        agents: ['a', 'b'],
        session: 'orch-208',
        budget: budgetSpec('a:maxToolCalls=5'),
      },
      world.deps,
    );
    expect(code).toBe(0);
    expect(world.spawnBudgets).toEqual([{ maxToolCalls: 5 }, undefined]);
  });

  it('refuses --budget when no approvals layer could enforce it', async () => {
    const world = makeWorld({ withoutApprovals: true });
    const code = await runOrchestrateCommand(
      {
        prompt: 'do the work',
        agents: ['worker-1'],
        session: 'orch-208',
        budget: budgetSpec('maxToolCalls=5'),
      },
      world.deps,
    );
    expect(code).toBe(2);
    expect(world.errLines.join('\n')).toContain('--budget');
    expect(world.calls).toEqual([]);
  });
});

describe('the budget spec persists and --resume re-applies it (issue #208, AC5)', () => {
  const baseState = (): OrchestratorRunState => ({
    version: 1,
    sessionId: 'orch-208',
    prompt: 'do the work',
    agents: ['worker-1'],
    merged: [],
    pending: ['worker-1'],
    stopped: false,
    records: [],
  });

  it('parseOrchestratorRunState validates the stored budget', () => {
    const base = baseState();
    const valid = {
      ...base,
      budget: { shared: { maxToolCalls: 2 }, byAgent: {} },
    };
    expect(parseOrchestratorRunState(valid, 'orch-208')?.budget).toEqual({
      shared: { maxToolCalls: 2 },
      byAgent: {},
    });
    // Anything that could reach the budget layer as garbage fails closed —
    // resume reports no_orchestrator_state instead of crashing mid-run.
    for (const budget of [
      { shared: { maxToolCalls: 0 }, byAgent: {} },
      { shared: { nope: 1 }, byAgent: {} },
      { shared: { maxTokens: '5' }, byAgent: {} },
      { shared: {}, byAgent: {} },
      { byAgent: { ghost: { maxTokens: 1 } } },
      { byAgent: { 'bad/id': { maxTokens: 1 } } },
      'not-an-object',
    ]) {
      expect(
        parseOrchestratorRunState({ ...base, budget }, 'orch-208'),
      ).toBeUndefined();
    }
    // The per-agent key must name an agent of the stored run.
    const inRun = {
      ...base,
      budget: { byAgent: { 'worker-1': { maxToolCalls: 1 } } },
    };
    expect(parseOrchestratorRunState(inRun, 'orch-208')?.budget).toEqual({
      byAgent: { 'worker-1': { maxToolCalls: 1 } },
    });
  });

  it('resume applies the stored budget to the spawn gates, with no flag given', async () => {
    const stored = {
      ...baseState(),
      budget: { shared: { maxToolCalls: 2 }, byAgent: {} },
    };
    const world = makeWorld({
      overrides: { loadState: () => structuredClone(stored) },
    });
    const code = await runOrchestrateCommand(
      { resume: true, session: 'orch-208' },
      world.deps,
    );
    expect(code).toBe(0);
    expect(world.spawnBudgets).toEqual([{ maxToolCalls: 2 }]);
    expect(world.approvals.budgetFor('worker-1')).toEqual({
      maxToolCalls: 2,
    });
  });

  it('resume with a DIFFERING --budget is refused (exit 2), never silently mixed', async () => {
    const stored = {
      ...baseState(),
      budget: { shared: { maxToolCalls: 2 }, byAgent: {} },
    };
    const world = makeWorld({
      overrides: { loadState: () => structuredClone(stored) },
    });
    const code = await runOrchestrateCommand(
      {
        resume: true,
        session: 'orch-208',
        budget: budgetSpec('maxToolCalls=5'),
      },
      world.deps,
    );
    expect(code).toBe(2);
    expect(world.errLines.join('\n')).toContain('--budget');
    expect(world.calls).toEqual([]);
  });

  it('an identical --budget on resume is accepted and the stored spec is applied', async () => {
    const stored = {
      ...baseState(),
      budget: { shared: { maxToolCalls: 2 }, byAgent: {} },
    };
    const world = makeWorld({
      overrides: { loadState: () => structuredClone(stored) },
    });
    const code = await runOrchestrateCommand(
      {
        resume: true,
        session: 'orch-208',
        budget: budgetSpec('maxToolCalls=2'),
      },
      world.deps,
    );
    expect(code).toBe(0);
    expect(world.spawnBudgets).toEqual([{ maxToolCalls: 2 }]);
  });

  it('a fresh run persists its budget in the saved state and resume-without-state applies the flag', async () => {
    const world = makeWorld();
    const code = await runOrchestrateCommand(
      {
        prompt: 'do the work',
        agents: ['worker-1'],
        session: 'orch-208',
        budget: budgetSpec('worker-1:maxCostUsd=0.5'),
      },
      world.deps,
    );
    expect(code).toBe(0);
    const last = world.saved[world.saved.length - 1] as OrchestratorRunState;
    expect(last.budget).toEqual({
      byAgent: { 'worker-1': { maxCostUsd: 0.5 } },
    });

    // A resume of a state written before #208 (no budget) applies the flag.
    const world2 = makeWorld({
      overrides: { loadState: () => structuredClone(baseState()) },
    });
    const code2 = await runOrchestrateCommand(
      {
        resume: true,
        session: 'orch-208',
        budget: budgetSpec('maxToolCalls=1'),
      },
      world2.deps,
    );
    expect(code2).toBe(0);
    expect(world2.spawnBudgets).toEqual([{ maxToolCalls: 1 }]);
  });
});

describe('a role document budget caps its spawned worker (issue #198)', () => {
  const WRITER =
    'tools: [read, ls, find, grep, write, edit, bash]\nfilesystem: workspace-write\nshell: true\nnetwork: none\ngit: false\ncredentials: none\n';

  function implementerDoc(budgetLine: string): string {
    return `---\nrole: implementer\n${WRITER}${budgetLine}---\n\n# Implementer\n\n## Prompt\n\nYou are the implementer.\n`;
  }

  function memBridge(files: Record<string, string>) {
    return {
      listDir: (dir: string) =>
        Object.keys(files)
          .filter((path) => path.startsWith(`${dir}/`))
          .filter((path) => !path.slice(dir.length + 1).includes('/'))
          .map((path) => ({
            name: path.slice(dir.length + 1),
            path,
            isDirectory: false,
            isSymbolicLink: false,
            size: 0,
            mtimeMs: 0,
          })),
      readTextFile: (path: string) => {
        const text = files[path];
        if (text === undefined) throw new Error(`ENOENT: ${path}`);
        return text;
      },
    };
  }

  // The delegation path reads `.kubic/roles/*.md` through the exec
  // FileBridge; here the bridge is in-memory and the project is trusted,
  // so the document budget is what the test varies — never the fs.
  function docRoles(files: Record<string, string>) {
    return {
      loadWorkerRoles: (
        agents: readonly string[],
        binding?: { roles: Record<string, string> },
      ) =>
        planWorkerRoles({
          bridge: memBridge(files),
          cwd: '/repo',
          trusted: true,
          agents,
          ...(binding === undefined || Object.keys(binding.roles).length === 0
            ? {}
            : { roles: binding.roles }),
        }),
    };
  }

  const BUDGETED = {
    '/repo/.kubic/roles/implementer.md': '',
  };
  BUDGETED['/repo/.kubic/roles/implementer.md'] = implementerDoc(
    'budget = { maxToolCalls = 2 }\n',
  );
  const UNBUDGETED = {
    '/repo/.kubic/roles/implementer.md': implementerDoc(''),
  };

  it('a document {maxToolCalls=2} ends the worker BUDGET_EXHAUSTED with no --budget flag', async () => {
    const sessionsRoot = scratchRoot('kubic-198-sessions-');
    const store = openSessionStore(
      sessionsRoot,
      createNodeFileBridge(sessionsRoot),
    );
    const models = fauxToolCallModels(3);
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('a.txt', 'budget fixture\n');
    let childResult: string | undefined;
    const world = makeWorld({
      overrides: {
        ...docRoles(BUDGETED),
        createWorkerSession: async (input) => {
          const session = await createSession(
            store,
            { cwd: '/fake', id: input.workerSessionId },
            BACKGROUND_CONTEXT,
          );
          await session.release(BACKGROUND_CONTEXT);
          return { sessionId: input.workerSessionId };
        },
      },
      runWorker: async (agentId, _worktree, _prompt, info) => {
        // The document budget is the ONLY spec in force: the CLI passed
        // none, so the approvals layer resolved the role's own dims.
        expect(world.approvals.budgetFor(agentId)).toEqual({
          maxToolCalls: 2,
        });
        const resolved = world.approvals.budgetFor(agentId);
        if (resolved !== undefined) {
          vi.stubEnv('KUBIC_BUDGET', JSON.stringify(resolved));
        }
        const result = await runHeadlessPrompt(
          'work',
          { sessionId: info?.workerSessionId },
          { sessionsRoot, models, env },
        );
        childResult = result.terminus;
        if (result.terminus !== 'completed') {
          const error = new Error(
            result.error?.message ?? result.terminus,
          ) as Error & { approval?: { code: string; exitCode: number } };
          error.approval =
            result.terminus === 'budget_exhausted'
              ? { code: 'BUDGET_EXHAUSTED', exitCode: 3 }
              : {
                  code: result.terminus,
                  exitCode: mapTerminusToExitCode(result.terminus),
                };
          throw error;
        }
        return [{ path: `${agentId}.txt`, hunk: 'x' }];
      },
    });
    const code = await runOrchestrateCommand(
      {
        prompt: 'do the work',
        agents: ['worker-1:implementer'],
        session: 'orch-198',
      },
      world.deps,
    );
    // Three attempts against a document maxToolCalls=2: the third is
    // blocked, the child ends budget_exhausted, the run exits 3.
    expect(childResult).toBe('budget_exhausted');
    expect(code).toBe(3);
    expect(world.errLines.join('\n')).toContain('limit=toolCalls');
  }, 60_000);

  it('CLI --budget outranks the document budget; absent everywhere means unbounded', async () => {
    const cliWins = makeWorld({ overrides: { ...docRoles(BUDGETED) } });
    const cliCode = await runOrchestrateCommand(
      {
        prompt: 'do the work',
        agents: ['worker-1:implementer'],
        session: 'orch-198-cli',
        budget: budgetSpec('maxToolCalls=7'),
      },
      cliWins.deps,
    );
    expect(cliCode).toBe(0);
    expect(cliWins.spawnBudgets).toEqual([{ maxToolCalls: 7 }]);

    const unbounded = makeWorld({
      overrides: { ...docRoles(UNBUDGETED) },
    });
    const unboundedCode = await runOrchestrateCommand(
      {
        prompt: 'do the work',
        agents: ['worker-1:implementer'],
        session: 'orch-198-none',
      },
      unbounded.deps,
    );
    expect(unboundedCode).toBe(0);
    expect(unbounded.spawnBudgets).toEqual([undefined]);
  }, 60_000);
});
