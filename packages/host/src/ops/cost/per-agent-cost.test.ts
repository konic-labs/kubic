// Per-agent cost surface: TUI-row + --json shape, Σ(per-agent) == task (issue #56): RED first.
import { describe, expect, it } from 'vitest';
import {
  formatAgentCostRow,
  formatCostUsd,
  groupCostRows,
  isCostGroupBy,
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
    // Issue #250 (§39): sub-cent precision — $0.20 prints at 4 decimals.
    expect(row).toMatch(/0\.2000/);
  });

  it('exposes a --json shape with per-agent entries plus the task total', () => {
    const json = toCostJson(summarizePerAgentCost(ROWS));
    expect(json.taskTotal).toBeCloseTo(0.5);
    expect(json.agents).toHaveLength(2);
    expect(json.agents[1]?.agentId).toBe('worker-2');
  });
});

describe('cost precision and grouping (issue #250)', () => {
  it('prints sub-cent costs at 4 decimals so $0.0023 never reads $0.00', () => {
    expect(formatCostUsd(0.0023)).toBe('$0.0023');
    expect(formatCostUsd(0.041)).toBe('$0.0410');
    expect(formatCostUsd(0)).toBe('$0.0000');
  });

  it('prints $1 and above at 2 decimals', () => {
    expect(formatCostUsd(12.5)).toBe('$12.50');
    expect(formatCostUsd(1)).toBe('$1.00');
  });

  it('accepts exactly the four §39 levels', () => {
    expect(isCostGroupBy('request')).toBe(true);
    expect(isCostGroupBy('agent')).toBe(true);
    expect(isCostGroupBy('session')).toBe(true);
    expect(isCostGroupBy('project')).toBe(true);
    expect(isCostGroupBy('model')).toBe(false);
    expect(isCostGroupBy('')).toBe(false);
  });

  const FACTS = [
    {
      agentId: 's-1',
      agent: 'aaa',
      role: 'implementer',
      session: 's-1',
      project: '/proj',
      model: 'faux/faux-1',
      costUsd: 0.002,
      input: 100,
      output: 10,
      cacheRead: 40,
      cacheWrite: 5,
    },
    {
      agentId: 's-2',
      agent: 'aaa',
      role: 'implementer',
      session: 's-2',
      project: '/proj',
      model: 'faux/faux-1',
      costUsd: 0.003,
      input: 50,
      output: 20,
      cacheRead: 10,
      cacheWrite: 0,
    },
    {
      agentId: 's-3',
      agent: 'bbb',
      role: 'reviewer',
      session: 's-3',
      project: '/proj',
      model: 'faux/faux-1',
      costUsd: 0.006,
      input: 200,
      output: 30,
    },
  ];

  it('groups by agent and model, summing counters, keeping roles apart', () => {
    const grouped = groupCostRows(FACTS, 'agent');
    expect(grouped).toHaveLength(2);
    const impl = grouped[0];
    expect(impl?.agent).toBe('aaa');
    expect(impl?.role).toBe('implementer');
    expect(impl?.costUsd).toBeCloseTo(0.005);
    expect(impl?.input).toBe(150);
    expect(impl?.output).toBe(30);
    expect(impl?.cacheRead).toBe(50);
    expect(impl?.cacheWrite).toBe(5);
    expect(grouped[1]?.agent).toBe('bbb');
    const total = grouped.reduce((acc, row) => acc + row.costUsd, 0);
    expect(total).toBeCloseTo(0.011);
  });

  it('groups by session and model (one row per session bucket)', () => {
    const grouped = groupCostRows(FACTS, 'session');
    expect(grouped).toHaveLength(3);
    expect(grouped[0]?.session).toBe('s-1');
    expect(grouped[0]?.costUsd).toBeCloseTo(0.002);
  });

  it('groups by project, aggregating every model away', () => {
    const grouped = groupCostRows(FACTS, 'project');
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.project).toBe('/proj');
    expect(grouped[0]?.model).toBe('-');
    expect(grouped[0]?.costUsd).toBeCloseTo(0.011);
    expect(grouped[0]?.input).toBe(350);
  });

  it('passes request rows through copied', () => {
    const requested = FACTS.map((fact, index) => ({
      ...fact,
      request: String(index + 1),
    }));
    const grouped = groupCostRows(requested, 'request');
    expect(grouped).toHaveLength(3);
    expect(grouped[1]?.request).toBe('2');
  });
});
