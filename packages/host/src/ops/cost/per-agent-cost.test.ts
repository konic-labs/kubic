// Per-agent cost surface: TUI-row + --json shape, Σ(per-agent) == task (issue #56): RED first.
import { describe, expect, it } from 'vitest';
import {
  formatAgentCostRow,
  summarizePerAgentCost,
  toCostJson,
} from './per-agent-cost.js';

const ROWS = [
  {
    agentId: 'worker-1',
    model: 'cheap/small',
    costUsd: 0.2,
    input: 100,
    output: 50,
  },
  {
    agentId: 'worker-2',
    model: 'pro/large',
    costUsd: 0.3,
    input: 200,
    output: 60,
  },
];

describe('per-agent cost surface (issue #56)', () => {
  it('sums per-agent costs to exactly the task total', () => {
    const summary = summarizePerAgentCost(ROWS);
    expect(summary.taskTotal).toBeCloseTo(0.5);
    const parts = summary.perAgent.reduce(
      (acc, entry) => acc + entry.costUsd,
      0,
    );
    expect(parts).toBeCloseTo(summary.taskTotal);
  });

  it('formats a TUI row per agent', () => {
    const summary = summarizePerAgentCost(ROWS);
    const first = summary.perAgent[0];
    if (first === undefined) throw new Error('missing fixture agent');
    const row = formatAgentCostRow(first);
    expect(row).toMatch(/worker-1/);
    expect(row).toMatch(/0\.20/);
  });

  it('exposes a --json shape with per-agent entries plus the task total', () => {
    const json = toCostJson(summarizePerAgentCost(ROWS));
    expect(json.taskTotal).toBeCloseTo(0.5);
    expect(json.agents).toHaveLength(2);
    expect(json.agents[1]?.agentId).toBe('worker-2');
  });
});
