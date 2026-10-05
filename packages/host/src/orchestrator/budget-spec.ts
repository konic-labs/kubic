// Budget and model-ref rules shared by the `--budget` / `--agents` flag
// parsers (orchestrate-cli.ts) and the manager-lane spawn adapter
// (manager-tools.ts). Issue #207 deduplicated these rules; they live in this
// leaf module because orchestrate-cli.ts imports manager-tools.ts, so the
// adapter importing them back from orchestrate-cli.ts would form a cycle and
// leave the class hierarchy and these constants undefined at load time.

import { MAX_RUN_TIMEOUT_MS } from '../run-cli.js';

// --budget maxToolCalls=10                                  (every worker)
// --budget worker-1:maxToolCalls=10;worker-2:maxCostUsd=1   (per spawn)
// Opt-in only: a malformed value is a usage error, never a silently dropped
// limit (a dropped limit would run a worker unbounded while looking bounded).
export const BUDGET_DIMENSIONS: readonly string[] = [
  'maxTokens',
  'maxCostUsd',
  'maxRuntimeMs',
  'maxToolCalls',
];

// The `provider/id` shape an explicit per-agent model pin must carry.
export function isModelRef(raw: string): boolean {
  const slash = raw.indexOf('/');
  return slash > 0 && slash < raw.length - 1;
}

// Validate one dimensions object (positive numbers over the closed dim
// set, maxRuntimeMs under the setTimeout ceiling). The stored form and a
// tool-arg map carry the same shape.
export function storedBudgetDims(
  raw: unknown,
): Record<string, number> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const dims: Record<string, number> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!BUDGET_DIMENSIONS.includes(name)) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || !(value > 0)) {
      return undefined;
    }
    if (name === 'maxRuntimeMs' && value > MAX_RUN_TIMEOUT_MS) return undefined;
    dims[name] = value;
  }
  return Object.keys(dims).length === 0 ? undefined : dims;
}
