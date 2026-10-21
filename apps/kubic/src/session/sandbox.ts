// The boot's sandbox step: under `[sandbox] mode = "auto"` or `"required"`,
// the bash tool's commands run in this machine's OS sandbox, from the
// installed permission classes; each approved call gets the access it was
// approved for. Without a sandbox, `required` refuses the boot and `auto`
// says so once and runs unconfined.

import { homedir } from 'node:os';
import { effectiveNetworkLevel } from '@kubic/agent/permissions';
import type { ExecutionEnv } from '@kubic/exec/env';
import { sandboxedEnv } from '@kubic/exec/env';
import {
  BashSandbox,
  credentialPaths,
  detectSandbox,
} from '@kubic/exec/sandbox';
import type { BootRefusal, SessionBoot } from './bootstrap.js';

export function bootSandbox(
  boot: SessionBoot,
  env: ExecutionEnv,
): ExecutionEnv | BootRefusal {
  const config = boot.config.sandbox;
  if (config === undefined || config.mode === 'off') return env;
  const found = detectSandbox();
  if (found === undefined) {
    if (config.mode === 'required') {
      return {
        kind: 'failed',
        message:
          'sandbox: [sandbox] mode = "required", but this machine has no sandbox (Seatbelt on macOS, bubblewrap on Linux)',
      };
    }
    boot.sinks.warn(
      'sandbox: [sandbox] mode = "auto", but this machine has no sandbox: bash commands run unconfined',
    );
    return env;
  }
  const installed = boot.requireInstalled();
  const classes = installed.classes;
  const policy = {
    workspace: env.cwd,
    writable: [...config.writable],
    writeAnywhere: classes.filesystem === 'full',
    network: effectiveNetworkLevel(classes.network) === 'full',
    hidden: credentialPaths(homedir()),
  };
  boot.sandboxKind = found.kind;
  return sandboxedEnv(
    env,
    new BashSandbox({
      kind: found.kind,
      binary: found.binary,
      policy: () => policy,
      grants: (toolCallId) => {
        const granted = installed.grantsFor?.(toolCallId) ?? [];
        return {
          network: granted.includes('network'),
          credentials: granted.includes('credentials'),
        };
      },
    }),
  );
}
