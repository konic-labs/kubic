// The bash tool's OS sandbox: each command the bash tool runs is wrapped in
// Seatbelt (`sandbox-exec`) on macOS or bubblewrap (`bwrap`) on Linux, from
// the effective permission classes —
//
// - writes: the workspace, the temporary directories and the configured
//   extra paths (anywhere under `filesystem = "full"`);
// - network: none unless the class is `full`;
// - the credential paths (~/.ssh, ~/.aws, …) unreadable.
//
// A call the approval ask approved runs with exactly the extra access it was
// approved for: the network for a `network` approval, the credential paths
// for a `credentials` one. Only the bash tool's commands are wrapped; Kubic's
// own process and the other spawns (git probes, gate commands) are not.
//
// Lives in exec: only packages/exec spawns processes and reads the disk.

import { existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

export type SandboxKind = 'seatbelt' | 'bubblewrap';

export interface SandboxPolicy {
  readonly workspace: string;
  // Writable beside the workspace and the temporary directories.
  readonly writable: readonly string[];
  // `filesystem = "full"`: writes anywhere.
  readonly writeAnywhere: boolean;
  readonly network: boolean;
  // Paths a command cannot read (the credential paths).
  readonly hidden: readonly string[];
  // The temporary directories a command may write; absent: this machine's.
  readonly temporary?: readonly string[];
}

export interface SandboxGrants {
  readonly network?: boolean;
  readonly credentials?: boolean;
}

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** The credential paths under `home` a sandboxed command cannot read. */
export function credentialPaths(home: string = homedir()): string[] {
  return [
    '.ssh',
    '.aws',
    '.azure',
    '.config/gcloud',
    '.kube',
    '.docker',
    '.gnupg',
    '.netrc',
    '.git-credentials',
    '.config/gh',
    '.npmrc',
    '.pypirc',
    '.cargo/credentials.toml',
    '.terraform.d/credentials.tfrc.json',
    '.pi',
  ].map((relative) => join(home, relative));
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function onPath(binary: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, binary);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** The sandbox this machine offers, or undefined. */
export function detectSandbox(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { readonly kind: SandboxKind; readonly binary: string } | undefined {
  if (platform === 'darwin' && existsSync(SANDBOX_EXEC)) {
    return { kind: 'seatbelt', binary: SANDBOX_EXEC };
  }
  if (platform === 'linux') {
    const bwrap = onPath('bwrap', env);
    if (bwrap !== undefined) return { kind: 'bubblewrap', binary: bwrap };
  }
  return undefined;
}

function temporaryDirs(): string[] {
  return [...new Set([real(tmpdir()), real('/tmp')])];
}

// SBPL string literal.
function quoted(path: string): string {
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The Seatbelt profile for one command.
 * @internal
 */
export function seatbeltProfile(
  policy: SandboxPolicy,
  grants: SandboxGrants = {},
): string {
  const hidden = grants.credentials === true ? [] : policy.hidden.map(real);
  const writable = [
    real(policy.workspace),
    ...(policy.temporary ?? [...temporaryDirs(), '/private/var/folders']).map(
      real,
    ),
    ...policy.writable.map(real),
  ];
  const read =
    hidden.length === 0
      ? '(allow file-read*)'
      : `(allow file-read* (require-not (require-any ${hidden.map((path) => `(subpath ${quoted(path)})`).join(' ')})))`;
  const write = policy.writeAnywhere
    ? '(allow file-write*)'
    : `(allow file-write* ${writable.map((path) => `(subpath ${quoted(path)})`).join(' ')} (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/tty") (regex #"^/dev/fd/"))`;
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow process-info* (target same-sandbox))',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow ipc-posix-shm)',
    '(allow iokit-open)',
    '(allow file-ioctl (regex #"^/dev/tty"))',
    read,
    write,
    ...(policy.network || grants.network === true ? ['(allow network*)'] : []),
    '',
  ].join('\n');
}

/**
 * The bubblewrap arguments that run `cmd args` sandboxed.
 * @internal
 */
export function bubblewrapArgs(
  policy: SandboxPolicy,
  grants: SandboxGrants,
  cmd: string,
  args: readonly string[],
): string[] {
  const hidden =
    grants.credentials === true
      ? []
      : policy.hidden.filter((path) => existsSync(path));
  const writable = [
    policy.workspace,
    ...(policy.temporary ?? temporaryDirs()),
    ...policy.writable,
  ]
    .filter((path) => existsSync(path))
    .flatMap((path) => ['--bind', path, path]);
  return [
    '--die-with-parent',
    '--new-session',
    ...(policy.writeAnywhere ? ['--bind', '/', '/'] : ['--ro-bind', '/', '/']),
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    ...(policy.writeAnywhere ? [] : writable),
    ...hidden.flatMap((path) =>
      existsSync(join(path, '.')) &&
      !path.endsWith('.toml') &&
      !path.endsWith('.json')
        ? ['--tmpfs', path]
        : ['--ro-bind', '/dev/null', path],
    ),
    ...(policy.network || grants.network === true ? [] : ['--unshare-net']),
    '--chdir',
    policy.workspace,
    '--',
    cmd,
    ...args,
  ];
}

/**
 * The sandbox the bash tool's commands run in: its policy is read when a
 * command is wrapped (the boot settles it after the classes are known), and
 * each call's grants come from what its approval allowed.
 */
export class BashSandbox {
  readonly kind: SandboxKind;
  private readonly binary: string;
  private readonly policy: () => SandboxPolicy | undefined;
  private readonly grants: (toolCallId: string) => SandboxGrants;

  constructor(options: {
    readonly kind: SandboxKind;
    readonly binary: string;
    readonly policy: () => SandboxPolicy | undefined;
    readonly grants?: (toolCallId: string) => SandboxGrants;
  }) {
    this.kind = options.kind;
    this.binary = options.binary;
    this.policy = options.policy;
    this.grants = options.grants ?? (() => ({}));
  }

  /** The command to spawn instead of `cmd args`. */
  wrap(
    cmd: string,
    args: readonly string[],
    toolCallId: string,
  ): { readonly cmd: string; readonly args: string[] } {
    const policy = this.policy();
    if (policy === undefined) return { cmd, args: [...args] };
    const grants = this.grants(toolCallId);
    if (this.kind === 'seatbelt') {
      return {
        cmd: this.binary,
        args: ['-p', seatbeltProfile(policy, grants), cmd, ...args],
      };
    }
    return {
      cmd: this.binary,
      args: bubblewrapArgs(policy, grants, cmd, args),
    };
  }
}
