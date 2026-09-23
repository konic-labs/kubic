// kubic CLI composition root: argv in, exit code out. All logic lives in
// the packages; this file only wires.

import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import { runGitCommand } from '../../../packages/host/src/git-cli.js';
import { runJournalCommand } from '../../../packages/host/src/journal-cli.js';
import {
  assembleModels,
  runModelsCommand,
} from '../../../packages/host/src/models-cli.js';
import { runSessionsCommand } from '../../../packages/host/src/sessions-cli.js';

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'sessions') {
    return runSessionsCommand(rest, { out: (line) => console.log(line) });
  }
  if (command === 'git') {
    return runGitCommand(rest, {
      env: new NodeExecutionEnv(process.cwd()),
      out: (line) => console.log(line),
    });
  }
  if (
    command === 'diff' ||
    command === 'undo' ||
    command === 'log' ||
    command === 'status'
  ) {
    return runJournalCommand([command, ...rest], {
      out: (line) => console.log(line),
    });
  }
  if (command === 'models') {
    const assembled = assembleModels(process.cwd());
    if (assembled.note !== null) console.log(assembled.note);
    return runModelsCommand(rest, {
      models: assembled.models,
      out: (line) => console.log(line),
    });
  }
  console.log(
    'usage: kubic <sessions | git | models | diff | undo | log | status>',
  );
  return 1;
}

const code = await main(process.argv.slice(2));
process.exit(code);
