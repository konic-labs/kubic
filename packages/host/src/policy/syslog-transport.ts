// Prod syslog transports (issue #286; §58): unix datagram and UDP behind
// the injectable `SyslogTransport` (`policy/audit.ts`). One socket per send,
// closed after — syslog lines are rare (one per privileged action), so no
// socket outlives the call. Delivery is best-effort by protocol design
// (syslog over UDP is unreliable; a missing unix socket errors in the
// send callback, which has no channel back through the synchronous sink):
// reachability is the doctor probe's job, not the write path's. A socket
// CREATION failure throws synchronously and surfaces like any sink failure.
import { createSocket } from 'node:dgram';
import type { SyslogTransport } from './audit.js';

type SocketFactory = typeof createSocket;

interface Sendable {
  send: (...args: never[]) => void;
  close: () => void;
}

export function createUnixSyslogTransport(
  socketPath: string,
  create: SocketFactory = createSocket,
): SyslogTransport {
  return {
    send: (line: string): void => {
      const socket = (create as (...args: never[]) => Sendable)(
        'unix_dgram' as never,
      );
      try {
        socket.send(line as never, socketPath as never);
      } finally {
        socket.close();
      }
    },
  };
}

export function createUdpSyslogTransport(
  host: string,
  port: number,
  create: SocketFactory = createSocket,
): SyslogTransport {
  return {
    send: (line: string): void => {
      const socket = (create as (...args: never[]) => Sendable)(
        'udp4' as never,
      );
      try {
        socket.send(line as never, port as never, host as never);
      } finally {
        socket.close();
      }
    },
  };
}
