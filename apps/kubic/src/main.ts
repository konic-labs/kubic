// kubic CLI composition root: argv in, exit code out. All logic lives in
// the packages; this file only wires.

import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import { runGitCommand } from '../../../packages/host/src/git-cli.js';
import { runJournalCommand } from '../../../packages/host/src/journal-cli.js';
import {
  assembleModels,
  runModelsCommand,
} from '../../../packages/host/src/models-cli.js';
import { runRunCommand } from '../../../packages/host/src/run-cli.js';
import {
  defaultSessionsRoot,
  runSessionsCommand,
} from '../../../packages/host/src/sessions-cli.js';
import {
  attachSession,
  createSession,
  openSessionStore,
} from '../../../packages/worker/src/lane/session-store.js';
import { BACKGROUND_CONTEXT } from '../../../packages/worker/src/pi-boundary.js';

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
  if (command === 'run') {
    return runRunCommand(rest, {
      out: (line: string) => console.log(line),
      run: async (prompt: string, options: { sessionId?: string }) => {
        const root = defaultSessionsRoot();
        const store = openSessionStore(root, createNodeFileBridge(root));
        const session =
          options.sessionId === undefined
            ? await createSession(store, process.cwd(), BACKGROUND_CONTEXT)
            : await attachSession(store, options.sessionId, BACKGROUND_CONTEXT);
        const id = session.metadata.id;
        try {
          await session.mutate(async (mutator) => {
            await mutator.commit(
              [
                {
                  kind: 'entry',
                  entry: {
                    id: `e-run-${Date.now()}`,
                    parentId: null,
                    type: 'message',
                    message: {
                      role: 'user',
                      content: [{ type: 'text', text: prompt }],
                      timestamp: Date.now(),
                    },
                  },
                },
              ],
              BACKGROUND_CONTEXT,
            );
          }, BACKGROUND_CONTEXT);
        } finally {
          await session.close(BACKGROUND_CONTEXT);
        }
        return {
          terminus: 'completed',
          summary: prompt,
          sessionId: id,
          journalRef: `journal:${id}`,
          usageRef: `usage:${id}`,
          trajectoryRef: `trajectory:${id}`,
        };
      },
    });
  }
  console.log(
    'usage: kubic <sessions | git | models | diff | undo | log | status | run>',
  );
  return 1;
}

const code = await main(process.argv.slice(2));
process.exit(code);
