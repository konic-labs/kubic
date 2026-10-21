// Delivers syslog messages to a unix socket through the system `logger`
// command. Node's dgram has no unix datagram sockets, and every supported
// platform ships a logger: util-linux or busybox on Linux, BSD on macOS
// (where it writes to the unified log). Lives in exec: only packages/exec
// touches node:child_process (I/O confinement).
//
// Delivery is best-effort and asynchronous, like the UDP transport: the audit
// sink is synchronous, so a spawn or exit failure arrives later on `onError`.

import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';

/** Where a system logger is looked for; PATH is never searched. */
const LOGGER_PATHS = ['/usr/bin/logger', '/bin/logger', '/usr/sbin/logger'];

// A logger that runs past this is killed and reported: a wedged syslog
// daemon must not keep a child per audit record alive.
const LOGGER_TIMEOUT_MS = 5000;

// util-linux truncates at 1 KiB unless told otherwise; an audit record is
// larger than that.
const UTIL_LINUX_MAX_MESSAGE = 65536;

// The child's whole environment: no provider key or other secret in Kubic's
// environment reaches the logger.
const LOGGER_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };

/** util-linux logger takes a socket path (`-u`); BSD and busybox do not. */
export type LoggerFlavor = 'util-linux' | 'other';

export interface SystemLogger {
  readonly path: string;
  readonly flavor: LoggerFlavor;
}

/** One message as logger takes it. */
export interface LoggerMessage {
  /** The numeric syslog priority: facility × 8 + severity. */
  readonly priority: number;
  readonly tag: string;
  readonly pid: number;
  readonly message: string;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const flavors = new Map<string, LoggerFlavor>();

/**
 * The flavor of the logger at `path`, probed once per process.
 * @internal
 */
export function loggerFlavor(path: string): LoggerFlavor {
  const known = flavors.get(path);
  if (known !== undefined) return known;
  const probe = spawnSync(path, ['--version'], {
    encoding: 'utf8',
    timeout: 2000,
    env: LOGGER_ENV,
  });
  const flavor: LoggerFlavor =
    `${probe.stdout ?? ''}${probe.stderr ?? ''}`.includes('util-linux')
      ? 'util-linux'
      : 'other';
  flavors.set(path, flavor);
  return flavor;
}

/** The system logger, or undefined when none of the known paths has one. */
export function findSystemLogger(
  paths: readonly string[] = LOGGER_PATHS,
): SystemLogger | undefined {
  const path = paths.find(executable);
  return path === undefined ? undefined : { path, flavor: loggerFlavor(path) };
}

/**
 * logger's argv for one message. `socket` is set only for a target other
 * than the platform default, which only util-linux can reach.
 */
export function loggerArgs(
  flavor: LoggerFlavor,
  message: LoggerMessage,
  socket?: string,
): string[] {
  const common = ['-p', String(message.priority), '-t', message.tag];
  if (flavor === 'util-linux') {
    return [
      `--id=${message.pid}`,
      '--size',
      String(UTIL_LINUX_MAX_MESSAGE),
      ...common,
      ...(socket === undefined ? [] : ['-u', socket]),
      '--',
      message.message,
    ];
  }
  return [...common, '--', message.message];
}

/**
 * Spawns one logger; a spawn failure, a non-zero exit or a timeout is
 * reported on `onError`. The returned promise settles when the logger is done
 * (delivery itself is fire-and-forget; tests await it).
 */
export function sendToSystemLogger(
  logger: SystemLogger,
  args: readonly string[],
  onError: (message: string) => void,
): Promise<void> {
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    const settle = (failure?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failure !== undefined) onError(failure);
      resolve();
    };
    const child = spawn(logger.path, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: LOGGER_ENV,
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(`${logger.path} did not finish within ${LOGGER_TIMEOUT_MS}ms`);
    }, LOGGER_TIMEOUT_MS);
    timer.unref();
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 1024) stderr += chunk;
    });
    child.on('error', (error) => {
      settle(`${logger.path} failed: ${error.message}`);
    });
    child.on('close', (code) => {
      if (code === 0) {
        settle();
        return;
      }
      const detail = stderr.trim().split('\n')[0] ?? '';
      settle(
        `${logger.path} exited ${code}${detail === '' ? '' : `: ${detail}`}`,
      );
    });
  });
}

/** Whether `path` is a unix domain socket. */
export function isUnixSocket(path: string): boolean {
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
}
