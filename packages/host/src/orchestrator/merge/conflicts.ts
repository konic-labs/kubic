// Conflict record + writer-resolver spawn spec (issue #46; §9.2,
// §45.2). A genuine merge conflict is never resolved by the manager:
// the spec spawns a resolver under the implementer/debugger tool set
// with the settlement constraints plus both diffs, under the SAME
// approval snapshot and policy hash the manager holds — no bypass.
// Pure — no spawning here, the manager lane owns the actual call.

export const RESOLVER_ALLOWED_ROLES = ['implementer', 'debugger'] as const;

export type ResolverRole = (typeof RESOLVER_ALLOWED_ROLES)[number];

// Writer tool sets mirror `.kubic/roles/{implementer,debugger}.md`
// exactly (issue #44 §12): full workspace-write + shell so the
// resolver can rework the conflicted tree the manager must not touch.
export const IMPLEMENTER_TOOLSET = [
  'read',
  'ls',
  'find',
  'grep',
  'write',
  'edit',
  'bash',
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
  'git_stage',
  'git_branch',
  'git_checkpoint',
  'git_commit',
] as const;

export const DEBUGGER_TOOLSET = [
  'read',
  'ls',
  'find',
  'grep',
  'write',
  'edit',
  'bash',
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
  'git_stage',
  'git_branch',
  'git_checkpoint',
] as const;

export interface ApprovalSnapshot {
  route: string;
  autoApprove: readonly string[];
  maxPendingMs: number;
}

export interface ConflictRecord {
  agentId: string;
  files: string[];
  oursDiff: string;
  theirsDiff: string;
}

export interface ResolverSpawnSpec {
  agentId: string;
  role: ResolverRole;
  tools: readonly string[];
  constraints: string[];
  conflict: ConflictRecord;
  approvalPolicy: ApprovalSnapshot;
  policyHash: string;
}

export interface ResolverSpecInput {
  agentId: string;
  role: ResolverRole;
  constraints: string[];
  oursDiff: string;
  theirsDiff: string;
  approvalPolicy: ApprovalSnapshot;
  policyHash: string;
}

function filesInDiff(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split('\n')) {
    const match = /^diff --git a\/(\S+) b\/\S+/.exec(line.trim());
    if (match?.[1] !== undefined) files.add(match[1]);
  }
  return [...files].sort();
}

export function buildResolverSpec(input: ResolverSpecInput): ResolverSpawnSpec {
  if (!(RESOLVER_ALLOWED_ROLES as readonly string[]).includes(input.role)) {
    throw new Error(
      `resolver role must be implementer or debugger (got '${input.role}'): the manager never resolves`,
    );
  }
  const files = [
    ...new Set([
      ...filesInDiff(input.oursDiff),
      ...filesInDiff(input.theirsDiff),
    ]),
  ].sort();
  return {
    agentId: input.agentId,
    role: input.role,
    tools:
      input.role === 'implementer' ? IMPLEMENTER_TOOLSET : DEBUGGER_TOOLSET,
    constraints: [...input.constraints],
    conflict: {
      agentId: input.agentId,
      files,
      oursDiff: input.oursDiff,
      theirsDiff: input.theirsDiff,
    },
    approvalPolicy: {
      route: input.approvalPolicy.route,
      autoApprove: [...input.approvalPolicy.autoApprove],
      maxPendingMs: input.approvalPolicy.maxPendingMs,
    },
    policyHash: input.policyHash,
  };
}
