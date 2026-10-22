// The mutual-TLS fetch against a loopback server that demands a client
// certificate: the request arrives whole with its headers, the answer
// streams back (decompressed when it was compressed), and a client without
// the certificate is turned away.
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../test/temp-dir.js';
import { makeTestPki, type TestPki } from './test-support/tls-certs.js';
import { createTlsFetch } from './tls-fetch.js';

let pki: TestPki;
let server: Server | undefined;

beforeEach(() => {
  pki = makeTestPki(tempDir('tls-fetch-pki-'));
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server === undefined) resolve();
    else server.close(() => resolve());
  });
  server = undefined;
});

async function mtlsServer(): Promise<string> {
  server = createServer(
    {
      cert: pki.serverCert,
      key: pki.serverKey,
      ca: pki.ca,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (request, response) => {
      let body = '';
      request.on('data', (chunk) => {
        body += String(chunk);
      });
      request.on('end', () => {
        const peer = (
          request.socket as unknown as {
            getPeerCertificate: () => { subject?: { CN?: string } };
          }
        ).getPeerCertificate();
        const answer = JSON.stringify({
          client: peer.subject?.CN,
          gateway: request.headers['x-gateway-key'],
          method: request.method,
          body,
        });
        if (request.url === '/gzip') {
          response.writeHead(200, {
            'content-type': 'application/json',
            'content-encoding': 'gzip',
          });
          response.end(gzipSync(answer));
          return;
        }
        if (request.url === '/stream') {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write('data: one\n\n');
          setTimeout(() => response.end('data: two\n\n'), 20);
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(answer);
      });
    },
  );
  await new Promise<void>((resolve) =>
    (server as Server).listen(0, '127.0.0.1', resolve),
  );
  const { port } = (server as Server).address() as AddressInfo;
  return `https://localhost:${port}`;
}

describe('createTlsFetch', () => {
  it('presents the client certificate and sends the request whole', async () => {
    const base = await mtlsServer();
    const fetchImpl = createTlsFetch({
      cert: pki.clientCertPath,
      key: pki.clientKeyPath,
      ca: pki.caPath,
    });
    const response = await fetchImpl(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'x-gateway-key': 'g-123', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      client: 'kubic-test-client',
      gateway: 'g-123',
      method: 'POST',
      body: '{"model":"m"}',
    });
  });

  it('decompresses a compressed answer and streams an event stream', async () => {
    const base = await mtlsServer();
    const fetchImpl = createTlsFetch({
      cert: pki.clientCertPath,
      key: pki.clientKeyPath,
      ca: pki.caPath,
    });
    const gzipped = await fetchImpl(`${base}/gzip`);
    expect(gzipped.headers.get('content-encoding')).toBeNull();
    expect(await gzipped.json()).toMatchObject({ method: 'GET' });
    const stream = await fetchImpl(`${base}/stream`);
    expect(await stream.text()).toBe('data: one\n\ndata: two\n\n');
  });

  it('is turned away with a certificate the server does not trust', async () => {
    const base = await mtlsServer();
    const other = makeTestPki(tempDir('tls-fetch-other-'));
    const stranger = createTlsFetch({
      cert: other.clientCertPath,
      key: other.clientKeyPath,
      ca: pki.caPath,
    });
    await expect(stranger(`${base}/x`)).rejects.toThrow();
  });

  it('names a certificate file it cannot read', () => {
    expect(() =>
      createTlsFetch({
        cert: '/nonexistent/client.pem',
        key: pki.clientKeyPath,
      }),
    ).toThrow('cannot read the TLS client certificate /nonexistent/client.pem');
  });
});
