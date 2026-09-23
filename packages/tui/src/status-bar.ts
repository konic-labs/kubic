// Cost/Model status bar + mode indicator (issue #27).
// §39 usage rows aggregated with the cache split; §18 model +
// thinking / tokens / cache / cost / mode / approvals-disabled; §17
// always-visible solo/orchestrator + OFF indicator; §16.2 StatusBar
// basis 2; §80 cost + status + indicator. Budget burn-down is out of
// scope (orchestrator).
//
// Structural usage mirror: the fields below repeat the shape read in
// packages/worker/src/usage.ts (KubicUsageRow) WITHOUT importing it —
// dep-lint forbids tui → worker. Pi is untouched here (pure strings);
// the Component seam stays in ./tui-boundary.js. No node:fs (I/O
// confinement). Faux-only tests: fixtures, zero network.
//
// TTFT/latency choice: last-wins. The bar shows the LIVE reading, so
// the latest row reporting ttftMs/latencyMs wins (a silent row never
// clears a previous reading).
export interface StatusUsageCost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly total: number;
}

export interface StatusUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  readonly cost: StatusUsageCost;
}

export interface StatusUsageRow {
  readonly model: string;
  readonly provider: string;
  readonly usage: StatusUsage;
  readonly ttftMs?: number;
  readonly latencyMs?: number;
  readonly toolCallId?: string;
  readonly entryId?: string;
}

export interface StatusSummary {
  readonly requests: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly costTotal: number;
  readonly ttftMs?: number;
  readonly toolMs?: number;
}

export function summarizeStatusRows(
  rows: ReadonlyArray<StatusUsageRow>,
): StatusSummary {
  let requests = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let costTotal = 0;
  let ttftMs: number | undefined;
  let toolMs: number | undefined;
  for (const row of rows) {
    requests += 1;
    input += row.usage.input;
    output += row.usage.output;
    cacheRead += row.usage.cacheRead;
    cacheWrite += row.usage.cacheWrite;
    costTotal += row.usage.cost.total;
    if (row.ttftMs !== undefined) ttftMs = row.ttftMs;
    if (row.latencyMs !== undefined) toolMs = row.latencyMs;
  }
  return {
    requests,
    input,
    output,
    cacheRead,
    cacheWrite,
    costTotal,
    ttftMs,
    toolMs,
  };
}

export function formatStatusCost(total: number): string {
  return `$${total.toFixed(2)}`;
}

export type StatusMode = 'solo' | 'orchestrator';

export interface StatusBarState {
  readonly model: string;
  readonly thinking: string;
  readonly rows: ReadonlyArray<StatusUsageRow>;
  readonly mode: StatusMode;
  readonly approvalsSkipped: boolean;
  readonly sessionId: string;
}
