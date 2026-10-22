// A models.json provider behind a gateway that demands a client certificate
// and a header of its own: the model answers through it. A loopback
// OpenAI-compatible server stands in for the gateway.
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { makeTestPki, type TestPki } from '@kubic/exec/test-support/tls-certs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { createModels } from '../pi-boundary.js';
import { parseModelsJson } from './parse.js';
import { registerCustomProviders } from './register.js';
import { ModelsJsonError } from './schema.js';

let pki: TestPki;
let server: Server | undefined;

beforeEach(() => {
  pki = makeTestPki(tempDir('gateway-tls-pki-'));
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server === undefined) resolve();
    else server.close(() => resolve());
  });
  server = undefined;
});

function chunk(body: unknown): string {
  return `data: ${JSON.stringify(body)}\n\n`;
}

// Answers a streamed chat completion only for the client certificate the CA
// signed and the gateway key; anything else is a 403.
async function gateway(): Promise<string> {
  server = createServer(
    {
      cert: pki.serverCert,
      key: pki.serverKey,
      ca: pki.ca,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (request, response) => {
      request.resume();
      request.on('end', () => {
        if (request.headers['x-gateway-key'] !== 'team-a') {
          response.writeHead(403, { 'content-type': 'application/json' });
          response.end('{"error":{"message":"missing gateway key"}}');
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
                delta: { role: 'assistant', content: 'through the gateway' },
                finish_reason: null,
              },
            ],
          }),
        );
        response.write(
          chunk({
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
          }),
        );
        response.end('data: [DONE]\n\n');
      });
    },
  );
  await new Promise<void>((resolve) =>
    (server as Server).listen(0, '127.0.0.1', resolve),
  );
  const { port } = (server as Server).address() as AddressInfo;
  return `https://localhost:${port}/v1`;
}

function gatewaySpecs(baseUrl: string, tls: Record<string, string>) {
  return parseModelsJson({
    providers: {
      gateway: {
        baseUrl,
        api: 'openai-completions',
        apiKey: 'not-needed',
        headers: { 'x-gateway-key': 'team-a' },
        tls,
        models: [{ id: 'gw-model' }],
      },
    },
  });
}

describe('a models.json provider behind a mutual-TLS gateway', () => {
  it('answers through the gateway with its client certificate and header', async () => {
    const baseUrl = await gateway();
    const models = createModels();
    registerCustomProviders(
      models,
      gatewaySpecs(baseUrl, {
        cert: pki.clientCertPath,
        key: pki.clientKeyPath,
        ca: pki.caPath,
      }),
    );
    const model = models.getModel('gateway', 'gw-model');
    if (model === undefined) throw new Error('gateway model not registered');
    const answer = await models.complete(model, {
      messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }],
    });
    expect(answer.stopReason).toBe('stop');
    expect(JSON.stringify(answer.content)).toContain('through the gateway');
  });

  it('refuses a tls block it cannot use, by name', () => {
    expect(() =>
      gatewaySpecs('https://gw.example/v1', {
        cert: 'certs/client.pem',
        key: '/k.pem',
      }),
    ).toThrow("provider 'gateway': tls.cert must be an absolute path");
    expect(() =>
      gatewaySpecs('https://gw.example/v1', {
        cert: '/c.pem',
        key: '/k.pem',
        pass: 'x',
      }),
    ).toThrow("provider 'gateway': tls has unknown key(s): pass");
    expect(() =>
      registerCustomProviders(
        createModels(),
        gatewaySpecs('https://gw.example/v1', {
          cert: '/nonexistent/client.pem',
          key: '/nonexistent/client.key',
        }),
      ),
    ).toThrow(ModelsJsonError);
  });
});
