// Parallel scheduler (issue #47; §45, §45.1, §11.1, §81).
// One admission surface for parallel spawns: concurrency (default 4,
// per-session overridable), one-worktree-per-writer, worker capacity,
// mem/disk aggregates, per-provider caps, opt-in budget gates, and the
// single approval-capacity surface. Blocked spawns are mode-correct:
// autonomous queues (FIFO, starvation-safe, every transition logged) while
// interactive fails fast with a reason. Queued entries expire via
// maxPendingMs-deny — nothing waits silently. Pure except for the injected
// clock/log; no I/O, no network.

import type { RunMode } from '../../../../agents/src/budget.js';
import type { ParallelLimits, UsageTally } from './limits.js';
import {
  checkAggregateAdmission,
  checkBudgetAdmission,
  checkProviderAdmission,
  isBudgetGateConfigured,
  resolveMaxConcurrency,
  resolveWorkerCapacity,
  validateParallelLimits,
} from './limits.js';

export const DEFAULT_MAX_PENDING_MS = 60_000;

export interface SpawnRequest {
  agentId: string;
  sessionId: string;
  worktree: string;
  provider?: string;
  memMb?: number;
  diskMb?: number;
  needsApproval?: boolean;
}

export type SpawnOutcome =
  | { outcome: 'admitted' }
  | { outcome: 'queued'; position: number }
  | { outcome: 'denied'; reason: string };

export interface SchedulerDeps {
  clock?: () => number;
  log?: (line: string) => void;
  sessionOverride?: number;
  usage?: UsageTally;
}

interface RunningEntry {
  request: SpawnRequest;
}

interface QueuedEntry {
  request: SpawnRequest;
  enqueuedAtMs: number;
  reason: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// Strip C0 controls + DEL at the log boundary so a crafted agentId or
// worktree (ESC / CSI / newline) renders inert instead of driving the
// terminal that tails the log. Reasons stay verbatim — only logs sanitize.
export function sanitizeLogLine(line: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping controls.
  return line.replace(/[\u0000-\u001f\u007f]/g, '');
}

export class ParallelScheduler {
  private readonly limits: ParallelLimits;
  private readonly clock: () => number;
  private readonly log: (line: string) => void;
  private readonly sessionOverride: number | undefined;
  private usage: UsageTally | undefined;
  private readonly running = new Map<string, RunningEntry>();
  private readonly queue: QueuedEntry[] = [];
  private readonly providerStamps = new Map<string, number[]>();

  constructor(limits?: ParallelLimits, deps?: SchedulerDeps) {
    // Validate eagerly so misconfig fails at construction, never mid-spawn.
    validateParallelLimits(limits);
    resolveMaxConcurrency(limits, deps?.sessionOverride);
    resolveWorkerCapacity(limits, deps?.sessionOverride);
    this.limits = limits ?? {};
    this.clock = deps?.clock ?? Date.now;
    const sink = deps?.log ?? (() => undefined);
    this.log = (line: string) => sink(sanitizeLogLine(line));
    this.sessionOverride = deps?.sessionOverride;
    this.usage = deps?.usage;
  }

  runningCount(): number {
    return this.running.size;
  }

  queuedCount(): number {
    return this.queue.length;
  }

  pendingIds(): string[] {
    return this.queue.map((entry) => entry.request.agentId);
  }

  runningIds(): string[] {
    return [...this.running.keys()];
  }

  requestSpawn(request: SpawnRequest, mode: RunMode): SpawnOutcome {
    this.sweepPending();
    if (!isNonEmptyString(request.agentId)) {
      return {
        outcome: 'denied',
        reason: 'agentId must be a non-empty string',
      };
    }
    // Time alone can free a gate (provider rate window) with nothing
    // running, so re-evaluate the queued head before judging the newcomer —
    // otherwise a queued entry waits until the next complete() or expiry.
    // Runs after the id checks so a malformed request never triggers wakes.
    const wasQueued = this.queue.some(
      (e) => e.request.agentId === request.agentId,
    );
    this.drain();
    if (wasQueued && this.running.has(request.agentId)) {
      return { outcome: 'admitted' };
    }
    if (this.running.has(request.agentId)) {
      return {
        outcome: 'denied',
        reason: `agent '${request.agentId}' is already running`,
      };
    }
    if (this.queue.some((e) => e.request.agentId === request.agentId)) {
      return {
        outcome: 'denied',
        reason: `agent '${request.agentId}' is already queued`,
      };
    }
    const verdict = this.tryAdmit(request);
    if (verdict.admitted) {
      this.admit(request);
      return { outcome: 'admitted' };
    }
    if (mode === 'interactive') {
      this.log(
        `parallel deny: agent '${request.agentId}' refused (${verdict.reason})`,
      );
      return { outcome: 'denied', reason: verdict.reason };
    }
    const at = this.clock();
    this.queue.push({ request, enqueuedAtMs: at, reason: verdict.reason });
    this.log(
      `parallel queue: agent '${request.agentId}' queued at position ${this.queue.length} (${verdict.reason})`,
    );
    return { outcome: 'queued', position: this.queue.length };
  }

  // Settle a running agent and FIFO-drain the queue: only the head is
  // considered, so a still-blocked head keeps later entries queued
  // (starvation-safe — nobody jumps the line). Returns woken agent ids.
  complete(agentId: string): string[] {
    this.running.delete(agentId);
    this.sweepPending();
    return this.drain();
  }

  // Expire queued entries past maxPendingMs (deny-with-reason, logged).
  // Returns the denied agent ids. Runs opportunistically on every
  // request/complete and on demand — the queue never hangs silent.
  sweepPending(nowMs?: number): string[] {
    const now = nowMs ?? this.clock();
    const maxPendingMs = this.limits.maxPendingMs ?? DEFAULT_MAX_PENDING_MS;
    const denied: string[] = [];
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      const entry = this.queue[i];
      if (now - entry.enqueuedAtMs > maxPendingMs) {
        this.queue.splice(i, 1);
        denied.push(entry.request.agentId);
        this.log(
          `parallel deny: queued agent '${entry.request.agentId}' expired after ${now - entry.enqueuedAtMs}ms (maxPendingMs ${maxPendingMs}ms; was: ${entry.reason})`,
        );
      }
    }
    this.pruneProviderStamps(now);
    return denied.reverse();
  }

  // Replace the budget usage snapshot and re-evaluate the queue. A
  // budget-denied head can never become admittable on its own — fresh usage
  // is the only event that unblocks it — so update + drain are one step.
  // Returns woken agent ids.
  updateUsage(usage: UsageTally): string[] {
    this.usage = usage;
    this.sweepPending();
    return this.drain();
  }

  private drain(): string[] {
    const woken: string[] = [];
    while (this.queue.length > 0) {
      const head = this.queue[0];
      const verdict = this.tryAdmit(head.request);
      if (!verdict.admitted) {
        this.log(
          `parallel hold: queued agent '${head.request.agentId}' still blocked (${verdict.reason})`,
        );
        break;
      }
      this.queue.shift();
      this.admit(head.request);
      woken.push(head.request.agentId);
      this.log(
        `parallel wake: queued agent '${head.request.agentId}' admitted (fifo wakeup)`,
      );
    }
    return woken;
  }

  private admit(request: SpawnRequest): void {
    this.running.set(request.agentId, { request });
    if (request.provider !== undefined) {
      const now = this.clock();
      const windowMs = this.providerWindowMs(request.provider);
      const stamps = (this.providerStamps.get(request.provider) ?? []).filter(
        (t) => t > now - windowMs,
      );
      stamps.push(now);
      this.providerStamps.set(request.provider, stamps);
    }
  }

  private providerWindowMs(provider: string): number {
    return this.limits.providerCaps?.[provider]?.windowMs ?? 60_000;
  }

  // Provider stamps are append-only without this: every admit pushes one but
  // nothing removes out-of-window entries, so long-lived schedulers grow
  // without bound. Prune to the in-window set on admit (above) and here.
  private pruneProviderStamps(now: number): void {
    for (const [provider, stamps] of this.providerStamps) {
      const windowMs = this.providerWindowMs(provider);
      const kept = stamps.filter((t) => t > now - windowMs);
      if (kept.length === 0) {
        this.providerStamps.delete(provider);
      } else if (kept.length !== stamps.length) {
        this.providerStamps.set(provider, kept);
      }
    }
  }

  private tryAdmit(
    request: SpawnRequest,
  ): { admitted: true } | { admitted: false; reason: string } {
    const maxConcurrency = resolveMaxConcurrency(
      this.limits,
      this.sessionOverride,
    );
    if (this.running.size >= maxConcurrency) {
      return {
        admitted: false,
        reason: `concurrency cap reached (${this.running.size}/${maxConcurrency})`,
      };
    }
    const workerCapacity = resolveWorkerCapacity(
      this.limits,
      this.sessionOverride,
    );
    if (this.running.size >= workerCapacity) {
      return {
        admitted: false,
        reason: `worker capacity reached (${this.running.size}/${workerCapacity})`,
      };
    }
    for (const entry of this.running.values()) {
      if (entry.request.worktree === request.worktree) {
        return {
          admitted: false,
          reason: `worktree '${request.worktree}' already has a writer (§11.1 one-worktree-per-writer)`,
        };
      }
    }
    const aggregate = checkAggregateAdmission(
      [...this.running.values()].map((entry) => ({
        memMb: entry.request.memMb,
        diskMb: entry.request.diskMb,
      })),
      { memMb: request.memMb, diskMb: request.diskMb },
      this.limits.aggregates,
    );
    if (!aggregate.admitted) return aggregate;
    const provider = request.provider ?? 'default';
    const runningForProvider = [...this.running.values()].filter(
      (entry) => (entry.request.provider ?? 'default') === provider,
    ).length;
    const providerCap = this.limits.providerCaps?.[provider];
    const providerVerdict = checkProviderAdmission(
      provider,
      runningForProvider,
      this.providerStamps.get(provider) ?? [],
      providerCap,
      this.clock(),
    );
    if (!providerVerdict.admitted) return providerVerdict;
    if (isBudgetGateConfigured(this.limits.budgetGate)) {
      const budget = checkBudgetAdmission(
        this.usage ?? {},
        this.limits.budgetGate,
      );
      if (!budget.admitted) return budget;
    }
    const approvalCapacity = this.limits.approvalCapacity;
    if (
      request.needsApproval === true &&
      approvalCapacity !== undefined &&
      approvalCapacity >= 0
    ) {
      const pending = [...this.running.values()].filter(
        (entry) => entry.request.needsApproval === true,
      ).length;
      if (pending >= approvalCapacity) {
        return {
          admitted: false,
          reason: `approval capacity reached (${pending}/${approvalCapacity} pending on the single approval surface)`,
        };
      }
    }
    return { admitted: true };
  }
}
