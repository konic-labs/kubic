// `[[hooks]]` on the live path: a before-tool hook refuses a call with its
// reason (the model reads the refusal), a hook that times out refuses it
// too, an after-tool hook hears the result, and a run-end hook hears how the
// run ended — each run audited. Faux provider only.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@kubic/agent/pi-boundary';
import { fauxToolUse } from '@kubic/agent/test-support/lane-harness';
import { NodeExecutionEnv } from '@kubic/exec/env';
import type { AdminHook } from '@kubic/host/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { runHeadlessPrompt } from '../../src/run/command.js';

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function hook(
  event: AdminHook['event'],
  command: string,
  extra: Partial<AdminHook> = {},
): AdminHook {
  return { event, command, timeoutMs: 5_000, layer: 'enterprise', ...extra };
}

async function readRun(hooks: AdminHook[]) {
  const workspace = tempDir('hooks-ws-');
  writeFileSync(join(workspace, 'notes.txt'), 'notes-body-7f3a\n');
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const seen: string[] = [];
  faux.setResponses([
    fauxToolUse([fauxToolCall('read', { path: 'notes.txt' })]),
    (context) => {
      seen.push(JSON.stringify(context.messages));
      return fauxAssistantMessage('done');
    },
  ]);
  const result = await runHeadlessPrompt(
    'read the notes',
    {},
    {
      sessionsRoot: tempDir('hooks-sessions-'),
      models,
      env: new NodeExecutionEnv(workspace),
      hooks,
    },
  );
  const audit = readFileSync(
    join(workspace, '.kubic', 'audit', 'audit.jsonl'),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => String(row.what).startsWith('hook:'));
  return { result, workspace, model: seen.join('\n'), audit };
}

describe('kubic run with admin hooks', () => {
  it('refuses a call a before-tool hook refuses, and the model reads why', async () => {
    const run = await readRun([
      hook('beforeTool', 'echo "reads need a ticket"; exit 1', {
        tools: ['read'],
      }),
    ]);
    expect(run.result.terminus).toBe('completed');
    expect(run.model).toContain('refused by the hook');
    expect(run.model).toContain('reads need a ticket');
    expect(run.model).not.toContain('notes-body-7f3a');
    expect(run.audit).toMatchObject([
      {
        what: 'hook:beforeTool',
        result: 'deny',
        reason: 'reads need a ticket',
      },
    ]);
  });

  it('fails closed on a before-tool hook that times out', async () => {
    const run = await readRun([
      hook('beforeTool', 'sleep 10', { timeoutMs: 200 }),
    ]);
    expect(run.model).toContain('did not answer within 200 ms');
    expect(run.model).not.toContain('notes-body-7f3a');
    expect(run.audit).toMatchObject([
      { what: 'hook:beforeTool', result: 'deny' },
    ]);
  });

  it('lets the call through a clean hook, and runs the after-tool and run-end hooks', async () => {
    const run = await readRun([
      hook('beforeTool', 'exit 0'),
      hook('afterTool', 'cat > after.json'),
      hook('runEnd', 'cat > end.json'),
    ]);
    expect(run.model).toContain('notes-body-7f3a');
    const after = JSON.parse(
      readFileSync(join(run.workspace, 'after.json'), 'utf8'),
    );
    expect(after.tool).toMatchObject({
      name: 'read',
      isError: false,
    });
    expect(after.tool.output).toContain('notes-body-7f3a');
    const end = JSON.parse(
      readFileSync(join(run.workspace, 'end.json'), 'utf8'),
    );
    expect(end).toMatchObject({
      event: 'runEnd',
      sessionId: run.result.sessionId,
      status: 'completed',
      summary: 'done',
    });
    expect(run.audit.map((row) => [row.what, row.result])).toEqual([
      ['hook:beforeTool', 'ok'],
      ['hook:afterTool', 'ok'],
      ['hook:runEnd', 'ok'],
    ]);
  });

  it('runs no hook when none is configured', async () => {
    const workspace = tempDir('hooks-ws-');
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('done')]);
    const result = await runHeadlessPrompt(
      'hello',
      {},
      {
        sessionsRoot: tempDir('hooks-sessions-'),
        models,
        env: new NodeExecutionEnv(workspace),
      },
    );
    expect(result.terminus).toBe('completed');
    expect(existsSync(join(workspace, 'end.json'))).toBe(false);
  });
});
