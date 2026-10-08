// Tool permission policy model. Layer-1 policy, not a
// boundary: in solo mode this is the only thing shaping the tool set.
// Classes declare intent; toolsForClasses derives the allowlist;
// checkAgreement refuses contradictions with named reasons, never silent.
export const FILESYSTEM_LEVELS = [
  'none',
  'read',
  'workspace-write',
  'full',
] as const;
type FilesystemLevel = (typeof FILESYSTEM_LEVELS)[number];

export const SHELL_LEVELS = [false, 'read-only-allowlist', true] as const;
export type ShellLevel = (typeof SHELL_LEVELS)[number];

export const NETWORK_LEVELS = ['none', 'allowlist', 'full'] as const;
export type NetworkLevel = (typeof NETWORK_LEVELS)[number];

export const GIT_LEVELS = [false, 'workspace', 'full'] as const;
type GitLevel = (typeof GIT_LEVELS)[number];

export const CREDENTIAL_LEVELS = ['none', 'allowlist'] as const;
export type CredentialLevel = (typeof CREDENTIAL_LEVELS)[number];

export interface PermissionClasses {
  filesystem: FilesystemLevel;
  shell: ShellLevel;
  network: NetworkLevel;
  git: GitLevel;
  credentials: CredentialLevel;
}

// Solo defaults; unlisted classes default to most restrictive.
export const DEFAULT_PERMISSIONS: PermissionClasses = {
  filesystem: 'workspace-write',
  shell: true,
  network: 'none',
  git: 'workspace',
  credentials: 'none',
};

const FS_READ_TOOLS = ['read', 'ls', 'find', 'grep'];
const FS_WRITE_TOOLS = ['write', 'edit'];
// Read-only git tools are safe to replay; effect tools (stage/commit/
// branch/checkpoint/merge) mutate the repo but stay inside it — no init,
// no push tool.
const GIT_READ_TOOLS = [
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
  'git_conflict_status',
  'git_worktree_list',
];
const GIT_WRITE_TOOLS = [
  'git_stage',
  'git_commit',
  'git_branch',
  'git_checkpoint',
  'git_merge',
];

export function toolsForClasses(classes: PermissionClasses): string[] {
  const tools: string[] = [];
  if (
    classes.filesystem === 'read' ||
    classes.filesystem === 'workspace-write' ||
    classes.filesystem === 'full'
  ) {
    tools.push(...FS_READ_TOOLS);
  }
  if (
    classes.filesystem === 'workspace-write' ||
    classes.filesystem === 'full'
  ) {
    tools.push(...FS_WRITE_TOOLS);
  }
  if (classes.shell === 'read-only-allowlist' || classes.shell === true) {
    tools.push('bash');
  }
  if (classes.git === 'workspace' || classes.git === 'full') {
    tools.push(...GIT_READ_TOOLS, ...GIT_WRITE_TOOLS);
  }
  return tools;
}

export type AgreementCheck = { agree: true } | { agree: false; reason: string };

export function checkAgreement(
  classes: PermissionClasses,
  toolNames: string[],
): AgreementCheck {
  const has = (name: string): boolean => toolNames.includes(name);
  if (classes.filesystem === 'none') {
    const leaked = [...FS_READ_TOOLS, ...FS_WRITE_TOOLS].find((name) =>
      has(name),
    );
    if (leaked !== undefined) {
      return {
        agree: false,
        reason: `filesystem is 'none' but tool '${leaked}' is registered`,
      };
    }
  }
  if (classes.filesystem === 'read') {
    const leaked = FS_WRITE_TOOLS.find((name) => has(name));
    if (leaked !== undefined) {
      return {
        agree: false,
        reason: `filesystem is 'read' but write tool '${leaked}' is registered`,
      };
    }
  }
  if (classes.shell === false && has('bash')) {
    return {
      agree: false,
      reason: `shell is disabled but tool 'bash' is registered`,
    };
  }
  if (classes.git === false) {
    const leaked = [...GIT_READ_TOOLS, ...GIT_WRITE_TOOLS].find((name) =>
      has(name),
    );
    if (leaked !== undefined) {
      return {
        agree: false,
        reason: `git is disabled but tool '${leaked}' is registered`,
      };
    }
  }
  return { agree: true };
}

// Grantability: the lane can only allowlist tools that are actually
// registered. A class demanding an absent tool is refused with a named
// reason, never silently narrowed.
export function checkGrantable(
  classes: PermissionClasses,
  registeredNames: string[],
): AgreementCheck {
  const missing = toolsForClasses(classes).find(
    (name) => !registeredNames.includes(name),
  );
  if (missing !== undefined) {
    return {
      agree: false,
      reason: `permission classes require tool '${missing}' which is not registered`,
    };
  }
  return { agree: true };
}

// A level the tool set cannot express is reported as
// unsupported, never silently widened. Each entry names the class, the
// declared level, the level the lane actually enforces, and why.
export interface UnsupportedLevel {
  class: keyof PermissionClasses;
  level: string;
  enforcedAs: string;
  reason: string;
}

// The network level the guards enforce. `allowlist` carries no domain list
// (PermissionClasses has nowhere to put one), and an allowlist naming no
// domains allows nothing — so it is enforced as `none`: every network verb
// is blocked by the guard and raises the network approval trigger. Never
// the unrestricted `full` level (false confidence).
export function effectiveNetworkLevel(level: NetworkLevel): NetworkLevel {
  return level === 'allowlist' ? 'none' : level;
}

// The credentials level the lane enforces (mirroring
// effectiveNetworkLevel). `allowlist` carries no
// credential list and no credential tool exists, so it is enforced as
// `none` — the credential-path detector stays gated and every credential
// access raises the trigger, never the unrestricted access the level name
// implies.
export function effectiveCredentialLevel(
  level: CredentialLevel,
): CredentialLevel {
  return level === 'allowlist' ? 'none' : level;
}

export function checkExpressible(
  classes: PermissionClasses,
): UnsupportedLevel[] {
  const found: UnsupportedLevel[] = [];
  if (classes.filesystem === 'full') {
    found.push({
      class: 'filesystem',
      level: 'full',
      enforcedAs: 'workspace-write',
      reason:
        'no outside-workspace write tool exists; writes stay confined to the workspace (outside paths raise outside-write)',
    });
  }
  if (classes.network === 'allowlist') {
    found.push({
      class: 'network',
      level: 'allowlist',
      enforcedAs: 'none',
      reason:
        'no domain list can be supplied, and an empty allowlist allows nothing; every network command is blocked and raises the network trigger',
    });
  }
  if (classes.git === 'full') {
    found.push({
      class: 'git',
      level: 'full',
      enforcedAs: 'workspace',
      reason:
        'the git tools only act inside the workspace repository (no push/init tool); full grants nothing beyond workspace',
    });
  }
  if (classes.credentials === 'allowlist') {
    found.push({
      class: 'credentials',
      level: 'allowlist',
      enforcedAs: 'none',
      reason:
        'no credential list can be supplied and no credential tool exists; no credential is granted',
    });
  }
  return found;
}

// One human line per unsupported level, shared by doctor and `kubic policy`
// so the two surfaces name the same thing in the same words.
export function describeUnsupported(entry: {
  readonly class: string;
  readonly level: string;
  readonly enforcedAs: string;
  readonly reason: string;
}): string {
  return `${entry.class} '${entry.level}' is unsupported — enforced as '${entry.enforcedAs}': ${entry.reason}`;
}

export function validateClasses(input: unknown): PermissionClasses {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new PolicyValidationError('permission classes must be an object');
  }
  const record = input as Record<string, unknown>;
  // Partial input merges over SOLO_DEFAULTS (unlisted classes take
  // the solo default; the restrictive tail — network none, credentials
  // none — is what makes that safe).
  const pick = (
    key: string,
    allowed: readonly unknown[],
    fallback: unknown,
  ): unknown => {
    const value = record[key] === undefined ? fallback : record[key];
    if (!allowed.includes(value)) {
      throw new PolicyValidationError(
        `invalid ${key}: ${JSON.stringify(value)}`,
      );
    }
    return value;
  };
  return {
    filesystem: pick(
      'filesystem',
      FILESYSTEM_LEVELS,
      DEFAULT_PERMISSIONS.filesystem,
    ) as FilesystemLevel,
    shell: pick('shell', SHELL_LEVELS, DEFAULT_PERMISSIONS.shell) as ShellLevel,
    network: pick(
      'network',
      NETWORK_LEVELS,
      DEFAULT_PERMISSIONS.network,
    ) as NetworkLevel,
    git: pick('git', GIT_LEVELS, DEFAULT_PERMISSIONS.git) as GitLevel,
    credentials: pick(
      'credentials',
      CREDENTIAL_LEVELS,
      DEFAULT_PERMISSIONS.credentials,
    ) as CredentialLevel,
  };
}

export class PolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyValidationError';
  }
}

// A run's mode: `autonomous` only when the user asked for it explicitly
// (`--autonomous`), `interactive` otherwise. Recorded on the session and in
// the audit trail.
export type RunMode = 'autonomous' | 'interactive';
