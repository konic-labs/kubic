// The production execution environment: the Node file system and shell for
// one workspace.

import type {
  ExecutionEnv,
  FileSystem,
  Provenance,
  Shell,
} from './contracts.js';
import { ROOT_PROVENANCE } from './contracts.js';
import { NodeFileSystem } from './node-fs.js';
import { NodeShell, type ShellOptions } from './node-shell.js';

export class NodeExecutionEnv implements ExecutionEnv {
  readonly fs: FileSystem;
  readonly shell: Shell;
  readonly cwd: string;
  readonly provenance: Provenance;

  constructor(
    cwd: string,
    provenance: Provenance = ROOT_PROVENANCE,
    options: ShellOptions = {},
  ) {
    this.cwd = cwd;
    this.provenance = provenance;
    this.fs = new NodeFileSystem(cwd);
    this.shell = new NodeShell(cwd, options);
  }

  withProvenance(next: Provenance): ExecutionEnv {
    return new NodeExecutionEnv(
      this.cwd,
      next,
      (this.shell as NodeShell).options,
    );
  }
}

/**
 * `env` with `options` added to the commands it spawns (merged over what it
 * has); an environment that is not the Node one (a test fake) is returned as
 * it is.
 */
export function configuredEnv(
  env: ExecutionEnv,
  options: ShellOptions,
): ExecutionEnv {
  if (!(env instanceof NodeExecutionEnv)) return env;
  const current = (env.shell as NodeShell).options;
  return new NodeExecutionEnv(env.cwd, env.provenance, {
    ...current,
    ...options,
    toolEnv: { ...current.toolEnv, ...options.toolEnv },
  });
}
