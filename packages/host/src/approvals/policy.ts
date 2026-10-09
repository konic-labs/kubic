export const CAPABILITIES = [
  'network',
  'credentials',
  'git-push',
  'destructive-shell',
  'install',
  'deploy',
  'outside-write',
  'privilege-escalation',
  'kubic-state-write',
] as const;

// Kubic's own control plane: a write into
// `<workspace>/.kubic/` could widen the model's future permissions (config,
// roles) or corrupt the state `kubic undo`/`kubic audit` rest on. The model
// never decides its own permissions, so this capability ALWAYS asks — no
// autoApprove entry and no full-access posture answers it.
export const KUBIC_STATE_WRITE = 'kubic-state-write';
export const ALWAYS_ASK: ReadonlySet<string> = new Set([KUBIC_STATE_WRITE]);

// The `autoApprove` entries that can never apply because the capability
// always asks. Config keeps accepting them (rejecting would break
// an existing config that never worked); `kubic doctor` and `kubic config`
// name them instead of counting them as auto-approved.
export function alwaysAskAutoApprove(autoApprove: readonly string[]): string[] {
  return autoApprove.filter((capability) => ALWAYS_ASK.has(capability));
}

export type Capability = (typeof CAPABILITIES)[number] | string;

export interface ApprovalPolicy {
  route: 'ask-user' | 'deny';
  autoApprove: Capability[];
  sessionScoped: boolean;
  maxPendingMs: number;
  requireJustification: boolean;
}

export class PolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyValidationError';
  }
}

// autoApprove is explicit-only: it defaults to empty and must arrive as an
// explicit array. A model cannot infer or inject it because nothing on the
// tool path can supply policy — it comes from config alone.
export function validatePolicy(input: unknown): ApprovalPolicy {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new PolicyValidationError('approval policy must be an object');
  }
  const record = input as Record<string, unknown>;
  const route = record.route ?? 'ask-user';
  if (route !== 'ask-user' && route !== 'deny') {
    throw new PolicyValidationError(`invalid route: ${JSON.stringify(route)}`);
  }
  const autoApprove = record.autoApprove ?? [];
  if (
    !Array.isArray(autoApprove) ||
    !autoApprove.every((entry) => typeof entry === 'string')
  ) {
    throw new PolicyValidationError(
      'autoApprove must be an explicit string array',
    );
  }
  const maxPendingMs = record.maxPendingMs ?? 60_000;
  if (typeof maxPendingMs !== 'number' || !(maxPendingMs > 0)) {
    throw new PolicyValidationError('maxPendingMs must be a positive number');
  }
  return {
    route,
    autoApprove: [...autoApprove],
    sessionScoped:
      typeof record.sessionScoped === 'boolean' ? record.sessionScoped : true,
    maxPendingMs,
    requireJustification:
      typeof record.requireJustification === 'boolean'
        ? record.requireJustification
        : false,
  };
}

// The `by` a seat answers for a single-call approval (the TUI overlay's 'a'):
// approved, audited, never latched or persisted.
export const ALLOW_ONCE = 'allow-once';
// The `by` for "allow all edits this turn" — this call, and the
// edit/write asks of the same kind until the turn ends; never latched.
export const ALLOW_TURN_EDITS = 'allow-turn-edits';

export type ApprovalVerdict =
  | {
      approved: true;
      by: string;
      justified?: boolean;
      // The operator rewrote the command before allowing it; the
      // rewritten call is judged again from the start.
      edited?: { command: string };
    }
  | { approved: false; reason: string };
