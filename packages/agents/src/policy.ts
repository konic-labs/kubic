// Tool permission policy model (issue #15; §40). Layer-1 policy, not a
// boundary: in solo mode this is the only thing shaping the tool set.
// Classes declare intent; toolsForClasses derives the allowlist;
// checkAgreement refuses contradictions with named reasons, never silent.
export const FILESYSTEM_LEVELS = [
  'none',
  'read',
  'workspace-write',
  'full',
] as const;
export type FilesystemLevel = (typeof FILESYSTEM_LEVELS)[number];

export const SHELL_LEVELS = [false, 'read-only-allowlist', true] as const;
export type ShellLevel = (typeof SHELL_LEVELS)[number];

export const NETWORK_LEVELS = ['none', 'allowlist', 'full'] as const;
export type NetworkLevel = (typeof NETWORK_LEVELS)[number];

export const GIT_LEVELS = [false, 'workspace', 'full'] as const;
export type GitLevel = (typeof GIT_LEVELS)[number];

export const CREDENTIAL_LEVELS = ['none', 'allowlist'] as const;
export type CredentialLevel = (typeof CREDENTIAL_LEVELS)[number];

export interface PermissionClasses {
  filesystem: FilesystemLevel;
  shell: ShellLevel;
  network: NetworkLevel;
  git: GitLevel;
  credentials: CredentialLevel;
}

// §12.1 solo defaults; unlisted classes default to most restrictive.
export const SOLO_DEFAULTS: PermissionClasses = {
  filesystem: 'workspace-write',
  shell: true,
  network: 'none',
  git: 'workspace',
  credentials: 'none',
};

const FS_READ_TOOLS = ['read', 'ls', 'find', 'grep'];
const FS_WRITE_TOOLS = ['write', 'edit'];
// Read-only git tools are safe to replay; effect tools (stage/commit/
// checkpoint) mutate the repo but stay inside it — no init, no push tool.
const GIT_READ_TOOLS = ['git_status', 'git_diff', 'git_log', 'git_show'];
const GIT_WRITE_TOOLS = ['git_stage', 'git_commit', 'git_branch', 'git_checkpoint'];

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

export function validateClasses(input: unknown): PermissionClasses {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new PolicyValidationError('permission classes must be an object');
  }
  const record = input as Record<string, unknown>;
  // Partial input merges over SOLO_DEFAULTS (§12.1: unlisted classes take
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
      SOLO_DEFAULTS.filesystem,
    ) as FilesystemLevel,
    shell: pick('shell', SHELL_LEVELS, SOLO_DEFAULTS.shell) as ShellLevel,
    network: pick(
      'network',
      NETWORK_LEVELS,
      SOLO_DEFAULTS.network,
    ) as NetworkLevel,
    git: pick('git', GIT_LEVELS, SOLO_DEFAULTS.git) as GitLevel,
    credentials: pick(
      'credentials',
      CREDENTIAL_LEVELS,
      SOLO_DEFAULTS.credentials,
    ) as CredentialLevel,
  };
}

export class PolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyValidationError';
  }
}
