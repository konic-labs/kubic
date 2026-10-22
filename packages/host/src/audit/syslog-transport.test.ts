// Prod syslog transports: UDP over a real loopback socket, and the unix
// transport through the system logger — with the logger located and run by
// injected stand-ins, so no test writes to the system log.
import { createSocket } from 'node:dgram';
import type {
  SystemLogger,
  sendToSystemLogger,
} from '@kubic/exec/syslog-logger';
import { describe, expect, it, vi } from 'vitest';
import { AuditSinkError } from './audit.js';
import {
  createUdpSyslogTransport,
  createUnixSyslogTransport,
} from './syslog-transport.js';

type Send = typeof sendToSystemLogger;

const LINE =
  '<133>1 2026-10-05T12:00:00.000Z web-1 kubic 1234 - - {"what":"tool:bash"}';

async function loopbackListener(): Promise<{
  port: number;
  received: string[];
  waitFor: (count: number) => Promise<void>;
  close: () => void;
}> {
  const server = createSocket('udp4');
  const received: string[] = [];
  server.on('message', (message) => received.push(message.toString('utf8')));
  await new Promise<void>((resolve) => server.bind(0, '127.0.0.1', resolve));
  const waitFor = async (count: number): Promise<void> => {
    for (let attempt = 0; attempt < 200 && received.length < count; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return {
    port: server.address().port,
    received,
    waitFor,
    close: () => server.close(),
  };
}

describe('UDP syslog transport', () => {
  it('delivers every line to a loopback listener, by address and by name', async () => {
    const listener = await loopbackListener();
    try {
      createUdpSyslogTransport('127.0.0.1', listener.port).send('<133>1 a');
      createUdpSyslogTransport('localhost', listener.port).send('<133>1 b');
      await listener.waitFor(2);
      expect([...listener.received].sort()).toEqual(['<133>1 a', '<133>1 b']);
    } finally {
      listener.close();
    }
  });

  it('closes the socket after the send completes and reports a failed send', () => {
    const order: string[] = [];
    const errors: string[] = [];
    const create = vi.fn(() => ({
      send: (...args: unknown[]) => {
        order.push('send');
        const callback = args[3] as (error: Error | null) => void;
        callback(new Error('host unreachable'));
      },
      close: () => order.push('close'),
      on: vi.fn(),
    }));
    createUdpSyslogTransport('loghost', 514, {
      create: create as never,
      onError: (message) => errors.push(message),
    }).send('<133>1 line');
    expect(create).toHaveBeenCalledWith('udp4');
    expect(order).toEqual(['send', 'close']);
    expect(errors).toEqual(['syslog udp loghost:514: host unreachable']);
  });

  it('closes the socket and rethrows a synchronous send failure', () => {
    const close = vi.fn();
    const create = vi.fn(() => ({
      send: () => {
        throw new Error('bad port');
      },
      close,
    }));
    expect(() =>
      createUdpSyslogTransport('loghost', 514, {
        create: create as never,
      }).send('line'),
    ).toThrow('bad port');
    expect(close).toHaveBeenCalled();
  });
});

describe('unix syslog transport', () => {
  const other: SystemLogger = { path: '/usr/bin/logger', flavor: 'other' };
  const utilLinux: SystemLogger = {
    path: '/usr/bin/logger',
    flavor: 'util-linux',
  };
  const defaultSocket =
    process.platform === 'darwin' ? '/var/run/syslog' : '/dev/log';

  it('hands the default socket the priority, tag and message of each line', () => {
    const send = vi.fn<Send>(async () => undefined);
    createUnixSyslogTransport(defaultSocket, {
      locate: () => other,
      send,
    }).send(LINE);
    expect(send).toHaveBeenCalledWith(
      other,
      ['-p', '133', '-t', 'kubic', '--', '{"what":"tool:bash"}'],
      expect.any(Function),
    );
  });

  it('reaches another socket through util-linux logger', () => {
    const send = vi.fn<Send>(async () => undefined);
    createUnixSyslogTransport('/run/custom.sock', {
      locate: () => utilLinux,
      send,
    }).send(LINE);
    expect(send.mock.calls[0]?.[1]).toEqual([
      '--id=1234',
      '--size',
      '65536',
      '-p',
      '133',
      '-t',
      'kubic',
      '-u',
      '/run/custom.sock',
      '--',
      '{"what":"tool:bash"}',
    ]);
  });

  it('refuses another socket when the logger cannot reach it', () => {
    expect(() =>
      createUnixSyslogTransport('/run/custom.sock', { locate: () => other }),
    ).toThrow(AuditSinkError);
    expect(() =>
      createUnixSyslogTransport('/run/custom.sock', { locate: () => other }),
    ).toThrow('needs util-linux logger');
  });

  it('refuses a socket when no system logger exists', () => {
    expect(() =>
      createUnixSyslogTransport(defaultSocket, { locate: () => undefined }),
    ).toThrow('no system logger');
  });

  it('reports an asynchronous logger failure', () => {
    const errors: string[] = [];
    createUnixSyslogTransport(defaultSocket, {
      locate: () => other,
      send: async (_logger, _args, onError) => {
        onError('logger exited 1: socket refused');
      },
      onError: (message) => errors.push(message),
    }).send(LINE);
    expect(errors).toEqual(['logger exited 1: socket refused']);
  });

  it('refuses a line that is not RFC 5424', () => {
    const transport = createUnixSyslogTransport(defaultSocket, {
      locate: () => other,
      send: async () => undefined,
    });
    expect(() => transport.send('not a syslog line')).toThrow(AuditSinkError);
  });
});
