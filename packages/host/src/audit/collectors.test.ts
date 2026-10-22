import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createServer as createTcpServer,
  type Server as TcpServer,
} from 'node:net';
import { join } from 'node:path';
import { createServer as createTlsServer } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import type { otlpLogsBody } from './collectors.js';
import {
  appendToLedger,
  auditSinkSnapshot,
  flushAuditSinks,
  setAuditSinks,
} from './ledger.js';
import { runStartAudit } from './records.js';
import { buildConfiguredSinks } from './sinks.js';

const servers: Array<Server | TcpServer> = [];

afterEach(async () => {
  setAuditSinks([]);
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
});

function input(session = 's1') {
  return runStartAudit({
    sessionId: session,
    command: 'kubic run',
    runMode: 'interactive',
    workspace: '/repo',
    posture: 'approvals',
    autonomous: false,
    base: 'none',
  });
}

// A loopback collector answering `status()` and keeping each body.
async function httpCollector(status: () => number) {
  const bodies: unknown[] = [];
  const headers: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    let text = '';
    request.on('data', (chunk) => {
      text += String(chunk);
    });
    request.on('end', () => {
      headers.push(request.headers.authorization);
      const code = status();
      if (code < 300) bodies.push(JSON.parse(text));
      response.writeHead(code).end();
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/audit`,
    bodies,
    headers,
  };
}

describe('collector sinks', () => {
  it('spools a record the https collector refuses and delivers it once the collector is back', async () => {
    let up = false;
    const collector = await httpCollector(() => (up ? 200 : 503));
    const spoolDir = tempDir('audit-spool-');
    const built = buildConfiguredSinks(
      [
        {
          sink: 'https',
          level: 'all',
          target: collector.url,
          tokenEnv: 'AUDIT_TOKEN',
        },
      ],
      { spoolDir, env: { AUDIT_TOKEN: 'tok-123' } },
    );
    expect(built.problems).toEqual([]);
    setAuditSinks(built.sinks);
    const ledger = tempDir('audit-ledger-');
    appendToLedger(ledger, input());
    const down = await flushAuditSinks(5_000);
    expect(down).toEqual([
      expect.objectContaining({ source: 'audit[1]', pending: 1 }),
    ]);
    expect(auditSinkSnapshot()[0]?.pending).toBe(1);
    expect(collector.bodies).toEqual([]);
    // The record survives the process: it is on disk, private.
    const [spoolFile] = readdirSync(spoolDir);
    expect(readFileSync(join(spoolDir, spoolFile ?? ''), 'utf8')).toContain(
      '"what":"run:start"',
    );
    up = true;
    appendToLedger(ledger, input('s2'));
    const back = await flushAuditSinks(5_000);
    expect(back).toEqual([
      expect.objectContaining({ source: 'audit[1]', pending: 0 }),
    ]);
    const delivered = collector.bodies.flatMap(
      (body) =>
        (body as { records: Array<{ agent: { session: string } }> }).records,
    );
    expect(delivered.map((record) => record.agent.session).sort()).toEqual([
      's1',
      's2',
    ]);
    expect(new Set(collector.headers)).toEqual(new Set(['Bearer tok-123']));
  });

  it('delivers OTLP logs to an otlp collector', async () => {
    const collector = await httpCollector(() => 200);
    const built = buildConfiguredSinks(
      [{ sink: 'otlp', level: 'privileged', target: collector.url }],
      { spoolDir: tempDir('audit-spool-') },
    );
    setAuditSinks(built.sinks);
    appendToLedger(tempDir('audit-ledger-'), input());
    await flushAuditSinks(5_000);
    const body = collector.bodies[0] as ReturnType<typeof otlpLogsBody> & {
      resourceLogs: Array<{
        scopeLogs: Array<{ logRecords: Array<{ attributes: unknown[] }> }>;
      }>;
    };
    const record = body.resourceLogs[0]?.scopeLogs[0]?.logRecords[0];
    expect(record).toMatchObject({ severityText: 'NOTICE' });
    expect(record?.attributes).toContainEqual({
      key: 'kubic.audit.what',
      value: { stringValue: 'run:start' },
    });
  });

  it('frames records octet-counted to a tcp syslog collector', async () => {
    let delivered: (text: string) => void = () => undefined;
    const arrived = new Promise<string>((resolve) => {
      delivered = resolve;
    });
    const server = createTcpServer((socket) => {
      let text = '';
      socket.on('data', (chunk) => {
        text += String(chunk);
      });
      socket.on('end', () => {
        socket.end();
        delivered(text);
      });
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as AddressInfo).port;
    const built = buildConfiguredSinks(
      [{ sink: 'syslog', level: 'all', target: `tcp://127.0.0.1:${port}` }],
      { spoolDir: tempDir('audit-spool-') },
    );
    expect(built.problems).toEqual([]);
    setAuditSinks(built.sinks);
    appendToLedger(tempDir('audit-ledger-'), input());
    await flushAuditSinks(5_000);
    const received = await arrived;
    const match = /^(\d+) (<\d+>1 [\s\S]*)$/.exec(received);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(Buffer.byteLength(match?.[2] ?? ''));
    expect(match?.[2]).toContain('"what":"run:start"');
  });

  const openssl = (() => {
    try {
      execFileSync('openssl', ['version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
  (openssl ? it : it.skip)(
    'delivers over TLS to a syslog collector whose certificate the ca trusts',
    async () => {
      const dir = tempDir('audit-tls-');
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'ec',
          '-pkeyopt',
          'ec_paramgen_curve:prime256v1',
          '-nodes',
          '-days',
          '1',
          '-subj',
          '/CN=localhost',
          '-addext',
          'subjectAltName=DNS:localhost',
          '-keyout',
          join(dir, 'key.pem'),
          '-out',
          join(dir, 'cert.pem'),
        ],
        { stdio: 'ignore' },
      );
      let delivered: (text: string) => void = () => undefined;
      const arrived = new Promise<string>((resolve) => {
        delivered = resolve;
      });
      const server = createTlsServer(
        {
          key: readFileSync(join(dir, 'key.pem')),
          cert: readFileSync(join(dir, 'cert.pem')),
        },
        (socket) => {
          let text = '';
          socket.on('data', (chunk) => {
            text += String(chunk);
          });
          socket.on('end', () => {
            socket.end();
            delivered(text);
          });
        },
      );
      servers.push(server as unknown as TcpServer);
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const port = (server.address() as AddressInfo).port;
      const built = buildConfiguredSinks(
        [
          {
            sink: 'syslog',
            level: 'all',
            target: `tls://localhost:${port}`,
            ca: join(dir, 'cert.pem'),
          },
        ],
        { spoolDir: tempDir('audit-spool-') },
      );
      expect(built.problems).toEqual([]);
      setAuditSinks(built.sinks);
      appendToLedger(tempDir('audit-ledger-'), input());
      const flushed = await flushAuditSinks(5_000);
      expect(flushed[0]?.pending).toBe(0);
      expect(await arrived).toContain('"what":"run:start"');
    },
  );

  it('refuses a table it cannot build, by name', () => {
    const built = buildConfiguredSinks(
      [
        {
          sink: 'https',
          level: 'all',
          target: 'http://collector.example.com/audit',
        },
        {
          sink: 'otlp',
          level: 'all',
          target: 'https://otel.example.com/v1/logs',
          tokenEnv: 'NO_SUCH_TOKEN',
        },
        { sink: 'https', level: 'all' },
        {
          sink: 'syslog',
          level: 'all',
          target: 'tls://collector.example.com',
          ca: '/no/such/ca.pem',
        },
      ],
      { spoolDir: tempDir('audit-spool-'), env: {} },
    );
    expect(built.sinks).toEqual([]);
    expect(built.problems).toEqual([
      'audit[1]: collector URL http://collector.example.com/audit must use https (plain http only to this machine)',
      'audit[2]: tokenEnv NO_SUCH_TOKEN is not set',
      'audit[3]: sink "https" needs a target URL',
      expect.stringMatching(
        /^audit\[4\]: cannot read ca \/no\/such\/ca\.pem: /,
      ),
    ]);
  });
});
