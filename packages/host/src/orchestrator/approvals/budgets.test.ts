// Opt-in orchestrator budgets (issue #48; §71 enforcement table).
// RED first: no defaults, burn-down per dim, before_tool gate at
// maxToolCalls=5→6th as budget_exhausted (exit 3, never failure),
// self-raise refused, trajectory event emitted.
import { describe, expect, it } from 'vitest';
import { MAX_RUN_TIMEOUT_MS, RUN_EXIT_BUDGET } from '../../run-cli.js';
import {
  applyBudgetRaise,
  BUDGET_EXHAUSTED,
  type BudgetGate,
  type BudgetRaiseResult,
  type BudgetTermination,
  type BudgetUsage,
  buildBudgetTrajectoryEvent,
  checkBudgetExhaustion,
  childBudgetOf,
  createBudgetGate,
  createBurnDown,
  createRunBudgetEnforcer,
  createRunBudgetMeter,
  mintUserBudgetApproval,
  OrchestratorBudgetError,
  parseWorkerBudgetEnv,
  recordToolCall,
  refuseSelfRaise,
  usageSpendOf,
  validateOrchestratorBudget,
} from './budgets.js';

describe('orchestrator budgets (issue #48)', () => {
  it('is opt-in: empty budget validates with no smuggled defaults', () => {
    expect(validateOrchestratorBudget({})).toEqual({});
  });

  it('refuses non-positive limits fail-closed', () => {
    expect(() => validateOrchestratorBudget({ maxToolCalls: 0 })).toThrow(
      /maxToolCalls/,
    );
    expect(() => validateOrchestratorBudget({ maxTokens: -5 })).toThrow(
      /maxTokens/,
    );
    expect(() =>
      validateOrchestratorBudget({
        retryBudget: { maxAttempts: 0, maxCostUsd: 1 },
      }),
    ).toThrow(/maxAttempts/);
  });

  it('blocks the 6th tool call via before_tool as budget_exhausted', () => {
    const budget = validateOrchestratorBudget({ maxToolCalls: 5 });
    const gate = createBudgetGate(budget);
    for (let i = 1; i <= 5; i += 1) {
      const verdict = gate({ toolCallId: `c${i}`, toolName: 'bash' });
      expect(verdict).toBeUndefined();
      recordToolCall(gate, { tokens: 0, costUsd: 0 });
    }
    const blocked = gate({ toolCallId: 'c6', toolName: 'bash' });
    expect(blocked?.block.reason).toMatch(/budget_exhausted/);
    expect(blocked?.block.reason).toMatch(/toolCalls/);
    expect(blocked?.block.terminate).toBe(false);
  });

  it('exhaustion is distinct from failure and maps to exit 3', () => {
    expect(BUDGET_EXHAUSTED).toBe('BUDGET_EXHAUSTED');
    expect(RUN_EXIT_BUDGET).toBe(3);
    const budget = validateOrchestratorBudget({ maxTokens: 10 });
    const usage = {
      tokens: 9,
      costUsd: 0,
      runtimeMs: 0,
      toolCalls: 0,
      retries: 0,
    };
    // One token under the limit is still inside the budget.
    expect(checkBudgetExhaustion(budget, usage)).toBeUndefined();
    const hit = checkBudgetExhaustion(budget, { ...usage, tokens: 10 });
    expect(hit).toEqual({ status: 'budget_exhausted', limit: 'tokens' });
  });

  it('refuses worker self-raise of its own budget', () => {
    const current = validateOrchestratorBudget({ maxToolCalls: 5 });
    const refusal = refuseSelfRaise({
      caller: 'agent-1',
      owner: 'agent-1',
      current,
      proposed: { maxToolCalls: 50 },
    });
    expect(refusal.refused).toBe(true);
    expect(refusal.reason).toMatch(/self-raise/i);
  });

  it('burn-down reports remaining per dim + trajectory event', () => {
    const budget = validateOrchestratorBudget({
      maxTokens: 100,
      maxToolCalls: 5,
    });
    // A fresh burn-down starts at zero spend on the injected clock.
    expect(createBurnDown(budget, () => 1234)).toEqual({
      tokens: 0,
      costUsd: 0,
      runtimeMs: 0,
      toolCalls: 0,
      retries: 0,
      startedAt: 1234,
    });
    const event = buildBudgetTrajectoryEvent('agent-1', budget, {
      tokens: 30,
      costUsd: 0,
      runtimeMs: 0,
      toolCalls: 2,
      retries: 0,
    });
    expect(event.type).toBe('budget');
    expect(JSON.stringify(event)).toContain('agent-1');
    expect(event.remaining.maxTokens).toBe(70);
    expect(event.remaining.maxToolCalls).toBe(3);
    // Only configured dims are reported, and nothing is exhausted yet.
    expect(Object.keys(event.remaining).sort()).toEqual([
      'maxTokens',
      'maxToolCalls',
    ]);
    expect(event.spent.tokens).toBe(30);
    expect(event.exhausted).toBeUndefined();
  });
});

// Child-side enforcement (issue #208, §71). The manager hands each worker its
// resolved budget through KUBIC_BUDGET; the child's own lane runs under the
// meter, so maxToolCalls counts EVERY tool attempt (not only brokered asks)
// and tokens/cost come from the child's usage roll-up. wallClock is the
// manager's watchdog and never travels to the child.
describe('child run budget enforcement (issue #208)', () => {
  it('refuses a maxRuntimeMs above the 32-bit setTimeout ceiling', () => {
    // Above 2^31-1 setTimeout clamps to 1ms, so an accepted bound would fire
    // the watchdog almost immediately and misreport wallClock.
    expect(() =>
      validateOrchestratorBudget({ maxRuntimeMs: MAX_RUN_TIMEOUT_MS + 1 }),
    ).toThrow(/maxRuntimeMs/);
    expect(
      validateOrchestratorBudget({ maxRuntimeMs: MAX_RUN_TIMEOUT_MS }),
    ).toEqual({ maxRuntimeMs: MAX_RUN_TIMEOUT_MS });
  });

  it('meter admits exactly maxToolCalls attempts and blocks the next', () => {
    const meter = createRunBudgetMeter({ maxToolCalls: 2 });
    expect(meter.nextToolCall()).toBeUndefined();
    expect(meter.nextToolCall()).toBeUndefined();
    // The third attempt is refused and the meter names the dimension.
    expect(meter.nextToolCall()).toEqual({
      status: 'budget_exhausted',
      limit: 'toolCalls',
    });
    // Refused attempts are not counted as spend (the cap is a cap).
    expect(meter.usage().toolCalls).toBe(2);
  });

  it('meter accumulates fixture usage rows and names tokens/cost', () => {
    const tokens = createRunBudgetMeter({ maxTokens: 10 });
    expect(tokens.recordUsage({ tokens: 4 })).toBeUndefined();
    expect(tokens.recordUsage({ tokens: 6 })).toEqual({
      status: 'budget_exhausted',
      limit: 'tokens',
    });
    const cost = createRunBudgetMeter({ maxCostUsd: 0.05 });
    expect(cost.recordUsage({ costUsd: 0.04 })).toBeUndefined();
    expect(cost.recordUsage({ costUsd: 0.01 })).toEqual({
      status: 'budget_exhausted',
      limit: 'cost',
    });
  });

  it('meter enforces nothing when no budget is configured', () => {
    const meter = createRunBudgetMeter({});
    for (let i = 0; i < 50; i += 1) {
      expect(meter.nextToolCall()).toBeUndefined();
      expect(meter.recordUsage({ tokens: 1000, costUsd: 100 })).toBeUndefined();
    }
    expect(meter.usage().toolCalls).toBe(50);
  });

  it('usage snapshot is a copy: mutating it cannot reset burn-down', () => {
    const meter = createRunBudgetMeter({ maxToolCalls: 1 });
    const snapshot = meter.usage();
    snapshot.toolCalls = 99;
    snapshot.tokens = 99;
    expect(meter.usage().toolCalls).toBe(0);
    expect(meter.nextToolCall()).toBeUndefined();
    expect(meter.nextToolCall()).toEqual({
      status: 'budget_exhausted',
      limit: 'toolCalls',
    });
  });

  it('usageSpendOf reads a fixture usage row: tokens=input+output, cost=cost.total', () => {
    // A real Usage carries more fields (cacheRead/cacheWrite/reasoning); the
    // meter only counts input+output so a cache-heavy turn is not billed
    // twice against the window.
    const row = {
      usage: {
        input: 5,
        output: 2,
        cacheRead: 100,
        cacheWrite: 100,
        cost: { total: 1.25 },
      },
    };
    expect(usageSpendOf(row)).toEqual({ tokens: 7, costUsd: 1.25 });
  });

  it('childBudgetOf strips the manager-owned wall clock and keeps the rest', () => {
    expect(
      childBudgetOf({
        maxTokens: 1,
        maxCostUsd: 2,
        maxRuntimeMs: 3,
        maxToolCalls: 4,
      }),
    ).toEqual({ maxTokens: 1, maxCostUsd: 2, maxToolCalls: 4 });
  });

  it('parseWorkerBudgetEnv reads KUBIC_BUDGET and refuses malformed input', () => {
    expect(parseWorkerBudgetEnv(undefined)).toBeUndefined();
    expect(parseWorkerBudgetEnv('   ')).toBeUndefined();
    expect(parseWorkerBudgetEnv('{"maxToolCalls":2}')).toEqual({
      maxToolCalls: 2,
    });
    expect(() => parseWorkerBudgetEnv('{oops')).toThrow(
      OrchestratorBudgetError,
    );
    expect(() => parseWorkerBudgetEnv('{"maxToolCalls":0}')).toThrow(
      /maxToolCalls/,
    );
  });

  // The env is user-facing (every `kubic run` reads it), so a typo must never
  // be a silently dropped limit and every refusal names the variable.
  it('parseWorkerBudgetEnv refuses an unknown key and names KUBIC_BUDGET in every refusal', () => {
    expect(() => parseWorkerBudgetEnv('{"maxToolcalls":5}')).toThrow(
      'KUBIC_BUDGET: unknown budget key "maxToolcalls" (known: maxTokens, maxCostUsd, maxRuntimeMs, maxToolCalls, retryBudget)',
    );
    expect(() =>
      parseWorkerBudgetEnv('{"maxToolCalls":5,"bogus":1,"other":2}'),
    ).toThrow(/unknown budget key "bogus"/);
    for (const raw of ['{"maxTokens":-1}', '[]', '"x"', '{"maxToolCalls":0}']) {
      expect(() => parseWorkerBudgetEnv(raw)).toThrow(/^KUBIC_BUDGET: /);
    }
    expect(() => parseWorkerBudgetEnv('{oops')).toThrow(/^worker budget env/);
    // The valid shapes are untouched, including the retry sub-object.
    expect(
      parseWorkerBudgetEnv(
        '{"maxTokens":10,"retryBudget":{"maxAttempts":2,"maxCostUsd":1}}',
      ),
    ).toEqual({
      maxTokens: 10,
      retryBudget: { maxAttempts: 2, maxCostUsd: 1 },
    });
  });

  it('createRunBudgetEnforcer counts every tool attempt and stops at the cap', () => {
    // The real BEFORE_TOOL semantics: the cap-th attempt runs and the next
    // is blocked with the named limit — the wiring, not just the meter.
    const breaches: BudgetTermination[] = [];
    const enforcer = createRunBudgetEnforcer({ maxToolCalls: 2 }, (t) =>
      breaches.push(t),
    );
    expect(enforcer.onToolAttempt()).toBeUndefined();
    expect(enforcer.onToolAttempt()).toBeUndefined();
    const blocked = enforcer.onToolAttempt();
    expect(blocked?.block.reason).toContain(BUDGET_EXHAUSTED);
    expect(blocked?.block.reason).toContain('limit=toolCalls');
    expect(blocked?.block.terminate).toBe(false);
    // The breach is reported exactly once — a fourth attempt must not repeat it.
    expect(breaches).toEqual([
      { status: 'budget_exhausted', limit: 'toolCalls' },
    ]);
    expect(enforcer.onToolAttempt()).toBeDefined();
    expect(breaches).toHaveLength(1);
  });

  it('createRunBudgetEnforcer breaches on a fixture usage row', () => {
    const breaches: BudgetTermination[] = [];
    const enforcer = createRunBudgetEnforcer({ maxCostUsd: 1 }, (t) =>
      breaches.push(t),
    );
    enforcer.onUsage({
      row: {
        usage: {
          input: 100,
          output: 100,
          cost: { total: 2.5 },
        },
      },
    });
    expect(breaches).toEqual([{ status: 'budget_exhausted', limit: 'cost' }]);
    // A later attempt is still blocked by the exhausted meter.
    expect(enforcer.onToolAttempt()?.block.reason).toContain('limit=cost');
  });
});

// Branch coverage for the §71 budget surface (issue #208): the child-side
// enforcement additions pushed this file into the mutation gate's scope, and
// the validation/raise/trajectory branches below were the survivors. Each
// assertion pins observable behaviour, never a line count.
describe('budget validation, raise and trajectory branches (issue #208)', () => {
  const ZERO: BudgetUsage = {
    tokens: 0,
    costUsd: 0,
    runtimeMs: 0,
    toolCalls: 0,
    retries: 0,
  };

  it('refuses non-object budgets and names its own error class', () => {
    for (const bad of [null, 'x', 5, true, []]) {
      expect(() => validateOrchestratorBudget(bad)).toThrow(
        /must be an object/,
      );
    }
    try {
      validateOrchestratorBudget({ maxTokens: Number.POSITIVE_INFINITY });
      expect.unreachable('an infinite budget must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(OrchestratorBudgetError);
      expect((error as Error).name).toBe('OrchestratorBudgetError');
      expect((error as Error).message).toMatch(/maxTokens/);
    }
  });

  it('refuses non-finite and non-positive values per dimension', () => {
    const cases: ReadonlyArray<readonly [string, number]> = [
      ['maxTokens', Number.NaN],
      ['maxCostUsd', -1],
      ['maxRuntimeMs', 0],
      ['maxToolCalls', Number.POSITIVE_INFINITY],
    ];
    for (const [name, value] of cases) {
      expect(() => validateOrchestratorBudget({ [name]: value })).toThrow(
        new RegExp(name),
      );
    }
  });

  it('validates the retry budget shape and keeps a valid one', () => {
    expect(() => validateOrchestratorBudget({ retryBudget: null })).toThrow(
      /retryBudget must be an object/,
    );
    expect(() =>
      validateOrchestratorBudget({
        retryBudget: { maxAttempts: 2, maxCostUsd: 0 },
      }),
    ).toThrow(/maxCostUsd/);
    expect(() =>
      validateOrchestratorBudget({
        retryBudget: { maxAttempts: 0, maxCostUsd: 1 },
      }),
    ).toThrow(/maxAttempts/);
    expect(
      validateOrchestratorBudget({
        retryBudget: { maxAttempts: 2, maxCostUsd: 1.5 },
      }),
    ).toEqual({ retryBudget: { maxAttempts: 2, maxCostUsd: 1.5 } });
    expect(
      validateOrchestratorBudget({
        maxTokens: 5,
        maxCostUsd: 0.5,
        maxRuntimeMs: 1_000,
        maxToolCalls: 3,
      }),
    ).toEqual({
      maxTokens: 5,
      maxCostUsd: 0.5,
      maxRuntimeMs: 1_000,
      maxToolCalls: 3,
    });
  });

  it('checkBudgetExhaustion walks every §71 dimension', () => {
    expect(
      checkBudgetExhaustion({ maxRuntimeMs: 5 }, { ...ZERO, runtimeMs: 4 }),
    ).toBeUndefined();
    expect(
      checkBudgetExhaustion({ maxRuntimeMs: 5 }, { ...ZERO, runtimeMs: 5 }),
    ).toEqual({ status: 'budget_exhausted', limit: 'wallClock' });
    expect(
      checkBudgetExhaustion({ maxToolCalls: 2 }, { ...ZERO, toolCalls: 1 }),
    ).toBeUndefined();
    expect(
      checkBudgetExhaustion({ maxToolCalls: 2 }, { ...ZERO, toolCalls: 2 }),
    ).toEqual({ status: 'budget_exhausted', limit: 'toolCalls' });
    const retry = { retryBudget: { maxAttempts: 2, maxCostUsd: 1 } };
    expect(
      checkBudgetExhaustion(retry, { ...ZERO, retries: 1, costUsd: 0.5 }),
    ).toBeUndefined();
    // Either arm of the retry budget trips the retries limit.
    expect(checkBudgetExhaustion(retry, { ...ZERO, retries: 2 })).toEqual({
      status: 'budget_exhausted',
      limit: 'retries',
    });
    expect(checkBudgetExhaustion(retry, { ...ZERO, costUsd: 1 })).toEqual({
      status: 'budget_exhausted',
      limit: 'retries',
    });
    // A configured dimension that is NOT breached never reports exhaustion.
    expect(
      checkBudgetExhaustion(
        { maxTokens: 100, maxCostUsd: 100, maxToolCalls: 100 },
        { ...ZERO, tokens: 1, costUsd: 1, toolCalls: 1 },
      ),
    ).toBeUndefined();
  });

  it('recordToolCall accumulates spend, refuses an unknown gate and negative spend', () => {
    const gate = createBudgetGate({ maxToolCalls: 2 });
    // The read-only snapshot is enumerable (a hidden getter would break
    // introspection) and starts empty.
    expect(Object.keys(gate)).toContain('usage');
    expect(gate.usage).toEqual(ZERO);
    recordToolCall(gate, { tokens: 3, costUsd: 0.5, runtimeMs: 7 });
    expect(gate.usage).toEqual({
      tokens: 3,
      costUsd: 0.5,
      runtimeMs: 7,
      toolCalls: 1,
      retries: 0,
    });
    // Mutating the snapshot cannot reach the ledger.
    const snapshot = gate.usage;
    snapshot.tokens = 999;
    expect(gate.usage.tokens).toBe(3);
    const unknown = (() => undefined) as unknown as BudgetGate;
    expect(() => recordToolCall(unknown)).toThrow(/unknown budget gate/);
    expect(() => recordToolCall(gate, { costUsd: -0.25 })).toThrow(/costUsd/);
  });

  it('applyBudgetRaise: only the user-minted grant is lawful', () => {
    const current = { maxToolCalls: 1 };
    // Narrowing helper: these cases must all be refusals.
    const reasonOf = (result: BudgetRaiseResult): string => {
      if (result.applied) throw new Error('expected a refusal');
      return result.reason;
    };
    const forged = applyBudgetRaise({
      approver: { decider: 'user' } as never,
      owner: 'w1',
      current,
      proposed: { maxToolCalls: 5 },
    });
    expect(reasonOf(forged)).toContain('invalid grant');
    const unknown = applyBudgetRaise({
      approver: 7 as never,
      owner: 'w1',
      current,
      proposed: { maxToolCalls: 5 },
    });
    expect(reasonOf(unknown)).toContain('unknown');
    const manager = applyBudgetRaise({
      approver: 'manager',
      owner: 'w1',
      current,
      proposed: { maxToolCalls: 5 },
    });
    expect(reasonOf(manager)).toContain('manager');
    // The lawful grant merges the proposed dims over the current budget...
    expect(
      applyBudgetRaise({
        approver: mintUserBudgetApproval(),
        owner: 'w1',
        current,
        proposed: { maxCostUsd: 2 },
      }),
    ).toEqual({ applied: true, budget: { maxToolCalls: 1, maxCostUsd: 2 } });
    // ...and a grant proposing garbage is refused with the validator's reason.
    const refused = applyBudgetRaise({
      approver: mintUserBudgetApproval(),
      owner: 'w1',
      current,
      proposed: { maxToolCalls: 0 },
    });
    expect(reasonOf(refused)).toMatch(/maxToolCalls/);
  });

  it('refuseSelfRaise names the owner for a cross-agent raise', () => {
    const refusal = refuseSelfRaise({
      caller: 'manager',
      owner: 'w1',
      current: {},
      proposed: { maxToolCalls: 5 },
    });
    expect(refusal.refused).toBe(true);
    expect(refusal.reason).toContain('for w1');
  });

  it('buildBudgetTrajectoryEvent reports every configured dim, floored, plus the exhaustion', () => {
    const budget = {
      maxTokens: 10,
      maxCostUsd: 1,
      maxRuntimeMs: 100,
      maxToolCalls: 2,
    };
    const usage: BudgetUsage = {
      tokens: 4,
      costUsd: 0.25,
      runtimeMs: 30,
      toolCalls: 3,
      retries: 0,
    };
    const event = buildBudgetTrajectoryEvent('a', budget, usage);
    expect(event.spent).toEqual(usage);
    expect(event.spent).not.toBe(usage);
    expect(event.remaining).toEqual({
      maxTokens: 6,
      maxCostUsd: 0.75,
      maxRuntimeMs: 70,
      maxToolCalls: 0,
    });
    expect(event.exhausted).toEqual({
      status: 'budget_exhausted',
      limit: 'toolCalls',
    });
    // An over-spent dimension floors at 0 — a negative remainder would read
    // as budget left over.
    const over = buildBudgetTrajectoryEvent('a', budget, {
      ...usage,
      tokens: 99,
      costUsd: 9,
      runtimeMs: 999,
    });
    expect(over.remaining).toEqual({
      maxTokens: 0,
      maxCostUsd: 0,
      maxRuntimeMs: 0,
      maxToolCalls: 0,
    });
  });
});
