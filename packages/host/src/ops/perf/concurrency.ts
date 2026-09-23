// Aggregate concurrency enforcement for the perf lane (issue #55;
// §45, §71, §81). Thin read-only seam over the §47 parallel limits:
// unconfigured caps never block the spawn path; configured caps gate
// it. No I/O, no clock, no network (faux-only).

import type {
  AggregateCaps,
  GateVerdict,
  ResourceEstimate,
} from '../../orchestrator/parallel/limits.js';
import {
  checkAggregateAdmission,
  isAggregateConfigured,
} from '../../orchestrator/parallel/limits.js';

export type { AggregateCaps, GateVerdict, ResourceEstimate };

export function isPerfAggregateEnforced(
  caps: AggregateCaps | undefined,
): boolean {
  return isAggregateConfigured(caps);
}

export function checkPerfAggregateAdmission(
  running: readonly ResourceEstimate[],
  candidate: ResourceEstimate,
  caps: AggregateCaps | undefined,
): GateVerdict {
  return checkAggregateAdmission(running, candidate, caps);
}
