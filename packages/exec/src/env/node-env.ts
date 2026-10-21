// The production execution environment: the Node file system and shell for
// one workspace.

import type { BashSandbox } from '../sandbox.js';
import type {
  ExecutionEnv,
  FileSystem,
  Provenance,
  Shell,
} from './contracts.js';
import { ROOT_PROVENANCE } from './contracts.js';
import { NodeFileSystem } from './node-fs.js';
import { NodeShell } from './node-shell.js';

export class NodeExecutionEnv implements ExecutionEnv {
  readonly fs: FileSystem;
  readonly shell: Shell;
  readonly cwd: string;
  readonly provenance: Provenance;

  constructor(
    cwd: string,
    provenance: Provenance = ROOT_PROVENANCE,
    sandbox?: BashSandbox,
  ) {
    this.cwd = cwd;
    this.provenance = provenance;
    this.fs = new NodeFileSystem(cwd);
    this.shell = new NodeShell(cwd, sandbox);
  }

  withProvenance(next: Provenance): ExecutionEnv {
    return new NodeExecutionEnv(
      this.cwd,
      next,
      (this.shell as NodeShell).sandbox,
    );
  }
}

/**
 * `env` with its bash commands run in `sandbox`; an environment that is not
 * the Node one (a test fake) is returned as it is.
 */
export function sandboxedEnv(
  env: ExecutionEnv,
  sandbox: BashSandbox,
): ExecutionEnv {
  return env instanceof NodeExecutionEnv
    ? new NodeExecutionEnv(env.cwd, env.provenance, sandbox)
    : env;
}
