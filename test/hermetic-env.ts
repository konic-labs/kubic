// Hermetic unit-test environment (issue #377).
//
// The solo and TUI prod paths default the skill roots to os.homedir()
// (~/.agents/skills, ~/.pi/agent/skills) and read the project trust opt-in
// from KUBIC_TRUST_PROJECT, so without isolation every system-prompt
// assertion depended on the developer's machine. isolateTestEnv() points
// HOME at a fresh temp dir, clears every ambient KUBIC_* variable, and
// refuses non-loopback TCP connects (a test-owned loopback server is
// allowed); restore() undoes all three and removes the temp HOME.
// test/vitest-setup.ts applies it to every test file.
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

// A loopback destination never leaves the machine, so a test that owns a
// local server (`createServer` on port 0) stays hermetic; only egress is
// refused. `undefined`/empty host means Node's default, localhost.
// Exported for the contract test (hermetic-test-env.test.ts).
export function isLoopbackHost(host: unknown): boolean {
  if (host === undefined || host === '' || host === null) return true;
  if (typeof host !== 'string') return false;
  const bare = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (bare === 'localhost' || bare === '::1') return true;
  if (/^127(\.\d{1,3}){3}$/.test(bare)) return true;
  // IPv4-mapped IPv6 loopback (`::ffff:127.0.0.1`).
  return /^::ffff:127(\.\d{1,3}){3}$/.test(bare);
}

// The host a connect() call would reach: `connect(port, host)`,
// `connect(options)` (host absent means localhost).
function connectHost(args: unknown[]): unknown {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof first === 'object' && first !== null) {
    return (first as { host?: unknown }).host;
  }
  return args[1];
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
    if (!isPathConnect(args) && !isLoopbackHost(connectHost(args))) {
      throw new Error(
        `hermetic test env: TCP connect to ${describeTarget(args)} refused — unit tests must not reach the network (a test-owned loopback server is fine: bind port 0)`,
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
