// The bash tool's OS sandbox: each command the bash tool runs is wrapped in
// Seatbelt (`sandbox-exec`) on macOS or bubblewrap (`bwrap`) on Linux, from
// the effective permission classes —
//
// - writes: the workspace, the temporary directories and the configured
//   extra paths (anywhere under `filesystem = "full"`);
// - network: none unless the class is `full`, local (Unix) sockets included —
//   Seatbelt rules them network, and under bubblewrap a seccomp filter
//   refuses them;
// - the credential paths (~/.ssh, ~/.aws, …) unreadable, and the macOS
//   keychain closed.
//
// A call the approval ask approved runs with exactly the extra access it was
// approved for: the network for a `network` approval, the credential paths
// and the keychain for a `credentials` one. Only the bash tool's commands are
// wrapped; Kubic's own process and the other spawns (git probes, gate
// commands) are not.
//
// Lives in exec: only packages/exec spawns processes and reads the disk.

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { unixSocketFilter } from './seccomp-filter.js';

export type SandboxKind = 'seatbelt' | 'bubblewrap';

/** The sandbox this machine offers, or why it offers none. */
export type SandboxDetection =
  | { readonly kind: SandboxKind; readonly binary: string }
  | { readonly kind: undefined; readonly unavailable: string };

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
  // The egress proxy's port: the one connection a command may open,
  // whatever the network class or a grant says.
  readonly proxyPort?: number;
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

// The flags every bubblewrap sandbox starts with: a new session (no
// terminal injection), its own PID namespace (which mounting /proc needs),
// and gone with Kubic.
const BWRAP_BASE = ['--die-with-parent', '--new-session', '--unshare-pid'];

/**
 * Why `binary` cannot start a sandbox on this machine — bubblewrap without
 * unprivileged user namespaces, Seatbelt inside another sandbox — or
 * undefined when it can.
 */
function startFailure(kind: SandboxKind, binary: string): string | undefined {
  const args =
    kind === 'seatbelt'
      ? ['-p', '(version 1)(allow default)', '/usr/bin/true']
      : [
          ...BWRAP_BASE,
          '--ro-bind',
          '/',
          '/',
          '--dev',
          '/dev',
          '--proc',
          '/proc',
          '--unshare-net',
          '--',
          'true',
        ];
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 10_000,
  });
  if (result.status === 0) return undefined;
  return (
    result.stderr?.trim().split('\n')[0] ||
    (result.error?.message ?? `exit ${result.status ?? result.signal}`)
  );
}

function installedSandbox(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
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

/** The sandbox this machine offers, or why it offers none. */
export function detectSandbox(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  probe: (
    kind: SandboxKind,
    binary: string,
  ) => string | undefined = startFailure,
): SandboxDetection {
  const found = installedSandbox(platform, env);
  if (found === undefined) {
    return {
      kind: undefined,
      unavailable:
        'this machine has no sandbox (Seatbelt on macOS, bubblewrap on Linux)',
    };
  }
  const failure = probe(found.kind, found.binary);
  if (failure === undefined) return found;
  return {
    kind: undefined,
    unavailable:
      found.kind === 'bubblewrap'
        ? `bubblewrap cannot start a sandbox here (it needs unprivileged user namespaces): ${failure}`
        : `Seatbelt cannot start a sandbox here: ${failure}`,
  };
}

function temporaryDirs(): string[] {
  return [...new Set([real(tmpdir()), real('/tmp')])];
}

// The keychain services: the file keychains' (SecurityServer) and the data
// protection keychain's (securityd).
const KEYCHAIN_CLOSED =
  '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc"))';

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
    // The keychain is a credential store reached over Mach, not a path.
    ...(grants.credentials === true ? [] : [KEYCHAIN_CLOSED]),
    '(allow ipc-posix-shm)',
    '(allow iokit-open)',
    '(allow file-ioctl (regex #"^/dev/tty"))',
    read,
    write,
    ...(policy.proxyPort !== undefined
      ? [`(allow network-outbound (remote ip "localhost:${policy.proxyPort}"))`]
      : policy.network || grants.network === true
        ? ['(allow network*)']
        : []),
    '',
  ].join('\n');
}

// The seccomp filter a bubblewrap command loads: the Unix-socket one unless
// the network is open — by the class or by its call's approval — and no
// egress proxy stands in for it (as under Seatbelt, where the proxy's port is
// then the one connection).
function socketFilter(
  policy: SandboxPolicy,
  grants: SandboxGrants,
): Uint8Array | undefined {
  const open =
    policy.proxyPort === undefined &&
    (policy.network || grants.network === true);
  return open ? undefined : unixSocketFilter();
}

// The fd bubblewrap reads the filter from: `BashSandbox.wrap` returns it as
// `seccomp`, and the shell writes it to the spawned command's fd 3.
const SECCOMP_FD = '3';

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
    ...BWRAP_BASE,
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
    // A separate network namespace cannot reach the egress proxy on the
    // host's loopback: with a proxy, the network is shared and the proxy
    // variables are the control.
    ...(policy.network ||
    grants.network === true ||
    policy.proxyPort !== undefined
      ? []
      : ['--unshare-net']),
    ...(socketFilter(policy, grants) === undefined
      ? []
      : ['--seccomp', SECCOMP_FD]),
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

  /**
   * The command to spawn instead of `cmd args`, and the seccomp filter to
   * write to its fd 3, which bubblewrap loads from there.
   */
  wrap(
    cmd: string,
    args: readonly string[],
    toolCallId: string,
  ): {
    readonly cmd: string;
    readonly args: string[];
    readonly seccomp?: Uint8Array;
  } {
    const policy = this.policy();
    if (policy === undefined) return { cmd, args: [...args] };
    const grants = this.grants(toolCallId);
    if (this.kind === 'seatbelt') {
      return {
        cmd: this.binary,
        args: ['-p', seatbeltProfile(policy, grants), cmd, ...args],
      };
    }
    const seccomp = socketFilter(policy, grants);
    return {
      cmd: this.binary,
      args: bubblewrapArgs(policy, grants, cmd, args),
      ...(seccomp === undefined ? {} : { seccomp }),
    };
  }
}
