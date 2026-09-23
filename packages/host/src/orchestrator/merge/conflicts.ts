// Conflict record + writer-resolver spawn spec (issue #46; §9.2,
// §45.2). A genuine merge conflict is never resolved by the manager:
// the spec spawns a resolver under the implementer/debugger tool set
// with the settlement constraints plus both diffs, under the SAME
// approval snapshot and policy hash the manager holds — no bypass.
// The carried snapshot is verified inside, against the manager live
// snapshot: the hash is recomputed and the snapshot is equality-checked
// (a weakened or stale policy throws), then frozen so downstream code
// cannot widen it. Pure — no spawning here, the manager lane owns the
// actual call.

import { createHash } from 'node:crypto';

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
  livePolicy: ApprovalSnapshot;
}

export class ResolverPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolverPolicyError';
  }
}

// Deterministic integrity hash over the canonical snapshot encoding.
// Catches a stale/tampered carried hash; the live-snapshot equality
// check below is the real anti-weakening guard.
export function hashApprovalPolicy(policy: ApprovalSnapshot): string {
  const canonical = JSON.stringify({
    route: policy.route,
    autoApprove: [...policy.autoApprove],
    maxPendingMs: policy.maxPendingMs,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function approvalSnapshotsEqual(
  left: ApprovalSnapshot,
  right: ApprovalSnapshot,
): boolean {
  return (
    left.route === right.route &&
    left.maxPendingMs === right.maxPendingMs &&
    left.autoApprove.length === right.autoApprove.length &&
    left.autoApprove.every((entry, index) => entry === right.autoApprove[index])
  );
}

function freezeApprovalSnapshot(policy: ApprovalSnapshot): ApprovalSnapshot {
  return Object.freeze({
    route: policy.route,
    autoApprove: Object.freeze([...policy.autoApprove]),
    maxPendingMs: policy.maxPendingMs,
  });
}

// Git C-style quoting: paths with spaces or specials arrive double-quoted
// (diff --git "a/my file.ts" "b/my file.ts"), with \" and \\ escapes.
// Unquoted sides never contain spaces, so \S+ is exact there.
const QUOTED_PATH = '"a/((?:[^"\\\\]|\\\\.)*)"\\s+"b/((?:[^"\\\\]|\\\\.)*)"';
const QUOTED_A_BARE_B = '"a/((?:[^"\\\\]|\\\\.)*)"\\s+b/(\\S+)';
const BARE_A_QUOTED_B = 'a/(\\S+)\\s+"b/((?:[^"\\\\]|\\\\.)*)"';
const BARE_PATH = 'a/(\\S+)\\s+b/(\\S+)';

function unescapeGitPath(path: string): string {
  return path.replace(/\\(.)/g, '$1');
}

function parseDiffGitPaths(rest: string): string | undefined {
  const patterns = [QUOTED_PATH, QUOTED_A_BARE_B, BARE_A_QUOTED_B, BARE_PATH];
  for (const pattern of patterns) {
    const match = new RegExp(`^${pattern}`).exec(rest);
    const raw = match?.[1];
    if (raw !== undefined) {
      return rest.trimStart().startsWith('"a/') ? unescapeGitPath(raw) : raw;
    }
  }
  return undefined;
}

// File paths touched by a unified diff. Only `diff --git` headers carry
// both sides reliably, so anything else (---/+++, log output, empty
// input) is ignored — never a crash, never a guess.
export function filesInDiff(diff: string): string[] {
  const files = new Set<string>();
  for (const rawLine of diff.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('diff --git ')) continue;
    const parsed = parseDiffGitPaths(line.slice('diff --git '.length));
    if (parsed !== undefined) files.add(parsed);
  }
  return [...files].sort();
}

export function buildResolverSpec(input: ResolverSpecInput): ResolverSpawnSpec {
  if (!(RESOLVER_ALLOWED_ROLES as readonly string[]).includes(input.role)) {
    throw new Error(
      `resolver role must be implementer or debugger (got '${input.role}'): the manager never resolves`,
    );
  }
  const recomputed = hashApprovalPolicy(input.approvalPolicy);
  if (recomputed !== input.policyHash) {
    throw new ResolverPolicyError(
      `resolver approval hash mismatch (carried '${input.policyHash}' != recomputed '${recomputed}'): re-read the manager live policy, no bypass`,
    );
  }
  if (!approvalSnapshotsEqual(input.approvalPolicy, input.livePolicy)) {
    throw new ResolverPolicyError(
      'resolver approval snapshot differs from the manager live policy (weakened or stale): no bypass',
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
    approvalPolicy: freezeApprovalSnapshot(input.approvalPolicy),
    policyHash: input.policyHash,
  };
}
