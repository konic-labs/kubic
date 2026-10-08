// Session cost rows for `kubic cost`: the rows the readout prints, aggregated
// to the `--by` level, and the task total. The unit is the session: a session's
// usage splits into one bucket per model it ran, and one per tool that reported
// its own spend. The task total is the sum of the rows by construction, never a
// second accounting. Pure: no I/O, no network; fixture rows in tests.
//
// `cacheRead`/`cacheWrite` are optional row fields carrying the prefix-cache
// counters read off real usage rows; a caller without usage rows omits them.
// The `--json` document is `CostJsonShape` (`rows`, `taskTotal`).

import { type PrefixHitRate, prefixHitRate } from './cache.js';

// One cost row. `session` is the session id; `project` is the recorded
// workspace (`meta.workspace ?? meta.cwd`); `request` is the transcript entry
// id (per-request rows only). A project row carries no session. All are
// additive: older rows simply omit them, and `--json` echoes whatever the row
// carries.
export interface SessionCostInput {
  model: string;
  costUsd: number;
  input: number;
  output: number;
  // Prefix-cache counters off the session's usage rows.
  cacheRead?: number;
  cacheWrite?: number;
  session?: string;
  project?: string;
  request?: string;
}

// The level `kubic cost --by` aggregates at: request, session or project.
// The default is the session: one row per session and model it ran.
export type CostGroupBy = 'request' | 'session' | 'project';

const COST_GROUP_BYS: readonly CostGroupBy[] = [
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

// Aggregate base facts (one per session per usage bucket, plus per-request
// rows) to the `--by` level. `request` rows arrive already at their level and
// pass through copied. Every other level sums counters over its key,
// first-seen order, so the task total stays exactly Σ(rows).
export function groupCostRows(
  rows: readonly SessionCostInput[],
  by: CostGroupBy,
): SessionCostInput[] {
  if (by === 'request') return rows.map((row) => ({ ...row }));
  const keyOf = (row: SessionCostInput): string => {
    if (by === 'session') {
      return `${row.session ?? ''}\n${row.model}`;
    }
    return row.project ?? '(unknown)';
  };
  const grouped = new Map<string, SessionCostInput>();
  for (const row of rows) {
    const key = keyOf(row);
    const entry = grouped.get(key);
    if (entry === undefined) {
      grouped.set(key, {
        ...row,
        // A project row aggregates every model away: it names the project,
        // never one model.
        ...(by === 'project'
          ? { model: '-', session: undefined, request: undefined }
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

export interface SessionCostSummary {
  rows: SessionCostInput[];
  taskTotal: number;
  // The units the level counts: distinct sessions at `session` (a session with
  // several model buckets is one unit), otherwise one per row.
  units: number;
  // Prefix hit-rate per unit that carried cache counters. null when none did
  // (nothing to measure — never a fabricated 0%).
  cache: PrefixHitRate | null;
}

// The `--json` document: the rows the table prints and the task total.
export interface CostJsonShape {
  rows: SessionCostInput[];
  taskTotal: number;
}

// The cache counters each unit carries. At the `session` level a session's
// buckets sum into one unit, so its prefix hit is judged on the session.
function cacheUnitsOf(
  rows: readonly SessionCostInput[],
  by: CostGroupBy,
): Array<{ cacheRead: number; cacheWrite: number }> {
  const withCache = rows.filter(
    (row) => row.cacheRead !== undefined || row.cacheWrite !== undefined,
  );
  if (by !== 'session') {
    return withCache.map((row) => ({
      cacheRead: row.cacheRead ?? 0,
      cacheWrite: row.cacheWrite ?? 0,
    }));
  }
  const perSession = new Map<
    string,
    { cacheRead: number; cacheWrite: number }
  >();
  for (const row of withCache) {
    const key = row.session ?? '';
    const unit = perSession.get(key) ?? { cacheRead: 0, cacheWrite: 0 };
    unit.cacheRead += row.cacheRead ?? 0;
    unit.cacheWrite += row.cacheWrite ?? 0;
    perSession.set(key, unit);
  }
  return [...perSession.values()];
}

export function summarizeSessionCost(
  rows: SessionCostInput[],
  by: CostGroupBy = DEFAULT_COST_GROUP_BY,
): SessionCostSummary {
  const entries: SessionCostInput[] = rows.map((row) => ({ ...row }));
  const taskTotal = entries.reduce(
    (acc: number, entry: SessionCostInput) => acc + entry.costUsd,
    0,
  );
  const units =
    by === 'session'
      ? new Set(entries.map((entry) => entry.session)).size
      : entries.length;
  const cacheUnits = cacheUnitsOf(entries, by);
  return {
    rows: entries,
    taskTotal,
    units,
    cache: cacheUnits.length === 0 ? null : prefixHitRate(cacheUnits),
  };
}

export function toCostJson(summary: SessionCostSummary): CostJsonShape {
  return {
    rows: summary.rows.map((entry) => ({ ...entry })),
    taskTotal: summary.taskTotal,
  };
}
