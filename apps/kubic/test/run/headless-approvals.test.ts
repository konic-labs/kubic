// Approvals for `kubic run` without a terminal: a challenged call is asked
// of the approval broker and waits for a person's answer within
// maxPendingMs (recorded in the audit ledger like a TUI answer), an
// unanswered ask is denied when the bound passes, and a signed pre-approval
// grants exactly the commands it lists. Faux provider, loopback broker.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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
import { parsePreApprovals } from '@kubic/host/approvals';
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

async function broker(answers: unknown[]): Promise<string> {
  server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answers.shift() ?? { decision: 'pending' }));
    });
  });
  await new Promise<void>((resolve) =>
    (server as Server).listen(0, '127.0.0.1', resolve),
  );
  const { port } = (server as Server).address() as AddressInfo;
  return `http://127.0.0.1:${port}/asks`;
}

async function removeRun(command: string, deps: Partial<HeadlessRunDeps>) {
  const workspace = tempDir('headless-approvals-ws-');
  mkdirSync(join(workspace, 'scratch'));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxToolUse([fauxToolCall('bash', { command })]),
    fauxAssistantMessage('done'),
  ]);
  const result = await runHeadlessPrompt(
    'clean up',
    {},
    {
      sessionsRoot: tempDir('headless-approvals-sessions-'),
      models,
      env: new NodeExecutionEnv(workspace),
      ...deps,
    },
  );
  const ledger = join(workspace, '.kubic', 'audit', 'audit.jsonl');
  const rows = existsSync(ledger)
    ? readFileSync(ledger, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((row) => row.what === 'tool:bash')
    : [];
  return {
    result,
    removed: !existsSync(join(workspace, 'scratch')),
    rows,
  };
}

describe('kubic run with an approval broker', () => {
  it('waits for the answer a person gives, and records it', async () => {
    const url = await broker([
      { decision: 'pending' },
      { decision: 'allow-once', by: 'alice' },
    ]);
    const run = await removeRun('rm -rf scratch', {
      approvalBroker: { url },
      approvals: { maxPendingMs: 10_000 },
    });
    expect(run.result.terminus).toBe('completed');
    expect(run.removed).toBe(true);
    expect(JSON.stringify(run.rows)).toContain('broker:alice');
  });

  it('denies a call nobody answered within maxPendingMs', async () => {
    const url = await broker([]);
    const run = await removeRun('rm -rf scratch', {
      approvalBroker: { url },
      approvals: { maxPendingMs: 300 },
    });
    expect(run.result.terminus).toBe('approval_timed_out');
    expect(run.removed).toBe(false);
  });

  it('records a deny with who gave it', async () => {
    const url = await broker([
      { decision: 'deny', by: 'bob', reason: 'use the cleanup job' },
    ]);
    const run = await removeRun('rm -rf scratch', {
      approvalBroker: { url },
    });
    expect(run.result.terminus).toBe('approval_denied');
    expect(run.removed).toBe(false);
    expect(JSON.stringify(run.rows)).toContain(
      'denied by bob through the approval broker: use the cleanup job',
    );
  });
});

describe('kubic run with a pre-approval file', () => {
  const preApprovals = parsePreApprovals(
    JSON.stringify({
      version: 1,
      job: 'cleanup',
      reason: 'the nightly cleanup',
      grants: [
        {
          capability: 'destructive-shell',
          tools: ['bash'],
          commands: ['rm -rf scratch'],
        },
      ],
    }),
    'cleanup.json',
  );

  it('runs exactly what it lists without an ask', async () => {
    const run = await removeRun('rm -rf scratch', { preApprovals });
    expect(run.result.terminus).toBe('completed');
    expect(run.removed).toBe(true);
    expect(JSON.stringify(run.rows)).toContain('pre-approval:cleanup');
  });

  it('grants nothing else', async () => {
    const run = await removeRun('rm -rf scratch .git', { preApprovals });
    expect(run.result.terminus).toBe('approval_denied');
    expect(run.removed).toBe(false);
  });
});
