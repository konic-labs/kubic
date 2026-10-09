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
import { NodeShell } from './node-shell.js';

export class NodeExecutionEnv implements ExecutionEnv {
  readonly fs: FileSystem;
  readonly shell: Shell;
  readonly cwd: string;
  readonly provenance: Provenance;

  constructor(cwd: string, provenance: Provenance = ROOT_PROVENANCE) {
    this.cwd = cwd;
    this.provenance = provenance;
    this.fs = new NodeFileSystem(cwd);
    this.shell = new NodeShell(cwd);
  }

  withProvenance(next: Provenance): ExecutionEnv {
    return new NodeExecutionEnv(this.cwd, next);
  }
}
