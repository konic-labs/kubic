// A CI job reaches a cloud-hosted model through OIDC with no stored key:
// `kubic run` requests the job's token for the gateway's audience and the
// models.json provider sends it as its key. Loopback stand-ins for GitHub's
// token endpoint and for an OpenAI-compatible gateway that accepts only
// that token.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { runHeadlessPrompt } from '../../src/run/command.js';

const servers: Server[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

async function listen(
  handler: Parameters<typeof createServer>[1],
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function chunk(body: unknown): string {
  return `data: ${JSON.stringify(body)}\n\n`;
}

describe('kubic run with [oidc] and a gateway', () => {
  it('authenticates with the job token, no key stored anywhere', async () => {
    const github = await listen((request, response) => {
      const audience = new URL(request.url ?? '/', 'http://x').searchParams.get(
        'audience',
      );
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ value: `job-jwt:${audience}` }));
    });
    const seen: string[] = [];
    const gateway = await listen((request, response) => {
      request.resume();
      request.on('end', () => {
        seen.push(String(request.headers.authorization));
        if (
          request.headers.authorization !== 'Bearer job-jwt:https://gw.example'
        ) {
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end('{"error":{"message":"unauthorized"}}');
          return;
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const base = {
          id: 'c1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'gw-model',
        };
        response.write(
          chunk({
            ...base,
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: 'hello from the gateway' },
                finish_reason: null,
              },
            ],
          }),
        );
        response.write(
          chunk({
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          }),
        );
        response.end('data: [DONE]\n\n');
      });
    });
    const home = tempDir('oidc-home-');
    mkdirSync(join(home, '.kubic', 'models'), { recursive: true });
    writeFileSync(
      join(home, '.kubic', 'models', 'models.json'),
      JSON.stringify({
        providers: {
          gateway: {
            baseUrl: `${gateway}/v1`,
            api: 'openai-completions',
            apiKey: '$KUBIC_OIDC_TOKEN',
            models: [{ id: 'gw-model' }],
          },
        },
      }),
    );
    vi.stubEnv('HOME', home);
    vi.stubEnv('KUBIC_NO_NOTICE', '1');
    vi.stubEnv(
      'ACTIONS_ID_TOKEN_REQUEST_URL',
      `${github}/token?api-version=2.0`,
    );
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'request-token');
    const workspace = tempDir('oidc-ws-');
    const result = await runHeadlessPrompt(
      'hello',
      {},
      {
        sessionsRoot: tempDir('oidc-sessions-'),
        env: new NodeExecutionEnv(workspace),
        modelsCwd: workspace,
        model: { provider: 'gateway', id: 'gw-model' },
        oidc: { provider: 'github', gatewayAudience: 'https://gw.example' },
      },
    );
    expect(result.terminus).toBe('completed');
    expect(result.summary).toBe('hello from the gateway');
    expect(seen).toEqual(['Bearer job-jwt:https://gw.example']);
  });
});
