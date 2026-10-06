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
import type {
  BudgetGate,
  ConfiguredConcurrency,
  ParallelLimits,
  UsageTally,
} from './limits.js';
import {
  checkAggregateAdmission,
  checkBudgetAdmission,
  checkProviderAdmission,
  isBudgetGateConfigured,
  resolveMaxConcurrency,
  resolveWorkerCapacity,
  sanitizeReasonField,
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
  // The configured default (issue #133): `[orchestrator].maxWorkers`, the
  // product default a session override or an explicit limits cap still wins
  // over. Absent means the shipped DEFAULT_MAX_CONCURRENCY.
  configured?: ConfiguredConcurrency;
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

// Log-boundary sanitize: strip C0 controls + DEL + C1 controls
// (U+0080-U+009F, incl. NEL U+0085 and single-char CSI U+009B) + bidi
// overrides (U+202A-U+202E, U+2066-U+2069) so a crafted agentId or worktree
// (ESC / CSI / NEL / bidi) renders inert instead of driving the terminal
// that tails the log. Deny/hold/queue reasons are additionally sanitized
// at construction via sanitizeReasonField (limits.js) so returned reason
// strings are already clean for any caller that prints them.
export function sanitizeLogLine(line: string): string {
  return sanitizeReasonField(line);
}

export class ParallelScheduler {
  private readonly limits: ParallelLimits;
  private readonly clock: () => number;
  private readonly log: (line: string) => void;
  private sessionOverride: number | undefined;
  private budgetGateOverride: BudgetGate | undefined;
  private readonly configured: ConfiguredConcurrency | undefined;
  private usage: UsageTally | undefined;
  private readonly running = new Map<string, RunningEntry>();
  private readonly queue: QueuedEntry[] = [];
  private readonly providerStamps = new Map<string, number[]>();

  constructor(limits?: ParallelLimits, deps?: SchedulerDeps) {
    // Validate eagerly so misconfig fails at construction, never mid-spawn.
    validateParallelLimits(limits);
    resolveMaxConcurrency(limits, deps?.sessionOverride, deps?.configured);
    resolveWorkerCapacity(limits, deps?.sessionOverride, deps?.configured);
    this.limits = limits ?? {};
    this.clock = deps?.clock ?? Date.now;
    const sink = deps?.log ?? (() => undefined);
    this.log = (line: string) => sink(sanitizeLogLine(line));
    this.sessionOverride = deps?.sessionOverride;
    this.configured = deps?.configured;
    this.usage = deps?.usage;
  }

  runningCount(): number {
    return this.running.size;
  }

  // Install (or clear) the per-session override (issue #206, §45): the CLI's
  // `--concurrency <n>` is a property of ONE run, so the run applies it to
  // the scheduler that judges its admissions — the same surface every other
  // resolution goes through, never a second cap computed at the caller.
  // Validated eagerly: a misconfig fails the run instead of silently
  // admitting at the shipped default.
  setSessionOverride(value: number | undefined): void {
    if (value !== undefined) {
      resolveMaxConcurrency(this.limits, value, this.configured);
    }
    this.sessionOverride = value;
  }

  // Install (or remove) the aggregate task budget gate (issue #207, §71):
  // the run's `--budget total:<dims>` is a property of ONE run, so the run
  // applies it to the scheduler that judges its admissions — the same
  // surface every other gate goes through. An installed gate wins over the
  // constructed limits; undefined removes the run's override, restoring
  // whatever the scheduler was constructed with. Validated eagerly like
  // every other limit: a misconfig fails the run instead of silently
  // admitting past the gate.
  setBudgetGate(gate: BudgetGate | undefined): void {
    if (gate !== undefined) {
      validateParallelLimits({ budgetGate: gate });
    }
    this.budgetGateOverride = gate;
  }

  queuedCount(): number {
    return this.queue.length;
  }

  // The queue bound this scheduler judges against (issue #206 review): a
  // caller that has to explain an expiry names the SAME bound the sweep used,
  // never a second copy that can drift.
  maxPendingMs(): number {
    return this.limits.maxPendingMs ?? DEFAULT_MAX_PENDING_MS;
  }

  // The resolved admission cap this scheduler judges against (issue #106,
  // §49.1/§50): a surface that reports running/queued must report the cap
  // they are measured against, and it must be the SAME resolution the
  // admission decision used — a second computation at the caller would be
  // free to drift. Pure getter, no state change.
  maxConcurrency(): number {
    return resolveMaxConcurrency(
      this.limits,
      this.sessionOverride,
      this.configured,
    );
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
        reason: `agent '${sanitizeReasonField(request.agentId)}' is already running`,
      };
    }
    if (this.queue.some((e) => e.request.agentId === request.agentId)) {
      return {
        outcome: 'denied',
        reason: `agent '${sanitizeReasonField(request.agentId)}' is already queued`,
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

  /**
   * Abandon a queued entry the spawner no longer wants (issue #414
   * review): a timed-out `spawn_agent` withdraws instead of leaving a
   * ghost the next drain would admit to running with nothing to launch or
   * complete it. Returns 'withdrawn' when an entry was removed, 'running'
   * when the id was just admitted (the caller proceeds to launch it),
   * 'unknown' otherwise.
   */
  withdraw(agentId: string): 'withdrawn' | 'running' | 'unknown' {
    const index = this.queue.findIndex(
      (entry) => entry.request.agentId === agentId,
    );
    if (index >= 0) {
      this.queue.splice(index, 1);
      this.log(`parallel withdraw: queued agent '${agentId}' withdrawn`);
      return 'withdrawn';
    }
    if (this.running.has(agentId)) return 'running';
    return 'unknown';
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
      this.configured,
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
      this.configured,
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
          reason: `worktree '${sanitizeReasonField(request.worktree)}' already has a writer (§11.1 one-worktree-per-writer)`,
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
    if (
      isBudgetGateConfigured(this.budgetGateOverride ?? this.limits.budgetGate)
    ) {
      const budget = checkBudgetAdmission(
        this.usage ?? {},
        this.budgetGateOverride ?? this.limits.budgetGate,
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
