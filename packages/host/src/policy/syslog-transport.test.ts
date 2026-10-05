// Prod syslog transports (issue #286): thin dgram wrappers behind the
// injectable `SyslogTransport`. The socket factory is injectable, so these
// tests never open a real socket.
import { describe, expect, it, vi } from 'vitest';
import {
  createUdpSyslogTransport,
  createUnixSyslogTransport,
} from './syslog-transport.js';

describe('syslog transports (issue #286)', () => {
  it('sends unix datagrams to the socket path', () => {
    const send = vi.fn();
    const close = vi.fn();
    const create = vi.fn(() => ({ send, close }));
    createUnixSyslogTransport(
      '/dev/log',
      create as unknown as Parameters<typeof createUnixSyslogTransport>[1],
    ).send('<134>1 line');
    expect(create).toHaveBeenCalledWith('unix_dgram');
    expect(send).toHaveBeenCalledWith('<134>1 line', '/dev/log');
    expect(close).toHaveBeenCalled();
  });

  it('sends UDP datagrams to the host and port', () => {
    const send = vi.fn();
    const close = vi.fn();
    const create = vi.fn(() => ({ send, close }));
    createUdpSyslogTransport(
      'loghost',
      514,
      create as unknown as Parameters<typeof createUdpSyslogTransport>[2],
    ).send('<134>1 line');
    expect(create).toHaveBeenCalledWith('udp4');
    expect(send).toHaveBeenCalledWith('<134>1 line', 514, 'loghost');
    expect(close).toHaveBeenCalled();
  });

  it('a socket-creation failure throws synchronously', () => {
    const create = (): never => {
      throw new Error('dgram unsupported');
    };
    expect(() =>
      createUnixSyslogTransport(
        '/dev/log',
        create as unknown as Parameters<typeof createUnixSyslogTransport>[1],
      ).send('line'),
    ).toThrow('dgram unsupported');
  });
});
