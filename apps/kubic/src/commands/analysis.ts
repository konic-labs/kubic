// Analysis surfaces: cost, perf, policy, audit, eval, benchmark, replay,
// export. Registered on the root program by ../dispatch.ts.

import type {
  CommandRegistrar,
  CommandRunner,
  DispatchRunners,
} from '../cli/context.js';
import { registerForwarder } from '../cli/program.js';

type AnalysisKey =
  | 'cost'
  | 'perf'
  | 'policy'
  | 'audit'
  | 'eval'
  | 'benchmark'
  | 'replay'
  | 'export';

const ANALYSIS: readonly (readonly [AnalysisKey, string])[] = [
  ['cost', 'report token and dollar cost'],
  ['perf', 'report run performance'],
  ['policy', 'evaluate the tool policy'],
  ['audit', 'inspect the audit ledger'],
  ['eval', 'run evaluation tasks'],
  ['benchmark', 'run the benchmark suite'],
  ['replay', 'replay a recorded trajectory'],
  ['export', 'export a trajectory'],
];

export const registerAnalysisCommands: CommandRegistrar = (program, ctx) => {
  const { config } = ctx;
  const runners: DispatchRunners = ctx.runners;
  for (const [name, summary] of ANALYSIS) {
    const runner: CommandRunner = runners[name];
    registerForwarder(program, ctx, name, (rest) => runner(rest, config), {
      summary,
    });
  }
};
