// The system-logger transport: argv per logger flavor, flavor detection and
// the real spawn, driven through fake logger scripts so no test writes to the
// system log.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../test/temp-dir.js';
import {
  findSystemLogger,
  isUnixSocket,
  loggerArgs,
  loggerFlavor,
  sendToSystemLogger,
} from './syslog-logger.js';

const message = {
  priority: 133,
  tag: 'kubic',
  pid: 4242,
  message: '{"what":"tool:bash"}',
};

// A logger stand-in: records its argv one per line, prints `version` for
// `--version`, then exits with `exitCode`.
function fakeLogger(
  options: { version?: string; exitCode?: number; stderr?: string } = {},
): { path: string; argvFile: string } {
  const dir = tempDir('syslog-logger-');
  const path = join(dir, 'logger');
  const argvFile = join(dir, 'argv.txt');
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      `if [ "$1" = "--version" ]; then printf '%s\\n' '${options.version ?? 'usage: logger [-is]'}'; exit 0; fi`,
      `printf '%s\\n' "$@" > '${argvFile}'`,
      options.stderr === undefined
        ? ''
        : `printf '%s\\n' '${options.stderr}' >&2`,
      `exit ${options.exitCode ?? 0}`,
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return { path, argvFile };
}

async function settle(
  path: string,
  args: string[],
): Promise<{ errors: string[]; argv: string }> {
  const errors: string[] = [];
  await sendToSystemLogger({ path, flavor: 'other' }, args, (failure) => {
    errors.push(failure);
  });
  let argv = '';
  try {
    argv = readFileSync(join(path, '..', 'argv.txt'), 'utf8');
  } catch {
    argv = '';
  }
  return { errors, argv };
}

describe('logger argv', () => {
  it('passes the pid, a large size and the socket to util-linux logger', () => {
    expect(loggerArgs('util-linux', message, '/run/custom.sock')).toEqual([
      '--id=4242',
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

  it('passes only the priority, tag and message to other loggers', () => {
    expect(loggerArgs('other', message)).toEqual([
      '-p',
      '133',
      '-t',
      'kubic',
      '--',
      '{"what":"tool:bash"}',
    ]);
  });
});

describe('finding the system logger', () => {
  it('takes the first executable path and detects util-linux', () => {
    const missing = join(tempDir('syslog-logger-'), 'absent');
    const logger = fakeLogger({ version: 'logger from util-linux 2.39.3' });
    expect(findSystemLogger([missing, logger.path])).toEqual({
      path: logger.path,
      flavor: 'util-linux',
    });
  });

  it('reads any other logger as the other flavor', () => {
    const logger = fakeLogger();
    expect(loggerFlavor(logger.path)).toBe('other');
  });

  it('finds nothing when no path holds a logger', () => {
    expect(
      findSystemLogger([join(tempDir('syslog-logger-'), 'absent')]),
    ).toBeUndefined();
  });
});

describe('sending through the logger', () => {
  it('runs the logger with the argv and reports nothing on success', async () => {
    const logger = fakeLogger();
    const result = await settle(logger.path, loggerArgs('other', message));
    expect(result.errors).toEqual([]);
    expect(result.argv.split('\n').slice(0, 6)).toEqual([
      '-p',
      '133',
      '-t',
      'kubic',
      '--',
      '{"what":"tool:bash"}',
    ]);
  });

  it('reports a non-zero exit with the first stderr line', async () => {
    const logger = fakeLogger({ exitCode: 3, stderr: 'socket refused' });
    const result = await settle(logger.path, loggerArgs('other', message));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('exited 3: socket refused');
  });

  it('reports a logger that cannot be spawned', async () => {
    const path = join(tempDir('syslog-logger-'), 'gone');
    const result = await settle(path, loggerArgs('other', message));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('failed');
  });
});

describe('isUnixSocket', () => {
  it('is true for a listening unix socket and false for a file or nothing', async () => {
    const dir = tempDir('syslog-logger-');
    const socket = join(dir, 's.sock');
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      expect(isUnixSocket(socket)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const file = join(dir, 'plain');
    writeFileSync(file, 'x');
    expect(isUnixSocket(file)).toBe(false);
    expect(isUnixSocket(join(dir, 'absent'))).toBe(false);
  });
});
