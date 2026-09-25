// Per-agent cost surface (issue #56; §49.2, §62 total-cost objective).
// Every agent row carries its own cost; the task total is EXACTLY the sum
// of the per-agent rows — Σ(per-agent) == task cost, never a second
// accounting. Surfaces: one TUI row per agent plus a --json shape.
// Pure: no I/O, no network, faux-only (fixture rows in tests).
//
// Issue #98 adds `cacheRead`/`cacheWrite` to the row as OPTIONAL additive
// fields: they are the §62 lever-2 substrate (prefix hit-rate over real
// usage rows) and a caller that has no usage rows simply omits them. The
// documented `--json` top-level shape (`agents`, `taskTotal`) is unchanged.

import { type PrefixHitRate, prefixHitRate } from './cache.js';

export interface AgentCostInput {
  agentId: string;
  model: string;
  costUsd: number;
  input: number;
  output: number;
  // §62 lever 2 (§98): prefix-cache counters off the session's usage rows.
  cacheRead?: number;
  cacheWrite?: number;
}

export interface AgentCostEntry extends AgentCostInput {}

export interface PerAgentCostSummary {
  perAgent: AgentCostEntry[];
  taskTotal: number;
  // §62 lever 2 (§98): prefix hit-rate over the rows that carried cache
  // counters. null when no row carried any (nothing to measure — never a
  // fabricated 0%).
  cache: PrefixHitRate | null;
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
  const withCache = perAgent.filter(
    (entry) => entry.cacheRead !== undefined || entry.cacheWrite !== undefined,
  );
  return {
    perAgent,
    taskTotal,
    cache:
      withCache.length === 0
        ? null
        : prefixHitRate(
            withCache.map((entry) => ({
              cacheRead: entry.cacheRead ?? 0,
              cacheWrite: entry.cacheWrite ?? 0,
            })),
          ),
  };
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
