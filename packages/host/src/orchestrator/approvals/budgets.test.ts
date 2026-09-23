// Opt-in orchestrator budgets (issue #48; §71 enforcement table).
// RED first: no defaults, burn-down per dim, before_tool gate at
// maxToolCalls=5→6th as budget_exhausted (exit 3, never failure),
// self-raise refused, trajectory event emitted.
import { describe, expect, it } from 'vitest';
import { RUN_EXIT_BUDGET } from '../../run-cli.js';
import {
  BUDGET_EXHAUSTED,
  buildBudgetTrajectoryEvent,
  checkBudgetExhaustion,
  createBudgetGate,
  createBurnDown,
  recordToolCall,
  refuseSelfRaise,
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
    const state = createBurnDown(budget);
    state.tokens = 10;
    const hit = checkBudgetExhaustion(budget, {
      tokens: 10,
      costUsd: 0,
      runtimeMs: 0,
      toolCalls: 0,
      retries: 0,
    });
    expect(hit?.status).toBe('budget_exhausted');
    expect(hit?.status).not.toBe('failed');
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
    const state = createBurnDown(budget);
    state.tokens = 30;
    state.toolCalls = 2;
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
  });
});
