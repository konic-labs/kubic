// Conflict record + writer-resolver spawn spec (issue #46; §9.2,
// §45.2). A genuine merge conflict is never resolved by the manager:
// the spec spawns a resolver under the implementer/debugger tool set
// with the settlement constraints plus both diffs, under the SAME
// approval snapshot and policy hash the manager holds — no bypass.
// The carried snapshot is self-consistency-checked inside (the hash is
// recomputed and must equal the carried policyHash — a stale or
// tampered hash throws), then frozen so downstream code cannot widen
// it. TRUSTED-CALLER contract: authenticity of the snapshot is NOT
// established here. There is deliberately no live-policy parameter —
// any caller-supplied second snapshot could be forged in lockstep
// with a weakened policy (weakened policy + matching hash + equally
// weakened "live" snapshot would pass any in-function equality
// check), so the check would be theater. The caller — the manager
// lane composition root — MUST pass its own live snapshot as
// approvalPolicy. Pure — no spawning here, the manager lane owns the
// actual call.

import { createHash } from 'node:crypto';
import { assertReviewerReadonly } from './review.js';

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

// Git C-style path decoding. Quoted paths ("a/my file.ts") may carry
// backslash escapes: \" and \\, single-letter C escapes (\n \t \r
// \a \b \f \v), and octal byte escapes (\303\251) — git emits
// non-ASCII bytes as UTF-8, so octal escapes accumulate into a byte
// buffer decoded as UTF-8 whole. Anything else is encoded as-is.
function unquoteGitPath(quoted: string): string {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  let index = 0;
  while (index < quoted.length) {
    if (quoted[index] !== '\\') {
      for (const byte of encoder.encode(quoted[index])) bytes.push(byte);
      index += 1;
      continue;
    }
    const rest = quoted.slice(index + 1);
    if (rest.length === 0) {
      bytes.push(0x5c);
      index += 1;
      continue;
    }
    const octal = /^[0-7]{1,3}/.exec(rest);
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8) & 0xff);
      index += 1 + octal[0].length;
      continue;
    }
    switch (rest[0]) {
      case 'a':
        bytes.push(0x07);
        break;
      case 'b':
        bytes.push(0x08);
        break;
      case 'f':
        bytes.push(0x0c);
        break;
      case 'n':
        bytes.push(0x0a);
        break;
      case 'r':
        bytes.push(0x0d);
        break;
      case 't':
        bytes.push(0x09);
        break;
      case 'v':
        bytes.push(0x0b);
        break;
      case '\\':
        bytes.push(0x5c);
        break;
      case '"':
        bytes.push(0x22);
        break;
      default:
        for (const byte of encoder.encode(rest[0])) bytes.push(byte);
        break;
    }
    index += 2;
  }
  return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
}

// One `diff --git` path: either C-style quoted ("...") or bare (\S+).
// Returns the decoded path plus the unconsumed rest.
function takeGitPath(text: string): { path: string; rest: string } | undefined {
  if (text.startsWith('"')) {
    let raw = '';
    let index = 1;
    while (index < text.length) {
      const head = text[index];
      if (head === '\\') {
        raw += text.slice(index, index + 2);
        index += 2;
        continue;
      }
      if (head === '"') {
        return { path: unquoteGitPath(raw), rest: text.slice(index + 1) };
      }
      raw += head;
      index += 1;
    }
    return undefined;
  }
  const bare = /^\S+/.exec(text);
  if (bare === null) return undefined;
  return { path: bare[0], rest: text.slice(bare[0].length) };
}

// Both sides of a `diff --git a/... b/...` header, with the a-/b-
// prefixes stripped. The destination (b-side) is returned too —
// renames surface both names, never just the source.
function parseDiffGitSides(rest: string): [string, string] | undefined {
  const first = takeGitPath(rest.trimStart());
  if (first === undefined) return undefined;
  const second = takeGitPath(first.rest.trimStart());
  if (second === undefined) return undefined;
  if (!first.path.startsWith('a/') || !second.path.startsWith('b/')) {
    return undefined;
  }
  return [first.path.slice(2), second.path.slice(2)];
}

// File paths touched by a unified diff. Only `diff --git` headers carry
// both sides reliably, so anything else (---/+++, log output, empty
// input) is ignored — never a crash, never a guess.
export function filesInDiff(diff: string): string[] {
  const files = new Set<string>();
  for (const rawLine of diff.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('diff --git ')) continue;
    const sides = parseDiffGitSides(line.slice('diff --git '.length));
    if (sides !== undefined) {
      files.add(sides[0]);
      files.add(sides[1]);
    }
  }
  return [...files].sort();
}

export function buildResolverSpec(input: ResolverSpecInput): ResolverSpawnSpec {
  if (!(RESOLVER_ALLOWED_ROLES as readonly string[]).includes(input.role)) {
    throw new Error(
      `resolver role must be implementer or debugger (got '${input.role}'): the manager never resolves`,
    );
  }
  // Self-consistency only (see the TRUSTED-CALLER contract at the top):
  // the recomputed hash must equal the carried policyHash. A stale or
  // tampered hash throws; snapshot authenticity itself is the caller's
  // job — there is no second snapshot to compare against by design.
  const recomputed = hashApprovalPolicy(input.approvalPolicy);
  if (recomputed !== input.policyHash) {
    throw new ResolverPolicyError(
      `resolver approval hash mismatch (carried '${input.policyHash}' != recomputed '${recomputed}'): re-read the manager live policy, no bypass`,
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

// Resolver-dispatch path: the ONLY merge-path entry to buildResolverSpec.
// The reviewer inspects the conflict before the writer-resolver is
// dispatched, so its toolset is proven read-only first — findings travel
// back as text, never as edits. (The manager lane's own production gate
// is checkManagerCall in ../manager.ts; this assert is the merge-path
// layer, enforced on the real dispatch path rather than left opt-in.)
export function dispatchResolverSpec(
  input: ResolverSpecInput,
  reviewerTools: readonly string[],
): ResolverSpawnSpec {
  assertReviewerReadonly(reviewerTools);
  return buildResolverSpec(input);
}
