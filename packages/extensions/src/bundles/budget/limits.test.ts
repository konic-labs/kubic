// Budget bundle facet branches (issue #368): the worker limit checks, the
// tui status text and the host service copy are pure functions, so every
// branch is pinned here directly — including the cost branch and the
// usage == max boundary the loader-level tests never reach.
import { describe, expect, it } from 'vitest';
import { BUDGET_SERVICE, type BudgetLimits } from './contract.js';
import { type BudgetHostEnv, registerBudgetService } from './host.js';
import { renderBudgetStatus } from './tui.js';
import { type BudgetUsage, checkBudgetExhausted } from './worker.js';

describe('checkBudgetExhausted boundaries (issue #368)', () => {
  const cases: {
    name: string;
    usage: BudgetUsage;
    limits: BudgetLimits;
    want: string | undefined;
  }[] = [
    // Tokens: max-1 passes, max passes (the check is `>`), max+1 exhausts.
    {
      name: 'tokens below max passes',
      usage: { tokens: 99 },
      limits: { maxTokens: 100 },
      want: undefined,
    },
    {
      name: 'tokens equal to max passes',
      usage: { tokens: 100 },
      limits: { maxTokens: 100 },
      want: undefined,
    },
    {
      name: 'tokens above max exhausts',
      usage: { tokens: 101 },
      limits: { maxTokens: 100 },
      want: 'tokens',
    },
    // Cost: same boundary shape, with the cost reason text.
    {
      name: 'cost below max passes',
      usage: { costUsd: 0.49 },
      limits: { maxCostUsd: 0.5 },
      want: undefined,
    },
    {
      name: 'cost equal to max passes',
      usage: { costUsd: 0.5 },
      limits: { maxCostUsd: 0.5 },
      want: undefined,
    },
    {
      name: 'cost above max exhausts',
      usage: { costUsd: 0.51 },
      limits: { maxCostUsd: 0.5 },
      want: 'cost',
    },
    // Tool calls: same boundary shape.
    {
      name: 'calls below max pass',
      usage: { toolCalls: 1 },
      limits: { maxToolCalls: 2 },
      want: undefined,
    },
    {
      name: 'calls equal to max pass',
      usage: { toolCalls: 2 },
      limits: { maxToolCalls: 2 },
      want: undefined,
    },
    {
      name: 'calls above max exhaust',
      usage: { toolCalls: 3 },
      limits: { maxToolCalls: 2 },
      want: 'toolCalls',
    },
    // Undefined sides never breach: no usage, no limits, or neither.
    {
      name: 'no usage breaches nothing',
      usage: {},
      limits: { maxTokens: 1, maxCostUsd: 0.5, maxToolCalls: 2 },
      want: undefined,
    },
    {
      name: 'no limits breach nothing',
      usage: { tokens: 10 ** 9, costUsd: 10 ** 9, toolCalls: 10 ** 9 },
      limits: {},
      want: undefined,
    },
    {
      name: 'usage without its limit passes',
      usage: { tokens: 10 ** 9 },
      limits: { maxCostUsd: 0.5 },
      want: undefined,
    },
    {
      name: 'limit without its usage passes',
      usage: { costUsd: 0.1 },
      limits: { maxTokens: 1 },
      want: undefined,
    },
  ];
  for (const entry of cases) {
    it(entry.name, () => {
      expect(checkBudgetExhausted(entry.usage, entry.limits)).toBe(entry.want);
    });
  }
});

describe('checkBudgetExhausted precedence (issue #368)', () => {
  const full: BudgetLimits = { maxTokens: 1, maxCostUsd: 0.5, maxToolCalls: 2 };
  it('tokens wins when every limit is breached', () => {
    expect(
      checkBudgetExhausted({ tokens: 2, costUsd: 0.6, toolCalls: 3 }, full),
    ).toBe('tokens');
  });
  it('cost wins when cost and calls are breached but tokens hold', () => {
    expect(
      checkBudgetExhausted({ tokens: 1, costUsd: 0.6, toolCalls: 3 }, full),
    ).toBe('cost');
  });
  it('toolCalls reports when only it is breached', () => {
    expect(
      checkBudgetExhausted({ tokens: 1, costUsd: 0.5, toolCalls: 3 }, full),
    ).toBe('toolCalls');
  });
});

describe('renderBudgetStatus (issue #368)', () => {
  it('renders every limit in facet order', () => {
    expect(
      renderBudgetStatus({
        maxTokens: 1,
        maxCostUsd: 0.5,
        maxRuntimeMs: 100,
        maxToolCalls: 2,
      }),
    ).toBe('budget: tokens≤1 cost≤$0.5 wall≤100ms calls≤2');
  });
  it('renders each limit alone', () => {
    expect(renderBudgetStatus({ maxTokens: 1 })).toBe('budget: tokens≤1');
    expect(renderBudgetStatus({ maxCostUsd: 0.5 })).toBe('budget: cost≤$0.5');
    expect(renderBudgetStatus({ maxRuntimeMs: 100 })).toBe(
      'budget: wall≤100ms',
    );
    expect(renderBudgetStatus({ maxToolCalls: 2 })).toBe('budget: calls≤2');
  });
  it('renders the empty state with no limits', () => {
    expect(renderBudgetStatus({})).toBe('budget: none configured');
  });
});

describe('registerBudgetService copies the limits (issue #368)', () => {
  it('mutating the caller object after registration leaves the service unchanged', () => {
    const seen = new Map<string, unknown>();
    const env: BudgetHostEnv = {
      provide: (name: string, impl: unknown) => {
        seen.set(name, impl);
      },
    };
    const limits: BudgetLimits = { maxTokens: 100, maxToolCalls: 2 };
    registerBudgetService(env, limits);
    const service = seen.get(BUDGET_SERVICE) as BudgetLimits;
    expect(service).toEqual({ maxTokens: 100, maxToolCalls: 2 });
    expect(service).not.toBe(limits);
    limits.maxTokens = 1;
    limits.maxToolCalls = 0;
    expect(service).toEqual({ maxTokens: 100, maxToolCalls: 2 });
  });
});
