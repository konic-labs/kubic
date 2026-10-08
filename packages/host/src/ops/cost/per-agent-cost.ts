// Per-agent cost surface (total-cost objective).
// Every agent row carries its own cost; the task total is EXACTLY the sum
// of the per-agent rows — Σ(per-agent) == task cost, never a second
// accounting. Surfaces: one TUI row per agent plus a --json shape.
// Pure: no I/O, no network, faux-only (fixture rows in tests).
//
// `cacheRead`/`cacheWrite` are OPTIONAL additive row fields: they are the
// lever-2 substrate (prefix hit-rate over real
// usage rows) and a caller that has no usage rows simply omits them. The
// documented `--json` top-level shape (`agents`, `taskTotal`) is unchanged.

import { type PrefixHitRate, prefixHitRate } from './cache.js';

export interface AgentCostInput {
  agentId: string;
  model: string;
  costUsd: number;
  input: number;
  output: number;
  // Lever 2: prefix-cache counters off the session's usage rows.
  cacheRead?: number;
  cacheWrite?: number;
  // Row identity below the (session, bucket) facts the
  // loader reads. `agent`/`role` come from the session's metadata
  // (absent for a solo run); `session` is always the session id;
  // `project` is the recorded workspace (`meta.workspace ?? meta.cwd`);
  // `request` is the transcript entry id (per-request rows only). All are
  // additive: older rows simply omit them, and `--json` echoes whatever
  // the row carries.
  agent?: string;
  role?: string;
  session?: string;
  project?: string;
  request?: string;
}

// The level `kubic cost --by` aggregates at — request, session, project.
// The default is per-session: one row per session and model.
export type CostGroupBy = 'request' | 'session' | 'project';

export const COST_GROUP_BYS: readonly CostGroupBy[] = [
  'request',
  'session',
  'project',
];

export const DEFAULT_COST_GROUP_BY: CostGroupBy = 'session';

export function isCostGroupBy(value: string): value is CostGroupBy {
  return (COST_GROUP_BYS as readonly string[]).includes(value);
}

// Sub-cent costs print at 4 decimals so a
// $0.0023 row never reads $0.00; $1 and above stay at 2.
export function formatCostUsd(value: number): string {
  return `$${value.toFixed(Math.abs(value) < 1 ? 4 : 2)}`;
}

function num(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// Aggregate base facts (one per session per usage bucket, plus
// per-request rows) to the `--by` level. `request` rows arrive already at
// their level and pass through copied. Every other level sums counters over
// its key, first-seen order, so the task total stays exactly Σ(rows).
export function groupCostRows(
  rows: readonly AgentCostInput[],
  by: CostGroupBy,
): AgentCostInput[] {
  if (by === 'request') return rows.map((row) => ({ ...row }));
  const keyOf = (row: AgentCostInput): string => {
    if (by === 'session') {
      return `${row.session ?? row.agentId}\n${row.model}`;
    }
    return row.project ?? '(unknown)';
  };
  const grouped = new Map<string, AgentCostInput>();
  for (const row of rows) {
    const key = keyOf(row);
    const entry = grouped.get(key);
    if (entry === undefined) {
      grouped.set(key, {
        ...row,
        // A project row aggregates every model away: it names the project,
        // never one model.
        ...(by === 'project'
          ? {
              agentId: row.project ?? '(unknown)',
              model: '-',
              role: undefined,
              agent: undefined,
              session: undefined,
              request: undefined,
            }
          : {}),
      });
      continue;
    }
    entry.costUsd += num(row.costUsd);
    entry.input += num(row.input);
    entry.output += num(row.output);
    if (row.cacheRead !== undefined || row.cacheWrite !== undefined) {
      entry.cacheRead = num(entry.cacheRead) + num(row.cacheRead);
      entry.cacheWrite = num(entry.cacheWrite) + num(row.cacheWrite);
    }
  }
  return [...grouped.values()];
}

export interface AgentCostEntry extends AgentCostInput {}

export interface PerAgentCostSummary {
  perAgent: AgentCostEntry[];
  taskTotal: number;
  // Lever 2: prefix hit-rate over the rows that carried cache
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
  return `agent ${entry.agentId} | model ${entry.model} | ${tokens} tokens (${formatCostUsd(entry.costUsd)})`;
}

export function toCostJson(summary: PerAgentCostSummary): CostJsonShape {
  return {
    agents: summary.perAgent.map((entry) => ({ ...entry })),
    taskTotal: summary.taskTotal,
  };
}
