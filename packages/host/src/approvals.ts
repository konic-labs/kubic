// Approval triggers, policy, and durable decider service (issue #16; §41).
// The decider is the user — never a manager, never the model. There is no
// manager-approval path in solo: this module exposes no role/manager
// override, structurally, not by flag.
// Outcomes deny on timeout and never hang headless: every ask is bounded
// by maxPendingMs. First answer wins (memoOnce semantics); late attach
// discovers pending requests through the same service.
export const CAPABILITIES = [
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
  const route = record['route'] ?? 'ask-user';
  if (route !== 'ask-user' && route !== 'deny') {
    throw new PolicyValidationError(`invalid route: ${JSON.stringify(route)}`);
  }
  const autoApprove = record['autoApprove'] ?? [];
  if (!Array.isArray(autoApprove) || !autoApprove.every((entry) => typeof entry === 'string')) {
    throw new PolicyValidationError('autoApprove must be an explicit string array');
  }
  const maxPendingMs = record['maxPendingMs'] ?? 60_000;
  if (typeof maxPendingMs !== 'number' || !(maxPendingMs > 0)) {
    throw new PolicyValidationError('maxPendingMs must be a positive number');
  }
  return {
    route,
    autoApprove: [...autoApprove],
    sessionScoped: record['sessionScoped'] ?? true,
    maxPendingMs,
    requireJustification: record['requireJustification'] ?? false,
  };
}

export interface ApprovalRequest {
  key: string;
  capability: Capability;
  toolName: string;
  summary: string;
  justification?: string;
}

export type ApprovalVerdict =
  | { approved: true; by: string }
  | { approved: false; reason: string };

export interface ApprovalStore {
  load(): Record<string, ApprovalVerdict>;
  save(decisions: Record<string, ApprovalVerdict>): void;
}

export class MemoryApprovalStore implements ApprovalStore {
  private decisions: Record<string, ApprovalVerdict> = {};
  load(): Record<string, ApprovalVerdict> {
    return { ...this.decisions };
  }
  save(decisions: Record<string, ApprovalVerdict>): void {
    this.decisions = { ...decisions };
  }
}

export interface ApprovalServiceOptions {
  policy: ApprovalPolicy;
  store?: ApprovalStore;
  // Resolves the pending request when a user answers. Never resolves on
  // its own in headless runs — the wait below times out into a denial.
  awaitAnswer?: (request: ApprovalRequest) => Promise<ApprovalVerdict | undefined>;
  clock?: () => number;
}

export class ApprovalService {
  private readonly policy: ApprovalPolicy;
  private readonly store: ApprovalStore;
  private readonly awaitAnswer?: (request: ApprovalRequest) => Promise<ApprovalVerdict | undefined>;
  private readonly decisions: Map<string, ApprovalVerdict>;
  private readonly pending = new Map<string, ApprovalRequest>();
  private readonly waiters = new Map<string, (verdict: ApprovalVerdict | undefined) => void>();

  constructor(options: ApprovalServiceOptions) {
    this.policy = options.policy;
    this.store = options.store ?? new MemoryApprovalStore();
    this.awaitAnswer = options.awaitAnswer;
    this.decisions = new Map(Object.entries(this.store.load()));
  }

  pendingRequests(): ApprovalRequest[] {
    return [...this.pending.values()];
  }

  decided(key: string): ApprovalVerdict | undefined {
    return this.decisions.get(key);
  }

  // First answer wins: a stored decision is returned untouched and a late
  // submit for a settled key is ignored (memoOnce semantics).
  submit(request: ApprovalRequest, verdict: ApprovalVerdict): ApprovalVerdict {
    const existing = this.decisions.get(request.key);
    if (existing !== undefined) return existing;
    if (this.policy.requireJustification && verdict.approved && request.justification === undefined) {
      return { approved: false, reason: 'approval requires justification' };
    }
    this.decisions.set(request.key, verdict);
    this.persist();
    this.pending.delete(request.key);
    this.waiters.get(request.key)?.(verdict);
    this.waiters.delete(request.key);
    return verdict;
  }

  async request(request: ApprovalRequest): Promise<ApprovalVerdict> {
    const existing = this.decisions.get(request.key);
    if (existing !== undefined) return existing;
    if (this.policy.autoApprove.includes(request.capability)) {
      return this.submit(request, { approved: true, by: 'autoApprove' });
    }
    if (this.policy.route === 'deny') {
      return this.submit(request, {
        approved: false,
        reason: `denied by policy route (capability: ${request.capability})`,
      });
    }
    this.pending.set(request.key, request);
    try {
      const answer = await this.waitForAnswer(request);
      if (answer === undefined) {
        return this.submit(request, {
          approved: false,
          reason: `approval timed out after ${this.policy.maxPendingMs}ms`,
        });
      }
      return this.submit(request, answer);
    } finally {
      this.pending.delete(request.key);
    }
  }

  private waitForAnswer(request: ApprovalRequest): Promise<ApprovalVerdict | undefined> {
    const answer = this.awaitAnswer?.(request);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), this.policy.maxPendingMs);
      timer.unref?.();
    });
    const notified = new Promise<ApprovalVerdict | undefined>((resolve) => {
      this.waiters.set(request.key, resolve);
    });
    const done = (value: ApprovalVerdict | undefined): ApprovalVerdict | undefined => {
      if (timer !== undefined) clearTimeout(timer);
      this.waiters.delete(request.key);
      return value;
    };
    if (answer === undefined) return timeout.then(done);
    return Promise.race([answer, timeout, notified]).then(done);
  }

  private persist(): void {
    this.store.save(Object.fromEntries(this.decisions));
  }
}
