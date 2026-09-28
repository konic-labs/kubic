// Hermetic unit-test environment (issue #377).
//
// The solo and TUI prod paths default the skill roots to os.homedir()
// (~/.agents/skills, ~/.pi/agent/skills) and read the project trust opt-in
// from KUBIC_TRUST_PROJECT, so without isolation every system-prompt
// assertion depended on the developer's machine. isolateTestEnv() points
// HOME at a fresh temp dir, clears every ambient KUBIC_* variable, and
// refuses TCP connects; restore() undoes all three and removes the temp
// HOME. test/vitest-setup.ts applies it to every test file.
import { mkdtempSync, rmSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface HermeticEnv {
  readonly home: string;
  restore(): void;
}

// os.homedir() reads HOME on POSIX and USERPROFILE on Windows.
const HOME_KEYS = ['HOME', 'USERPROFILE'] as const;

function isPathConnect(args: unknown[]): boolean {
  const first = args[0];
  if (Array.isArray(first)) return isPathConnect(first);
  if (typeof first === 'object' && first !== null) {
    return typeof (first as { path?: unknown }).path === 'string';
  }
  // connect(path[, listener]) — a non-numeric string is an IPC path.
  return typeof first === 'string' && !/^\d+$/.test(first);
}

function describeTarget(args: unknown[]): string {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof first === 'object' && first !== null) {
    const { host, port } = first as { host?: unknown; port?: unknown };
    return `${String(host ?? 'localhost')}:${String(port)}`;
  }
  const host = typeof args[1] === 'string' ? args[1] : 'localhost';
  return `${host}:${String(first)}`;
}

export function isolateTestEnv(parent: string = tmpdir()): HermeticEnv {
  const saved = new Map<string, string | undefined>();
  const save = (key: string): void => {
    if (!saved.has(key)) saved.set(key, process.env[key]);
  };

  const home = mkdtempSync(join(parent, 'kubic-test-home-'));
  for (const key of HOME_KEYS) {
    save(key);
    process.env[key] = home;
  }
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith('KUBIC_')) continue;
    save(key);
    delete process.env[key];
  }

  const original = Socket.prototype.connect;
  const guarded = function connect(this: Socket, ...args: unknown[]): Socket {
    if (!isPathConnect(args)) {
      throw new Error(
        `hermetic test env: TCP connect to ${describeTarget(args)} refused — unit tests must not open sockets (use the faux provider)`,
      );
    }
    return (original as (...rest: unknown[]) => Socket).apply(this, args);
  };
  Socket.prototype.connect = guarded as typeof Socket.prototype.connect;

  return {
    home,
    restore(): void {
      if (Socket.prototype.connect === guarded) {
        Socket.prototype.connect = original;
      }
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(home, { recursive: true, force: true });
    },
  };
}
