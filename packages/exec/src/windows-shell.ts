// The POSIX shell the bash tool runs through on Windows. Every approval
// detector reads POSIX shell, so commands never go to cmd or PowerShell:
// they run in Git Bash (Git for Windows) or, failing that, in WSL — where
// the detectors read exactly the language that runs. `KUBIC_BASH` names
// another bash. None found: the bash tool refuses, by name.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface PosixLauncher {
  // What the doctor names (`Git Bash`, `WSL`, the KUBIC_BASH path).
  readonly kind: string;
  readonly command: string;
  // Arguments before `-c <command>`.
  readonly prefix: readonly string[];
}

export function windowsBash(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): PosixLauncher | undefined {
  const explicit = env.KUBIC_BASH;
  if (explicit !== undefined && explicit !== '' && exists(explicit)) {
    return { kind: explicit, command: explicit, prefix: [] };
  }
  const roots = [
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.LOCALAPPDATA === undefined
      ? undefined
      : join(env.LOCALAPPDATA, 'Programs'),
  ].filter((root): root is string => root !== undefined && root !== '');
  for (const root of roots) {
    const bash = join(root, 'Git', 'bin', 'bash.exe');
    if (exists(bash)) return { kind: 'Git Bash', command: bash, prefix: [] };
  }
  const wsl = join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe');
  if (exists(wsl)) {
    // `--cd .` keeps the run's working directory inside WSL.
    return { kind: 'WSL', command: wsl, prefix: ['--cd', '.', '--', 'bash'] };
  }
  return undefined;
}
