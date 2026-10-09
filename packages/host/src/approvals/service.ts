import type { ApprovalPolicy, ApprovalVerdict } from './policy.js';
import { ALLOW_ONCE, ALLOW_TURN_EDITS, ALWAYS_ASK } from './policy.js';
import type { ApprovalRequest } from './request.js';
import type { ApprovalStore } from './stores.js';
import { MemoryApprovalStore } from './stores.js';
import { TIMEOUT_REASON_MARKER } from './timeout.js';

// The durable decider service.
// The decider is the user — never the model. This module exposes no
// role override, structurally, not by flag.
// Outcomes deny on timeout and never hang headless: every ask is bounded
// by maxPendingMs. First answer wins (first-wins latch, the memoOnce
// semantic — the harness primitive itself is not involved). Same-process
// late attach discovers pending asks via pendingRequests(); across a
// restart, pending asks time out to deny by design — only settled
// decisions persist (approvals.json), never open questions. A timeout
// denies the call but stores NOTHING: it is an unanswered
// question, so a later surface can still ask about the same operation —
// only real answers (user, route, autoApprove) enter the latch.
// sessionScoped is enforced by store placement, selected by the host:
// a per-session FileApprovalStore scopes decisions to one session,
// a shared store shares them. The flag documents the intent the host
// must honor when wiring the store.

export interface ApprovalServiceOptions {
  policy: ApprovalPolicy;
  store?: ApprovalStore;
  // Resolves the pending request when a user answers. Never resolves on
  // its own in headless runs — the wait below times out into a denial.
  //
  // The service hands the seat an AbortSignal and aborts it when
  // its own bound expires. A surface that honours it withdraws the obsolete
  // question instead of leaving a modal nobody can answer; a seat that
  // ignores the signal still works — the race below is what decides.
  awaitAnswer?: (
    request: ApprovalRequest,
    signal?: AbortSignal,
  ) => Promise<ApprovalVerdict | undefined>;
  clock?: () => number;
}

export class ApprovalService {
  private readonly policy: ApprovalPolicy;
  private readonly store: ApprovalStore;
  private readonly awaitAnswer?: (
    request: ApprovalRequest,
    signal?: AbortSignal,
  ) => Promise<ApprovalVerdict | undefined>;
  private readonly decisions: Map<string, ApprovalVerdict>;
  private readonly pending = new Map<string, ApprovalRequest>();
  private readonly waiters = new Map<
    string,
    (verdict: ApprovalVerdict | undefined) => void
  >();

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
  // submit for a settled key is ignored (memoOnce semantics) — EXCEPT a
  // stored approval that predates a tightened policy: an approval granted
  // without justification does not survive requireJustification being
  // enabled later. It re-enters the policy path (and denies headless).
  submit(request: ApprovalRequest, verdict: ApprovalVerdict): ApprovalVerdict {
    const existing = this.decisions.get(request.key);
    if (existing !== undefined) return existing;
    if (
      this.policy.requireJustification &&
      verdict.approved &&
      request.justification === undefined
    ) {
      return { approved: false, reason: 'approval requires justification' };
    }
    const stamped: ApprovalVerdict = verdict.approved
      ? { ...verdict, justified: request.justification !== undefined }
      : verdict;
    // Only session-scoped answers enter the latch —
    // allow-session, autoApprove, the route, and user DENIALS (a refusal
    // latching is the fail-safe direction: the user said no to this exact
    // operation for this session). An 'allow once' approves THIS call only:
    // it is returned without being stored or persisted, so the next
    // identical call asks again.
    // A turn's edit batch is not a session answer either.
    if (
      !(
        stamped.approved &&
        (stamped.by === ALLOW_ONCE ||
          stamped.by === ALLOW_TURN_EDITS ||
          stamped.edited !== undefined)
      )
    ) {
      this.decisions.set(request.key, stamped);
      this.persist();
    }
    this.pending.delete(request.key);
    this.waiters.get(request.key)?.(stamped);
    this.waiters.delete(request.key);
    return stamped;
  }

  async request(request: ApprovalRequest): Promise<ApprovalVerdict> {
    const existing = this.decisions.get(request.key);
    if (existing !== undefined) {
      const stale =
        existing.approved &&
        this.policy.requireJustification &&
        existing.justified !== true;
      if (!stale) return existing;
      // Evict: the stored approval predates the tightened policy and must
      // re-enter the policy path (submit's first-wins latch would otherwise
      // hand it straight back). Every path below ends in submit, which
      // persists — so the eviction is durable and the denial is recorded.
      this.decisions.delete(request.key);
    }
    // route=deny first: autoApprove entries never apply under it.
    if (this.policy.route === 'deny') {
      return this.submit(request, {
        approved: false,
        reason: `denied by policy route (capability: ${request.capability})`,
      });
    }
    if (
      this.policy.autoApprove.includes(request.capability) &&
      !ALWAYS_ASK.has(request.capability)
    ) {
      if (
        this.policy.requireJustification &&
        request.justification === undefined
      ) {
        return this.submit(request, {
          approved: false,
          reason: 'approval requires justification',
        });
      }
      return this.submit(request, { approved: true, by: 'autoApprove' });
    }
    this.pending.set(request.key, request);
    try {
      const answer = await this.waitForAnswer(request);
      if (answer === undefined) {
        // A timeout is an unanswered question, not a decision.
        // Deny THIS call (bounded, named) but persist nothing — a missed
        // dialog must not latch a denial that no later surface can overturn.
        // submit()'s first-wins latch is reserved for real answers (user,
        // route, autoApprove); a repeated ask waits the full bound again.
        return {
          approved: false,
          reason: `approval ${TIMEOUT_REASON_MARKER} after ${this.policy.maxPendingMs}ms`,
        };
      }
      return this.submit(request, answer);
    } finally {
      this.pending.delete(request.key);
    }
  }

  private waitForAnswer(
    request: ApprovalRequest,
  ): Promise<ApprovalVerdict | undefined> {
    // The bound that denies the call is the bound that withdraws
    // the QUESTION. Without this the surface kept showing an ask the service
    // had already given up on: the TUI dialog stayed up (and blocked the next
    // one).
    const controller = new AbortController();
    const answer = this.awaitAnswer?.(request, controller.signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        // Resolve the BOUND first, then withdraw the question: the abort makes
        // the seat resolve too (with its cancelled verdict), and the race must
        // settle on the timeout — otherwise a withdrawal would latch a denial
        // the user never gave.
        resolve(undefined);
        controller.abort();
      }, this.policy.maxPendingMs);
      timer.unref?.();
    });
    const notified = new Promise<ApprovalVerdict | undefined>((resolve) => {
      this.waiters.set(request.key, resolve);
    });
    const done = (
      value: ApprovalVerdict | undefined,
    ): ApprovalVerdict | undefined => {
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
