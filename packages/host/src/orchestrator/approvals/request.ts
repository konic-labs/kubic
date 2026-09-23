// Orchestrator approval request envelope (issue #48; §41.1 triggers,
// §63 required justification). Provenance (session/agent/role/worktree)
// travels on every request so the user dialog, audit, and trajectory can
// attribute the ask. The key is stable across restarts: same tool +
// trigger + canonical args + worktree + session + agent + justification →
// same key, so a settled decision applies and the user is never re-asked.
// Session, agent, and justification are deliberately BOUND into the key:
// an approval granted in sess-1 never authorizes sess-2 (cross-session
// replay is a key miss → fresh user prompt). Caller-supplied `key` and
// `summary` fields are never honored: the key is always recomputed and
// the display text always derived from trigger/toolName/args, so spoofed
// keys and dialog text cannot smuggle trust.
import { createHash } from 'node:crypto';

export const ORCHESTRATOR_TRIGGERS = [
  'network',
  'credentials',
  'git-push',
  'destructive-shell',
  'install',
  'deploy',
  'outside-write',
  'budget-overrun',
  'spawn-agents',
] as const;

export type OrchestratorTrigger = (typeof ORCHESTRATOR_TRIGGERS)[number];

export interface OrchestratorProvenance {
  parentSessionId: string;
  taskId?: string;
  model?: string;
}

export interface OrchestratorApprovalRequest {
  key: string;
  trigger: OrchestratorTrigger;
  toolName: string;
  summary: string;
  justification: string;
  sessionId: string;
  agentId: string;
  role: string;
  worktree: string;
  provenance: OrchestratorProvenance;
}

export interface OrchestratorRequestInput {
  trigger: string;
  toolName: string;
  args: Record<string, unknown>;
  justification: unknown;
  sessionId: string;
  agentId: string;
  role: string;
  worktree: string;
  provenance: OrchestratorProvenance;
}

export class OrchestratorRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrchestratorRequestError';
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function orchestratorRequestKey(
  toolName: string,
  trigger: OrchestratorTrigger,
  args: Record<string, unknown>,
  worktree: string,
  scope: { sessionId?: string; agentId?: string; justification?: string } = {},
): string {
  const canonical = JSON.stringify(sortKeys(args));
  const justificationHash = createHash('sha256')
    .update(scope.justification ?? '')
    .digest('hex')
    .slice(0, 16);
  return createHash('sha256')
    .update(
      `${toolName}|${trigger}|${canonical}|${worktree}|${scope.sessionId ?? ''}|${scope.agentId ?? ''}|${justificationHash}`,
    )
    .digest('hex')
    .slice(0, 16);
}

function summarize(toolName: string, trigger: string, args: unknown): string {
  if (
    typeof args === 'object' &&
    args !== null &&
    'command' in args &&
    typeof (args as Record<string, unknown>).command === 'string'
  ) {
    return `${trigger}: ${(args as Record<string, unknown>).command as string}`.slice(
      0,
      160,
    );
  }
  return `${trigger}: ${toolName}`;
}

// Justifications must carry real meaning (§63): invisible formatting
// characters (zero-width spaces, joiners, direction marks, bidi embeds
// and isolates, BOM, soft hyphen, variation selectors, and the other
// default-ignorable/format ranges) are stripped before measuring, and the
// visible remainder must reach a minimum length with real letter/digit
// content — a lone 'ok', a zero-width smuggle, a bidi-control smuggle, or
// a punctuation-only filler is refused.
export const MIN_JUSTIFICATION_LENGTH = 8;

// Minimum count of letter/digit characters (Unicode letters and numbers)
// required in the normalized justification: length alone is not meaning,
// so a punctuation-only filler ('........') is refused.
export const MIN_JUSTIFICATION_ALNUM = 4;

const INVISIBLE_FORMAT =
  /[\p{Cf}\u2000-\u200A\u2028\u2029\u2064\u2065\u3000\u115F\u1160\u3164]/gu;
// Combining-mark invisibles (variation selectors, combining grapheme
// joiner) live in their own class: mixing them with base characters in
// one class trips noMisleadingCharacterClass, and the split keeps the
// strip exact.
const INVISIBLE_MARKS = /[\u034F\uFE00-\uFE0F]/gu;

export function normalizeJustification(value: string): string {
  return value
    .replace(INVISIBLE_FORMAT, '')
    .replace(INVISIBLE_MARKS, '')
    .trim();
}

export function validateOrchestratorRequest(
  input: unknown,
): OrchestratorApprovalRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new OrchestratorRequestError(
      'orchestrator request must be an object',
    );
  }
  const record = input as unknown as Record<string, unknown> & {
    provenance?: unknown;
  };
  const trigger = record.trigger;
  if (
    typeof trigger !== 'string' ||
    !(ORCHESTRATOR_TRIGGERS as readonly string[]).includes(trigger)
  ) {
    throw new OrchestratorRequestError(
      `unknown approval trigger: ${JSON.stringify(trigger)}`,
    );
  }
  const justification = record.justification;
  if (typeof justification !== 'string') {
    throw new OrchestratorRequestError(
      'approval requires justification (§63): justification must be non-empty',
    );
  }
  const cleanJustification = normalizeJustification(justification);
  if (cleanJustification.length < MIN_JUSTIFICATION_LENGTH) {
    throw new OrchestratorRequestError(
      `approval requires justification (§63): visible justification must be at least ${MIN_JUSTIFICATION_LENGTH} characters`,
    );
  }
  const meaningful = (cleanJustification.match(/[\p{L}\p{N}]/gu) ?? []).length;
  if (meaningful < MIN_JUSTIFICATION_ALNUM) {
    throw new OrchestratorRequestError(
      `approval requires justification (§63): visible justification must contain at least ${MIN_JUSTIFICATION_ALNUM} letter/digit characters`,
    );
  }
  for (const field of ['sessionId', 'agentId', 'role'] as const) {
    const value = record[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new OrchestratorRequestError(`${field} must be a non-empty string`);
    }
  }
  const worktree = record.worktree;
  if (typeof worktree !== 'string' || !worktree.startsWith('/')) {
    throw new OrchestratorRequestError('worktree must be an absolute path');
  }
  const toolName = record.toolName;
  if (typeof toolName !== 'string' || toolName.trim().length === 0) {
    throw new OrchestratorRequestError('toolName must be a non-empty string');
  }
  const provenance = record.provenance as OrchestratorProvenance | undefined;
  if (
    typeof provenance !== 'object' ||
    provenance === null ||
    typeof provenance.parentSessionId !== 'string' ||
    provenance.parentSessionId.trim().length === 0
  ) {
    throw new OrchestratorRequestError(
      'provenance.parentSessionId must be a non-empty string',
    );
  }
  const args =
    typeof record.args === 'object' && record.args !== null
      ? (record.args as Record<string, unknown>)
      : {};
  // The key is always recomputed and the summary always derived: any
  // caller-supplied `key`/`summary` fields are ignored, never honored.
  const key = orchestratorRequestKey(
    toolName,
    trigger as OrchestratorTrigger,
    args,
    worktree,
    {
      sessionId: record.sessionId as string,
      agentId: record.agentId as string,
      justification: cleanJustification,
    },
  );
  return {
    key,
    trigger: trigger as OrchestratorTrigger,
    toolName,
    summary: summarize(toolName, trigger, args),
    justification: cleanJustification,
    sessionId: record.sessionId as string,
    agentId: record.agentId as string,
    role: record.role as string,
    worktree: worktree as string,
    provenance,
  };
}

export function buildOrchestratorRequest(
  input: OrchestratorRequestInput,
): OrchestratorApprovalRequest {
  return validateOrchestratorRequest(input);
}
