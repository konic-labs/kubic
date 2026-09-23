// Eval signals (issue #53; design §48).
// Pure derivation of the §48 signal set from a parsed trajectory export
// (read via parseTrajectoryExport — this package never redefines the
// trajectory shape). Counts (tokens/cost/latency/tools/escalations) come
// straight from the trajectory; gate signals (tests/build/lint/typecheck)
// are `unknown` unless the trajectory eval labels carry an explicit
// `signal:<name>` = pass|fail override — never guessed.
import type { TrajectoryExport } from '../../trajectory/src/schema.js';

export type GateSignal = 'pass' | 'fail' | 'unknown';

export interface EvalSignals {
  tests: GateSignal;
  build: GateSignal;
  lint: GateSignal;
  typecheck: GateSignal;
  completion: boolean;
  quality: number;
  regressionFree: boolean;
  tokens: number;
  costUsd: number;
  latencyMs: number;
  toolCalls: number;
  toolCounts: Record<string, number>;
  escalations: number;
}

function gateSignal(labels: Record<string, string>, name: string): GateSignal {
  const value = labels[`signal:${name}`];
  if (value === 'pass' || value === 'fail') return value;
  return 'unknown';
}

export function computeSignals(exported: TrajectoryExport): EvalSignals {
  const completion = exported.result.status === 'completed';
  const toolCounts: Record<string, number> = {};
  for (const action of exported.actions) {
    toolCounts[action.tool] = (toolCounts[action.tool] ?? 0) + 1;
  }
  return {
    tests: gateSignal(exported.eval.labels, 'tests'),
    build: gateSignal(exported.eval.labels, 'build'),
    lint: gateSignal(exported.eval.labels, 'lint'),
    typecheck: gateSignal(exported.eval.labels, 'typecheck'),
    completion,
    quality: completion ? 1 : 0,
    regressionFree: completion,
    tokens: exported.usage.inputTokens + exported.usage.outputTokens,
    costUsd: exported.usage.costUsd,
    latencyMs: exported.timestamps.durationMs,
    toolCalls: exported.actions.length,
    toolCounts,
    escalations: exported.model.escalations.length,
  };
}
