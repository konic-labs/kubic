// Orchestrator-mode commands (delegation is a mode): orchestrate, clean,
// workers. Registered on the root program by ../dispatch.ts.

import type { CommandRegistrar } from '../cli/context.js';
import { registerForwarder } from '../cli/program.js';

export const registerOrchestratorCommands: CommandRegistrar = (
  program,
  ctx,
) => {
  const { runners, config } = ctx;
  registerForwarder(
    program,
    ctx,
    'orchestrate',
    (rest) => runners.orchestrate(rest, config),
    { summary: 'run a manager with one worker per subagent' },
  );
  registerForwarder(
    program,
    ctx,
    'clean',
    (rest) => runners.clean(rest, config),
    { summary: 'remove orchestrator worktrees and runtime state' },
  );
  registerForwarder(
    program,
    ctx,
    'workers',
    async (rest) => {
      const code = await runners.workers(rest, config);
      // runWorkersCommand reports usage as 1; the binary surfaces §78
      // usage errors as 2 (issue #77).
      return code === 1 ? 2 : code;
    },
    { summary: 'list orchestrator workers' },
  );
};
