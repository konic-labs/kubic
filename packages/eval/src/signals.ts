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

// Fail-closed gate: any red tests/build/lint/typecheck signal vetoes
// success, even when the run completed. Unknown signals abstain.
export function gatesPass(
  signals: Pick<EvalSignals, 'tests' | 'build' | 'lint' | 'typecheck'>,
): boolean {
  return (
    signals.tests !== 'fail' &&
    signals.build !== 'fail' &&
    signals.lint !== 'fail' &&
    signals.typecheck !== 'fail'
  );
}

export function computeSignals(exported: TrajectoryExport): EvalSignals {
  const completion = exported.result.status === 'completed';
  const tests = gateSignal(exported.eval.labels, 'tests');
  const build = gateSignal(exported.eval.labels, 'build');
  const lint = gateSignal(exported.eval.labels, 'lint');
  const typecheck = gateSignal(exported.eval.labels, 'typecheck');
  // A completed run with a red gate is not a success: quality and
  // regression-freedom are gated on every known signal, not on
  // completion alone.
  const red =
    tests === 'fail' ||
    build === 'fail' ||
    lint === 'fail' ||
    typecheck === 'fail';
  const green = completion && !red;
  const toolCounts: Record<string, number> = {};
  for (const action of exported.actions) {
    toolCounts[action.tool] = (toolCounts[action.tool] ?? 0) + 1;
  }
  return {
    tests,
    build,
    lint,
    typecheck,
    completion,
    quality: green ? 1 : 0,
    regressionFree: green,
    tokens: exported.usage.inputTokens + exported.usage.outputTokens,
    costUsd: exported.usage.costUsd,
    latencyMs: exported.timestamps.durationMs,
    toolCalls: exported.actions.length,
    toolCounts,
    escalations: exported.model.escalations.length,
  };
}
