// Orchestrator approval request envelope (issue #48; §41.1 triggers,
// §63 required justification). Provenance (session/agent/role/worktree)
// travels on every request so the user dialog, audit, and trajectory can
// attribute the ask. The key is stable across restarts: same tool +
// trigger + canonical args + worktree → same key, so a settled decision
// applies and the user is never re-asked. Ephemeral ids (session, agent,
// toolCallId) are deliberately excluded from the key.
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
): string {
  const canonical = JSON.stringify(sortKeys(args));
  return createHash('sha256')
    .update(`${toolName}|${trigger}|${canonical}|${worktree}`)
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
  if (typeof justification !== 'string' || justification.trim().length === 0) {
    throw new OrchestratorRequestError(
      'approval requires justification (§63): justification must be non-empty',
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
  const existingKey =
    typeof record.key === 'string' && /^[0-9a-f]{16}$/.test(record.key)
      ? record.key
      : orchestratorRequestKey(
          toolName,
          trigger as OrchestratorTrigger,
          args,
          worktree,
        );
  const summary =
    typeof record.summary === 'string' && record.summary.length > 0
      ? record.summary
      : summarize(toolName, trigger, args);
  return {
    key: existingKey,
    trigger: trigger as OrchestratorTrigger,
    toolName,
    summary,
    justification: (justification as string).trim(),
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
