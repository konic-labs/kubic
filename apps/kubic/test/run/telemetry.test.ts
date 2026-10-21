// The OpenTelemetry export on the live path: a real `kubic run` with a tool
// call reaches a local OTLP/HTTP collector as one trace (the run, the lane
// phases, the tool call) and its metrics, with no prompt text in either.
// Faux provider only; the collector listens on loopback.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@kubic/agent/pi-boundary';
import { fauxToolUse } from '@kubic/agent/test-support/lane-harness';
import { FakeExecutionEnv } from '@kubic/exec/test-support/fake-env';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { runHeadlessPrompt } from '../../src/run/command.js';

const servers: Server[] = [];

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
});

async function collector() {
  const received = new Map<string, string>();
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += String(chunk);
    });
    request.on('end', () => {
      received.set(request.url ?? '', body);
      response.writeHead(200).end('{}');
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
  };
}

describe('OpenTelemetry export', () => {
  it('sends the run as one trace and its metrics, with no prompt text', async () => {
    const otel = await collector();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxToolUse([fauxToolCall('ls', { path: '.' })]),
      fauxAssistantMessage('listed'),
    ]);
    const result = await runHeadlessPrompt(
      'list the secret-project files',
      {},
      {
        sessionsRoot: tempDir('otel-sessions-'),
        models,
        env: new FakeExecutionEnv({}),
        telemetry: {
          endpoint: otel.url,
          headers: {},
          serviceName: 'kubic',
          content: false,
        },
      },
    );
    expect(result.terminus).toBe('completed');
    const traces = otel.received.get('/v1/traces') ?? '';
    const metrics = otel.received.get('/v1/metrics') ?? '';
    const spans = (
      JSON.parse(traces) as {
        resourceSpans: Array<{
          scopeSpans: Array<{
            spans: Array<{ name: string; traceId: string }>;
          }>;
        }>;
      }
    ).resourceSpans[0]?.scopeSpans[0]?.spans;
    expect(spans?.map((span) => span.name)).toEqual(
      expect.arrayContaining([
        'kubic.agent.run',
        'kubic.lane.drive',
        'pi.tool.execute',
      ]),
    );
    expect(new Set(spans?.map((span) => span.traceId)).size).toBe(1);
    expect(traces).toContain(result.sessionId);
    expect(metrics).toContain('gen_ai.client.token.usage');
    expect(metrics).toContain('kubic.approvals');
    expect(`${traces}${metrics}`).not.toContain('secret-project');
  });
});
