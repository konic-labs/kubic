// Per-agent cost surface (issue #56; §49.2, §62 total-cost objective).
// Every agent row carries its own cost; the task total is EXACTLY the sum
// of the per-agent rows — Σ(per-agent) == task cost, never a second
// accounting. Surfaces: one TUI row per agent plus a --json shape.
// Pure: no I/O, no network, faux-only (fixture rows in tests).

export interface AgentCostInput {
  agentId: string;
  model: string;
  costUsd: number;
  input: number;
  output: number;
}

export interface AgentCostEntry extends AgentCostInput {}

export interface PerAgentCostSummary {
  perAgent: AgentCostEntry[];
  taskTotal: number;
}

export interface CostJsonShape {
  agents: AgentCostEntry[];
  taskTotal: number;
}

export function summarizePerAgentCost(
  rows: AgentCostInput[],
): PerAgentCostSummary {
  const perAgent: AgentCostEntry[] = rows.map((row) => ({ ...row }));
  const taskTotal = perAgent.reduce(
    (acc: number, entry: AgentCostEntry) => acc + entry.costUsd,
    0,
  );
  return { perAgent, taskTotal };
}

export function formatAgentCostRow(entry: AgentCostEntry): string {
  const tokens = entry.input + entry.output;
  return `agent ${entry.agentId} | model ${entry.model} | ${tokens} tokens ($${entry.costUsd.toFixed(2)})`;
}

export function toCostJson(summary: PerAgentCostSummary): CostJsonShape {
  return {
    agents: summary.perAgent.map((entry) => ({ ...entry })),
    taskTotal: summary.taskTotal,
  };
}
