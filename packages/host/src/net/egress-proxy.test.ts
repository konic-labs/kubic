// The egress proxy: an allowed domain is tunnelled and forwarded with its
// byte count, any other is refused and reported, and the domain rule covers
// subdomains.
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type EgressConnection,
  type EgressProxy,
  hostAllowed,
  startEgressProxy,
} from './egress-proxy.js';

let origin: Server | undefined;
let proxy: EgressProxy | undefined;

afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
  await new Promise<void>((resolve) => {
    if (origin === undefined) resolve();
    else origin.close(() => resolve());
  });
  origin = undefined;
});

async function originServer(): Promise<number> {
  origin = createServer((_request, response) => response.end('from origin'));
  await new Promise<void>((resolve) =>
    (origin as Server).listen(0, '127.0.0.1', resolve),
  );
  return ((origin as Server).address() as AddressInfo).port;
}

function viaProxy(
  url: string,
  port: number,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { host: '127.0.0.1', port, method: 'GET', path: url },
      (response) => {
        let body = '';
        response.on('data', (chunk) => {
          body += String(chunk);
        });
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body }),
        );
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

function tunnel(target: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let seen = '';
    socket.on('data', (chunk) => {
      seen += String(chunk);
      if (seen.includes('\r\n\r\n') && seen.startsWith('HTTP/1.1 200')) {
        if (!seen.includes('GET-SENT')) {
          seen += 'GET-SENT';
          socket.write(
            `GET / HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`,
          );
        }
      }
    });
    socket.on('end', () => resolve(seen));
    socket.on('error', reject);
  });
}

describe('hostAllowed', () => {
  it('covers a domain and its subdomains, or only the subdomains', () => {
    expect(hostAllowed('api.github.com', ['github.com'])).toBe(true);
    expect(hostAllowed('github.com', ['github.com'])).toBe(true);
    expect(hostAllowed('evilgithub.com', ['github.com'])).toBe(false);
    expect(hostAllowed('github.com', ['*.github.com'])).toBe(false);
    expect(hostAllowed('raw.github.com', ['*.github.com'])).toBe(true);
  });
});

describe('startEgressProxy', () => {
  it('forwards an allowed host and refuses another, reporting both', async () => {
    const port = await originServer();
    const seen: EgressConnection[] = [];
    proxy = await startEgressProxy({
      allowed: ['127.0.0.1'],
      onConnection: (connection) => seen.push(connection),
    });
    const allowed = await viaProxy(`http://127.0.0.1:${port}/`, proxy.port);
    expect(allowed).toEqual({ status: 200, body: 'from origin' });
    const refused = await viaProxy('http://blocked.example/', proxy.port);
    expect(refused.status).toBe(403);
    expect(refused.body).toContain('blocked.example is not an allowed domain');
    expect(seen).toEqual([
      expect.objectContaining({ host: '127.0.0.1', port, allowed: true }),
      { host: 'blocked.example', port: 80, allowed: false, bytes: 0 },
    ]);
    expect(seen[0]?.bytes).toBeGreaterThan(0);
  });

  it('tunnels an allowed CONNECT and refuses another', async () => {
    const port = await originServer();
    const seen: EgressConnection[] = [];
    proxy = await startEgressProxy({
      allowed: ['127.0.0.1'],
      onConnection: (connection) => seen.push(connection),
    });
    expect(await tunnel(`127.0.0.1:${port}`, proxy.port)).toContain(
      'from origin',
    );
    expect(await tunnel('blocked.example:443', proxy.port)).toContain(
      '403 Forbidden',
    );
    expect(seen.map((connection) => connection.allowed)).toEqual([true, false]);
  });
});
