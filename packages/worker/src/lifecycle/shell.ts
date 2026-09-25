// Shell seam with an explicit child env (issue #94; §3.8).
//
// The exec Shell seam (packages/exec, the only package allowed to spawn)
// has no `env` field: its child inherits the ambient environment. The §3.8
// rule ("agent processes never inherit ambient authority") needs the
// allowlist to reach the OS, so this wrapper carries the filtered env
// alongside SpawnOptions and hands the child to `env -i …` — the OS starts
// the worker with EXACTLY the allowlisted variables plus its role grant,
// never the parent's environment.
//
// `env` execs the target in place, so the process group the exec shell
// kills stays the child's own group: teardown semantics are unchanged.
// POSIX only (`env` is coreutils/BSD userland; Kubic targets macOS + Linux).

import type {
  ProcessHandle,
  Shell,
  SpawnOptions,
} from '../../../exec/src/env.js';
import type { WorkerShell } from './spawn.js';

export function allowlistedShell(inner: Shell): WorkerShell {
  return {
    spawn(
      cmd: string,
      args: string[],
      options: SpawnOptions & { env: Record<string, string> },
    ): ProcessHandle {
      const assignments = Object.entries(options.env).map(
        ([key, value]) => `${key}=${value}`,
      );
      const spawnOptions: SpawnOptions = {
        provenance: options.provenance,
        ...(options.onUpdate === undefined
          ? {}
          : { onUpdate: options.onUpdate }),
        ...(options.checkpointKey === undefined
          ? {}
          : { checkpointKey: options.checkpointKey }),
        ...(options.checkpointStore === undefined
          ? {}
          : { checkpointStore: options.checkpointStore }),
      };
      return inner.spawn(
        'env',
        ['-i', ...assignments, cmd, ...args],
        spawnOptions,
      );
    },
  };
}
