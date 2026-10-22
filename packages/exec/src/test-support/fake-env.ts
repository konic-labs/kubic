// An in-memory execution environment for tests: a scripted shell and a map
// of files, with every spawn recorded.

import type {
  ExecutionEnv,
  FileSystem,
  ProcessHandle,
  ProcessSnapshot,
  Provenance,
  Shell,
  SpawnOptions,
} from '../env/contracts.js';
import { ROOT_PROVENANCE } from '../env/contracts.js';

export interface FakeScript {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// One shell.spawn call, recorded for exact-argv assertions.
export interface FakeSpawnCall {
  cmd: string;
  args: string[];
  provenance: Provenance;
}

export interface FakeOptions {
  // Strict mode: an argv with no scripted answer throws instead of
  // exiting 0, so a test that must not see an argv fails loudly instead
  // of passing silently. ON by default — suites that
  // script only the answers they read opt out explicitly per test with
  // `allowUnscripted: true`.
  strict?: boolean;
  // Explicit opt-out of strict mode for suites that are not asserting
  // exact argv. Prefer scripting the argv; use this only outside the
  // strict-migrated suites.
  allowUnscripted?: boolean;
}

// The fake's missing-path error carries Node's `ENOENT` code, so ops that
// map errno codes see the same shape as the real seam.
function fakeNoSuchFile(path: string): Error {
  return Object.assign(new Error(`fake fs: no such file: ${path}`), {
    code: 'ENOENT',
  });
}

export class FakeExecutionEnv implements ExecutionEnv {
  readonly cwd = '/fake';
  readonly provenance: Provenance;
  private readonly files = new Map<string, string>();
  private readonly scriptMap: Map<string, FakeScript>;
  private readonly strict: boolean;
  // Every spawn, scripted or not, in call order. Tests asserting exact
  // argv read this instead of scripting forbidden argv to fail.
  readonly calls: FakeSpawnCall[] = [];

  readonly fs: FileSystem = {
    readFile: (path: string) => {
      const hit = this.files.get(path);
      if (hit === undefined) throw fakeNoSuchFile(path);
      return hit;
    },
    writeFile: (path: string, content: string) => {
      this.files.set(path, content);
    },
    rename: (from: string, to: string) => {
      const hit = this.files.get(from);
      if (hit === undefined) throw fakeNoSuchFile(from);
      this.files.delete(from);
      this.files.set(to, hit);
    },
    // Prefix filter approximating directory listing (first segment under
    // the path). Known divergence from Node semantics (no `.`/`..`
    // resolution) — the fake is a hermetic stand-in, not a fs model.
    listDir: (path: string) => {
      const prefix =
        path === '.' || path === '' ? '' : `${path.replace(/\/*$/, '')}/`;
      const out = new Set<string>();
      for (const key of this.files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const seg = key.slice(prefix.length).split('/')[0];
        if (seg) out.add(seg as string);
      }
      return [...out];
    },
    stat: (path: string) => {
      const hit = this.files.get(path);
      // Byte sizes: string length counts UTF-16 code units,
      // so multibyte content reports fewer "bytes" than git/du would.
      if (hit !== undefined)
        return {
          isFile: true,
          isDirectory: false,
          size: Buffer.byteLength(hit, 'utf8'),
          mode: 0o644,
        };
      const prefix = `${path.replace(/\/*$/, '')}/`;
      let size = 0;
      let count = 0;
      for (const [k, v] of this.files) {
        if (k.startsWith(prefix)) {
          size += Buffer.byteLength(v, 'utf8');
          count += 1;
        }
      }
      if (count === 0) throw fakeNoSuchFile(path);
      return { isFile: false, isDirectory: true, size, mode: 0o755 };
    },
    // Byte-window read: same [start, end) byte semantics as
    // the node seam (clamped at EOF), so fake-based read tests exercise
    // the ranged path instead of the whole-file fallback.
    readFileRange: (path: string, start: number, end: number): Uint8Array => {
      const hit = this.files.get(path);
      if (hit === undefined) throw fakeNoSuchFile(path);
      const bytes = Buffer.from(hit, 'utf8');
      const from = Math.min(Math.max(0, start), bytes.length);
      const to = Math.min(Math.max(0, end), bytes.length);
      return bytes.subarray(from, Math.max(from, to));
    },
  };

  readonly shell: Shell = {
    spawn: (
      cmd: string,
      args: string[],
      options: SpawnOptions,
    ): ProcessHandle => {
      const key = JSON.stringify([cmd, ...args]);
      this.calls.push({
        cmd,
        args: [...args],
        provenance: options.provenance,
      });
      // Exact argv-array keys first, legacy joined strings
      // second: existing script maps keep resolving unchanged.
      const script =
        this.scriptMap.get(key) ??
        this.scriptMap.get(`${cmd} ${args.join(' ')}`);
      if (script === undefined && this.strict) {
        throw new Error(
          `fake shell: no script for argv: ${cmd} ${args.join(' ')} (strict mode — script it or pass allowUnscripted)`,
        );
      }
      const resolved = script ?? {
        exitCode: 0,
        stdout: '',
        stderr: '',
      };
      const snapshot: ProcessSnapshot = {
        stdout: resolved.stdout,
        stderr: resolved.stderr,
        exitCode: null,
      };
      return {
        pid: undefined,
        wait: () => {
          options.onUpdate?.(snapshot, undefined);
          if (options.checkpointKey && options.checkpointStore) {
            options.checkpointStore.recordFinal(options.checkpointKey, {
              ...snapshot,
              exitCode: resolved.exitCode,
            });
          }
          return Promise.resolve({
            exitCode: resolved.exitCode,
            stdout: resolved.stdout,
            stderr: resolved.stderr,
            provenance: options.provenance,
          });
        },
        kill: () => undefined,
      };
    },
  };

  constructor(
    scripts: Map<string, FakeScript> | Record<string, FakeScript>,
    provenance?: Provenance | FakeOptions,
    options: FakeOptions = {},
  ) {
    this.scriptMap =
      scripts instanceof Map ? scripts : new Map(Object.entries(scripts));
    // Options ride second so strict tests read cleanly
    // (`new FakeExecutionEnv(scripts, { strict: true })`); a Provenance
    // second keeps the old positional shape.
    if (provenance !== undefined && 'sessionId' in provenance) {
      this.provenance = provenance;
      this.strict = options.strict ?? !(options.allowUnscripted ?? false);
    } else {
      this.provenance = ROOT_PROVENANCE;
      // Strict by default: an explicit `strict` wins,
      // otherwise `allowUnscripted: true` opts out. The options may ride
      // second or third.
      const opts = provenance ?? options;
      this.strict = opts.strict ?? !(opts.allowUnscripted ?? false);
    }
  }

  withProvenance(next: Provenance): ExecutionEnv {
    const scoped = new FakeExecutionEnv(this.scriptMap, next, {
      strict: this.strict,
    });
    scoped.calls.push(...this.calls);
    for (const [k, v] of this.files) scoped.files.set(k, v);
    return scoped;
  }
}
