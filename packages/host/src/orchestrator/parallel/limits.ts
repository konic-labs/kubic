// Parallel limits (issue #47; §45, §71, §81).
// Pure admission predicates for controlled parallel workers: default
// concurrency 4 (per-session overridable), mem/disk aggregates, per-provider
// concurrency/rate caps, and opt-in budget gates. Every gate with an absent
// config admits — §71 ships no defaults, so "unconfigured" never blocks.
// No I/O, no clock, no network (faux-only); the scheduler owns time/queue.

export const DEFAULT_MAX_CONCURRENCY = 4;

export class ParallelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParallelConfigError';
  }
}

export interface AggregateCaps {
  maxMemMb?: number;
  maxDiskMb?: number;
}

export interface ProviderCap {
  maxConcurrent?: number;
  maxPerWindow?: number;
  windowMs?: number;
}

export type ProviderCaps = Record<string, ProviderCap>;

export interface BudgetGate {
  maxCostUsd?: number;
  maxTokens?: number;
  maxToolCalls?: number;
  maxRuntimeMs?: number;
}

export interface ParallelLimits {
  maxConcurrency?: number;
  workerCapacity?: number;
  aggregates?: AggregateCaps;
  providerCaps?: ProviderCaps;
  budgetGate?: BudgetGate;
  approvalCapacity?: number;
  maxPendingMs?: number;
}

export interface ResourceEstimate {
  memMb?: number;
  diskMb?: number;
}

export interface UsageTally {
  costUsd?: number;
  tokens?: number;
  toolCalls?: number;
  runtimeMs?: number;
}

export type GateVerdict =
  | { admitted: true }
  | { admitted: false; reason: string };

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

// Default 4; a per-session override wins over the session config. Invalid
// values throw — silently substituting a default would hide misconfig.
export function resolveMaxConcurrency(
  limits?: ParallelLimits,
  sessionOverride?: number,
): number {
  if (sessionOverride !== undefined) {
    if (!isPositiveInt(sessionOverride)) {
      throw new ParallelConfigError(
        `session maxConcurrency override must be a positive integer (got ${String(sessionOverride)})`,
      );
    }
    return sessionOverride;
  }
  const configured = limits?.maxConcurrency;
  if (configured === undefined) return DEFAULT_MAX_CONCURRENCY;
  if (!isPositiveInt(configured)) {
    throw new ParallelConfigError(
      `maxConcurrency must be a positive integer (got ${String(configured)})`,
    );
  }
  return configured;
}

// Worker slots default to the resolved concurrency when unconfigured —
// one admission surface, not two independent defaults.
export function resolveWorkerCapacity(
  limits?: ParallelLimits,
  sessionOverride?: number,
): number {
  const configured = limits?.workerCapacity;
  if (configured === undefined) {
    return resolveMaxConcurrency(limits, sessionOverride);
  }
  if (!isPositiveInt(configured)) {
    throw new ParallelConfigError(
      `workerCapacity must be a positive integer (got ${String(configured)})`,
    );
  }
  return configured;
}

function hasPositiveNumber(
  record: Record<string, unknown>,
  field: string,
): boolean {
  const value = record[field];
  return typeof value === 'number' && value > 0;
}

// Construction-time validation: a 0 cap always denies (running 0 >= 0)
// and a negative maxPendingMs expires everything on the next sweep, so
// both are misconfig — fail fast instead of denying silently mid-spawn.
function rejectNonPositive(
  value: unknown,
  field: string,
  integer: boolean,
): void {
  if (value === undefined) return;
  const ok =
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    (!integer || Number.isInteger(value));
  if (!ok) {
    throw new ParallelConfigError(
      `${field} must be a positive${integer ? ' integer' : ''} number (got ${String(value)})`,
    );
  }
}

export function validateParallelLimits(limits?: ParallelLimits): void {
  if (limits === undefined) return;
  const maxPendingMs = limits.maxPendingMs;
  if (maxPendingMs !== undefined) {
    if (
      typeof maxPendingMs !== 'number' ||
      !Number.isFinite(maxPendingMs) ||
      maxPendingMs < 0
    ) {
      throw new ParallelConfigError(
        `maxPendingMs must be a non-negative number (got ${String(maxPendingMs)})`,
      );
    }
  }
  rejectNonPositive(limits.aggregates?.maxMemMb, 'aggregates.maxMemMb', false);
  rejectNonPositive(
    limits.aggregates?.maxDiskMb,
    'aggregates.maxDiskMb',
    false,
  );
  for (const [provider, cap] of Object.entries(limits.providerCaps ?? {})) {
    rejectNonPositive(
      cap?.maxConcurrent,
      `providerCaps['${provider}'].maxConcurrent`,
      true,
    );
    rejectNonPositive(
      cap?.maxPerWindow,
      `providerCaps['${provider}'].maxPerWindow`,
      true,
    );
    rejectNonPositive(
      cap?.windowMs,
      `providerCaps['${provider}'].windowMs`,
      false,
    );
  }
  rejectNonPositive(
    limits.budgetGate?.maxCostUsd,
    'budgetGate.maxCostUsd',
    false,
  );
  rejectNonPositive(
    limits.budgetGate?.maxTokens,
    'budgetGate.maxTokens',
    false,
  );
  rejectNonPositive(
    limits.budgetGate?.maxToolCalls,
    'budgetGate.maxToolCalls',
    false,
  );
  rejectNonPositive(
    limits.budgetGate?.maxRuntimeMs,
    'budgetGate.maxRuntimeMs',
    false,
  );
  const approvalCapacity = limits.approvalCapacity;
  if (approvalCapacity !== undefined) {
    if (
      typeof approvalCapacity !== 'number' ||
      !Number.isInteger(approvalCapacity) ||
      approvalCapacity < 0
    ) {
      throw new ParallelConfigError(
        `approvalCapacity must be a non-negative integer (got ${String(approvalCapacity)})`,
      );
    }
  }
}

export function isAggregateConfigured(
  caps: AggregateCaps | undefined,
): boolean {
  if (caps === undefined) return false;
  return (
    hasPositiveNumber(caps as Record<string, unknown>, 'maxMemMb') ||
    hasPositiveNumber(caps as Record<string, unknown>, 'maxDiskMb')
  );
}

// Aggregate check: the sum of running estimates plus the candidate must fit
// under each configured cap. Aggregate > per-agent: individually light
// spawns still block once the total is full.
export function checkAggregateAdmission(
  running: readonly ResourceEstimate[],
  candidate: ResourceEstimate,
  caps: AggregateCaps | undefined,
): GateVerdict {
  if (!isAggregateConfigured(caps)) return { admitted: true };
  const memCap = caps?.maxMemMb;
  if (memCap !== undefined && memCap > 0) {
    const used = running.reduce((sum, r) => sum + (r.memMb ?? 0), 0);
    if (used + (candidate.memMb ?? 0) > memCap) {
      return {
        admitted: false,
        reason: `aggregate mem cap exceeded: ${used + (candidate.memMb ?? 0)}MB requested vs ${memCap}MB cap`,
      };
    }
  }
  const diskCap = caps?.maxDiskMb;
  if (diskCap !== undefined && diskCap > 0) {
    const used = running.reduce((sum, r) => sum + (r.diskMb ?? 0), 0);
    if (used + (candidate.diskMb ?? 0) > diskCap) {
      return {
        admitted: false,
        reason: `aggregate disk cap exceeded: ${used + (candidate.diskMb ?? 0)}MB requested vs ${diskCap}MB cap`,
      };
    }
  }
  return { admitted: true };
}

// Per-provider concurrency + rate caps. Stamps outside the window are
// ignored; a cap without its threshold field admits (opt-in per field).
export function checkProviderAdmission(
  provider: string,
  runningForProvider: number,
  recentStampsMs: readonly number[],
  cap: ProviderCap | undefined,
  nowMs: number,
): GateVerdict {
  if (cap === undefined) return { admitted: true };
  if (
    cap.maxConcurrent !== undefined &&
    runningForProvider >= cap.maxConcurrent
  ) {
    return {
      admitted: false,
      reason: `provider '${provider}' concurrency cap reached (${runningForProvider}/${cap.maxConcurrent})`,
    };
  }
  if (cap.maxPerWindow !== undefined) {
    const windowMs = cap.windowMs ?? 60_000;
    const inWindow = recentStampsMs.filter((t) => t > nowMs - windowMs);
    if (inWindow.length >= cap.maxPerWindow) {
      return {
        admitted: false,
        reason: `provider '${provider}' rate cap reached (${inWindow.length}/${cap.maxPerWindow} per ${windowMs}ms)`,
      };
    }
  }
  return { admitted: true };
}

export function isBudgetGateConfigured(gate: BudgetGate | undefined): boolean {
  if (gate === undefined) return false;
  const record = gate as Record<string, unknown>;
  return (
    hasPositiveNumber(record, 'maxCostUsd') ||
    hasPositiveNumber(record, 'maxTokens') ||
    hasPositiveNumber(record, 'maxToolCalls') ||
    hasPositiveNumber(record, 'maxRuntimeMs')
  );
}

// Budget gates fire only when configured — absent means no limits (§71).
export function checkBudgetAdmission(
  usage: UsageTally,
  gate: BudgetGate | undefined,
): GateVerdict {
  if (!isBudgetGateConfigured(gate)) return { admitted: true };
  if (
    gate?.maxCostUsd !== undefined &&
    (usage.costUsd ?? 0) > gate.maxCostUsd
  ) {
    return {
      admitted: false,
      reason: `budget cost gate exceeded: ${usage.costUsd} > ${gate.maxCostUsd} USD`,
    };
  }
  if (gate?.maxTokens !== undefined && (usage.tokens ?? 0) > gate.maxTokens) {
    return {
      admitted: false,
      reason: `budget token gate exceeded: ${usage.tokens} > ${gate.maxTokens}`,
    };
  }
  if (
    gate?.maxToolCalls !== undefined &&
    (usage.toolCalls ?? 0) > gate.maxToolCalls
  ) {
    return {
      admitted: false,
      reason: `budget tool-call gate exceeded: ${usage.toolCalls} > ${gate.maxToolCalls}`,
    };
  }
  if (
    gate?.maxRuntimeMs !== undefined &&
    (usage.runtimeMs ?? 0) > gate.maxRuntimeMs
  ) {
    return {
      admitted: false,
      reason: `budget runtime gate exceeded: ${usage.runtimeMs}ms > ${gate.maxRuntimeMs}ms`,
    };
  }
  return { admitted: true };
}
