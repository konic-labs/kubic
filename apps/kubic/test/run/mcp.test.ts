// An allowlisted MCP server on `kubic run`: its tools are offered beside the
// built-ins and each call is audited; a tool its entry says always asks goes
// through the approval pipeline like a built-in (refused headless, with no
// answer surface); a tool off the allowlist is never offered. A real stdio
// server (a Node script), faux provider.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@kubic/agent/pi-boundary';
import { fauxToolUse } from '@kubic/agent/test-support/lane-harness';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { writeFakeMcpServer } from '@kubic/host/test-support/fake-mcp-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { runHeadlessPrompt } from '../../src/run/command.js';

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function mcpRun(call: { tool: string; args: Record<string, string> }) {
  const workspace = tempDir('mcp-run-ws-');
  const server = writeFakeMcpServer(tempDir('mcp-run-server-'));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const seen: string[] = [];
  faux.setResponses([
    (context) => {
      seen.push(JSON.stringify(context));
      return fauxToolUse([fauxToolCall(call.tool, call.args)]);
    },
    (context) => {
      seen.push(JSON.stringify(context.messages));
      return fauxAssistantMessage('done');
    },
  ]);
  const result = await runHeadlessPrompt(
    'use the server',
    {},
    {
      sessionsRoot: tempDir('mcp-run-sessions-'),
      models,
      env: new NodeExecutionEnv(workspace),
      mcp: [
        {
          name: 'fake',
          command: server.command,
          args: server.args,
          version: '1.2.3',
          tools: ['echo', 'danger'],
          approve: ['danger'],
        },
      ],
    },
  );
  const ledger = readFileSync(
    join(workspace, '.kubic', 'audit', 'audit.jsonl'),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { result, seen, ledger };
}

describe('kubic run with an allowlisted MCP server', () => {
  it('offers its allowlisted tools, runs a call and audits it', async () => {
    const run = await mcpRun({
      tool: 'mcp__fake__echo',
      args: { text: 'hello' },
    });
    expect(run.result.terminus).toBe('completed');
    expect(run.seen[0]).toContain('mcp__fake__echo');
    expect(run.seen[0]).toContain('mcp__fake__danger');
    expect(run.seen[0]).not.toContain('mcp__fake__hidden');
    expect(run.seen[1]).toContain('echo: hello');
    expect(
      run.ledger.find((row) => row.what === 'mcp:fake/echo'),
    ).toMatchObject({ result: 'ok' });
  });

  it('asks before a tool its entry says always asks', async () => {
    const run = await mcpRun({ tool: 'mcp__fake__danger', args: {} });
    expect(run.result.terminus).toBe('approval_denied');
    expect(run.ledger.some((row) => row.what === 'mcp:fake/danger')).toBe(
      false,
    );
    expect(
      run.ledger.find((row) => row.what === 'tool:mcp__fake__danger'),
    ).toMatchObject({ result: 'deny' });
  });
});
