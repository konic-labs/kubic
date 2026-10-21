// `[sandbox]` on `kubic run` (Seatbelt on macOS, bubblewrap on Linux): a
// bash command opens no connection, while a call the approval approved for
// `network` gets exactly the network; the workspace stays writable. Faux
// provider, a loopback server as the far end.
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@kubic/agent/pi-boundary';
import { fauxToolUse } from '@kubic/agent/test-support/lane-harness';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { detectSandbox } from '@kubic/exec/sandbox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { runHeadlessPrompt } from '../../src/run/command.js';
import type { HeadlessRunDeps } from '../../src/run/options.js';

let server: Server | undefined;

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => {
    if (server === undefined) resolve();
    else server.close(() => resolve());
  });
  server = undefined;
});

async function bashRun(command: string, deps: Partial<HeadlessRunDeps> = {}) {
  const workspace = tempDir('sandbox-run-ws-');
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const seen: string[] = [];
  faux.setResponses([
    fauxToolUse([fauxToolCall('bash', { command })]),
    (context) => {
      seen.push(JSON.stringify(context.messages.at(-1)));
      return fauxAssistantMessage('done');
    },
  ]);
  const result = await runHeadlessPrompt(
    'run it',
    {},
    {
      sessionsRoot: tempDir('sandbox-run-sessions-'),
      models,
      env: new NodeExecutionEnv(workspace),
      sandbox: { mode: 'auto', writable: [] },
      ...deps,
    },
  );
  return { result, workspace, output: seen.join('\n') };
}

describe.skipIf(detectSandbox().kind === undefined)(
  'kubic run with [sandbox] mode = "auto"',
  () => {
    it('writes in the workspace and opens no connection', async () => {
      const run = await bashRun(
        `echo hi > made.txt && ${process.execPath} -e "require('net').connect(9,'127.0.0.1').on('error',e=>console.log('net:'+e.code))"`,
      );
      expect(run.result.terminus).toBe('completed');
      expect(existsSync(join(run.workspace, 'made.txt'))).toBe(true);
      // Seatbelt refuses the connection; bubblewrap's own network namespace
      // has nothing listening.
      expect(run.output).toMatch(/net:(EPERM|ECONNREFUSED)/);
    });

    it('gives a call approved for network exactly the network', async () => {
      server = createServer((_request, response) => {
        response.end('far end answered');
      });
      await new Promise<void>((resolve) =>
        (server as Server).listen(0, '127.0.0.1', resolve),
      );
      const { port } = (server as Server).address() as AddressInfo;
      const run = await bashRun(`curl -s http://127.0.0.1:${port}/`, {
        approvals: { autoApprove: ['network'] },
      });
      expect(run.result.terminus).toBe('completed');
      expect(run.output).toContain('far end answered');
    });
  },
);
