// Prod syslog transports behind the injectable `SyslogTransport`
// (`audit.ts`): UDP through node:dgram, and a unix socket through the system
// logger (`@kubic/exec/syslog-logger`), because Node's dgram has no unix
// datagram sockets. Syslog lines are rare (one per privileged action), so
// each send opens and closes its own socket or process. Delivery is
// best-effort by protocol design and asynchronous: a failure that arrives
// after the synchronous sink returned goes to `onError`, which the configured
// sink records. A transport that cannot be set up (no system logger, a socket
// path this logger cannot reach) throws when it is created, so the sink is
// refused by name instead of dropping records.
import { createSocket } from 'node:dgram';
import {
  findSystemLogger,
  type LoggerMessage,
  loggerArgs,
  type SystemLogger,
  sendToSystemLogger,
} from '@kubic/exec/syslog-logger';
import type { SyslogTransport } from './audit.js';
import { AuditSinkError, defaultSyslogSocketPath } from './audit.js';

type SocketFactory = typeof createSocket;
type ErrorSink = (message: string) => void;

interface Sendable {
  send: (...args: never[]) => void;
  close: () => void;
  // Optional so injected fakes without `on` still typecheck; prod sockets
  // always carry it. `unknown[]` (not `never[]`) keeps the real dgram
  // socket's `on` comparable under the cast below.
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The socket closes in the send callback: closing right after `send()` drops
// the datagram, which is still queued behind the implicit bind (and the DNS
// lookup of a host name).
export function createUdpSyslogTransport(
  host: string,
  port: number,
  options: { create?: SocketFactory; onError?: ErrorSink } = {},
): SyslogTransport {
  const create = options.create ?? createSocket;
  const report = (error: unknown): void => {
    options.onError?.(`syslog udp ${host}:${port}: ${message(error)}`);
  };
  return {
    send: (line: string): void => {
      const socket = (create as (...args: never[]) => Sendable)(
        'udp4' as never,
      );
      socket.on?.('error', (error) => {
        report(error);
        socket.close();
      });
      try {
        socket.send(
          line as never,
          port as never,
          host as never,
          ((error: Error | null) => {
            socket.close();
            if (error) report(error);
          }) as never,
        );
      } catch (error) {
        socket.close();
        throw error;
      }
    },
  };
}

// Our own lines: `<PRI>1 TIMESTAMP HOST APP PROCID - - MSG` (`createSyslogSink`).
function rfc5424Parts(line: string): LoggerMessage {
  const match = /^<(\d{1,3})>1 \S+ \S+ (\S+) (\d+) - - ([\s\S]*)$/.exec(line);
  if (match === null) {
    throw new AuditSinkError('syslog line is not an RFC 5424 line');
  }
  return {
    priority: Number(match[1]),
    tag: match[2] as string,
    pid: Number(match[3]),
    message: match[4] as string,
  };
}

// The platform's default socket is what every system logger writes to; any
// other socket path needs util-linux logger's `-u`.
export function createUnixSyslogTransport(
  socketPath: string,
  options: {
    locate?: () => SystemLogger | undefined;
    onError?: ErrorSink;
    send?: typeof sendToSystemLogger;
  } = {},
): SyslogTransport {
  const logger = (options.locate ?? findSystemLogger)();
  if (logger === undefined) {
    throw new AuditSinkError(
      `no system logger to reach the syslog socket ${socketPath} (looked for /usr/bin/logger, /bin/logger and /usr/sbin/logger)`,
    );
  }
  const custom = socketPath !== defaultSyslogSocketPath();
  if (custom && logger.flavor !== 'util-linux') {
    throw new AuditSinkError(
      `the syslog socket ${socketPath} needs util-linux logger: ${logger.path} only writes to the system log (${defaultSyslogSocketPath()})`,
    );
  }
  const deliver = options.send ?? sendToSystemLogger;
  return {
    send: (line: string): void => {
      void deliver(
        logger,
        loggerArgs(
          logger.flavor,
          rfc5424Parts(line),
          custom ? socketPath : undefined,
        ),
        (failure) => options.onError?.(failure),
      );
    },
  };
}

// Why a unix syslog target cannot be delivered here, for the doctor probe:
// undefined when its transport can be set up.
export function unixSyslogTransportProblem(
  socketPath: string,
): string | undefined {
  try {
    createUnixSyslogTransport(socketPath);
    return undefined;
  } catch (error) {
    return message(error);
  }
}
