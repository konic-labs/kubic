// Orchestrator approval routing (issue #48; §41.2, §14.2 deferred
// keyed-service). The decider is the user: worker asks route to the user
// dialog over a durable deferred channel, never to the manager. The
// manager sees a read-only blocked indicator; any manager approve attempt
// is refused and logged. Bounded waits deny on maxPendingMs (never hang
// headless). memoOnce: first answer wins, persisted — restarts reuse the
// settled decision and concurrent races share one pending prompt.
import type { OrchestratorApprovalRequest } from './request.js';
import { TIMEOUT_REASON_MARKER } from './timeout-reason.js';

export type OrchestratorVerdict =
  | { approved: true; by: string }
  | { approved: false; reason: string };

// A stored entry the store could not authenticate (issue #149): the file was
// written by something other than this process's manager — a worker's bash, a
// sibling, an earlier run. Reported so the router can drop AND audit it, never
// silently ignore it.
export interface DroppedDecision {
  key: string;
  reason: string;
}

export interface DecisionLoad {
  decisions: Record<string, OrchestratorVerdict>;
  dropped: readonly DroppedDecision[];
}

export interface DecisionStore {
  load(): DecisionLoad;
  save(decisions: Record<string, OrchestratorVerdict>): void;
}

export class MemoryDecisionStore implements DecisionStore {
  private decisions: Record<string, OrchestratorVerdict> = {};
  load(): DecisionLoad {
    // In memory only, and never outside this process: nothing here can have
    // been planted by anyone else, so nothing needs authentication.
    return { decisions: { ...this.decisions }, dropped: [] };
  }
  save(decisions: Record<string, OrchestratorVerdict>): void {
    this.decisions = { ...decisions };
  }
}

export interface RouterOptions {
  maxPendingMs: number;
  store?: DecisionStore;
  awaitAnswer?: (
    request: OrchestratorApprovalRequest,
  ) => Promise<OrchestratorVerdict | undefined>;
  audit?: (event: { type: string; detail: string }) => void;
}

export interface ManagerBlockedIndicator {
  blocked: true;
  readOnly: true;
  decider: 'user';
  key: string;
  trigger: string;
  toolName: string;
  summary: string;
  state: string;
  sessionId: string;
  agentId: string;
  worktree: string;
}

export function buildManagerBlockedIndicator(
  request: OrchestratorApprovalRequest,
  state: string,
): ManagerBlockedIndicator {
  return {
    blocked: true,
    readOnly: true,
    decider: 'user',
    key: request.key,
    trigger: request.trigger,
    toolName: request.toolName,
    summary: request.summary,
    state,
    sessionId: request.sessionId,
    agentId: request.agentId,
    worktree: request.worktree,
  };
}

export function attemptManagerApprove(
  request: OrchestratorApprovalRequest,
  deps: { audit?: (event: ManagerRefusalEvent) => void } = {},
): OrchestratorVerdict {
  const reason = `manager cannot approve request ${request.key}: the decider is the user (§41.2)`;
  (deps.audit ?? defaultRouterAudit)({
    type: 'manager-approve-refused',
    detail: reason,
  });
  return { approved: false, reason };
}

export interface ManagerRefusalEvent {
  type: 'manager-approve-refused';
  detail: string;
}

// Default sink: refusals and seed drops are recorded even when the caller
// passes no audit dep, so a bare `attemptManagerApprove(req)` or a bare
// `submit(req, nonUserApproval)` still leaves an audit trail instead of
// vanishing silently. All router-generated refusal/drop events share this
// log, read via readManagerRefusalLog.
export interface RouterAuditEvent {
  type: string;
  detail: string;
}

const routerAuditLog: RouterAuditEvent[] = [];

function defaultRouterAudit(event: RouterAuditEvent): void {
  routerAuditLog.push(event);
}

export function readManagerRefusalLog(): readonly RouterAuditEvent[] {
  return routerAuditLog;
}

export interface OrchestratorRouter {
  request(request: OrchestratorApprovalRequest): Promise<OrchestratorVerdict>;
  submit(
    request: OrchestratorApprovalRequest,
    verdict: OrchestratorVerdict,
  ): OrchestratorVerdict;
  pendingRequests(): OrchestratorApprovalRequest[];
  decided(key: string): OrchestratorVerdict | undefined;
}

export function createOrchestratorRouter(
  options: RouterOptions,
): OrchestratorRouter {
  if (!(options.maxPendingMs > 0)) {
    throw new Error('maxPendingMs must be a positive number');
  }
  const store = options.store ?? new MemoryDecisionStore();
  const audit = options.audit ?? defaultRouterAudit;
  const decisions = new Map<string, OrchestratorVerdict>();
  const loaded = store.load();
  // Unauthenticated entries (issue #149) are dropped before anything else:
  // decision state lives outside the repository precisely because it is the
  // state a worker would plant, so an entry this manager did not seal is
  // evidence of a write, not a decision. Audited, then scrubbed below.
  for (const drop of loaded.dropped) {
    audit({
      type: 'orchestrator-decision-seed-dropped',
      detail: `${drop.key} ${drop.reason} dropped — user prompt required`,
    });
  }
  // Store-loaded verdicts are validated at construction: only
  // {approved:true, by:'user'} approvals are honored. A seeded non-user
  // approval (recomputed key + by:'manager') is dropped with an audit
  // record, so it cannot bypass the user prompt. Loaded denials are kept
  // but untrusted (see trustedDenials): they never auto-decide.
  for (const [key, verdict] of Object.entries(loaded.decisions)) {
    if (verdict.approved && verdict.by !== 'user') {
      audit({
        type: 'orchestrator-decision-seed-dropped',
        detail: `${key} seeded non-user approval by ${verdict.by} dropped — user prompt required`,
      });
      continue;
    }
    decisions.set(key, verdict);
  }
  // Scrub the persisted poison so a restart does not reload the drop.
  store.save(Object.fromEntries(decisions));
  const pending = new Map<string, OrchestratorApprovalRequest>();
  const inflight = new Map<string, Promise<OrchestratorVerdict>>();
  // Keys denied via the user/system path (the request flow below). A
  // denial written by a direct submit() call — any submitter — never lands
  // here, so it is untrusted: it cannot decide a later request (the user
  // is still prompted) and a later user approval overrides it. This closes
  // the first-denial-wins DoS without trusting the forgeable `by` string.
  const trustedDenials = new Set<string>();
  const persist = (): void => {
    store.save(Object.fromEntries(decisions));
  };

  const submit = (
    request: OrchestratorApprovalRequest,
    verdict: OrchestratorVerdict,
  ): OrchestratorVerdict => {
    const existing = decisions.get(request.key);
    if (verdict.approved && verdict.by !== 'user') {
      const refusal: OrchestratorVerdict = {
        approved: false,
        reason: `refused: only the user decider may approve request ${request.key} (got by:${verdict.by}) — denial recorded, approval dropped`,
      };
      audit({
        type: 'orchestrator-approval-refused',
        detail: `${request.key} non-user approval by ${verdict.by} refused`,
      });
      return refusal;
    }
    // A later user approval overrides a stored denial that did not come
    // through the user path (direct-submit pre-denial DoS). A denial the
    // user actually gave (trusted) still stands first-wins.
    if (
      existing !== undefined &&
      !existing.approved &&
      verdict.approved &&
      verdict.by === 'user' &&
      !trustedDenials.has(request.key)
    ) {
      decisions.set(request.key, verdict);
      persist();
      pending.delete(request.key);
      audit({
        type: 'orchestrator-approval-granted',
        detail: `${request.key} ${request.trigger} approved (overrode untrusted denial)`,
      });
      return verdict;
    }
    if (existing !== undefined) return existing;
    // Direct-submit denials land here untrusted (never in trustedDenials):
    // anyone may record a denial, but it cannot decide a later request.
    decisions.set(request.key, verdict);
    persist();
    pending.delete(request.key);
    options.audit?.({
      type: verdict.approved
        ? 'orchestrator-approval-granted'
        : 'orchestrator-approval-denied',
      detail: `${request.key} ${request.trigger} ${verdict.approved ? 'approved' : 'denied'}`,
    });
    return verdict;
  };

  const request = (
    req: OrchestratorApprovalRequest,
  ): Promise<OrchestratorVerdict> => {
    const settled = decisions.get(req.key);
    // Only approvals and user-path (trusted) denials decide without a
    // prompt. An untrusted stored denial — a direct-submit pre-denial or a
    // poisoned store load — is ignored so the user is still asked; the
    // user's answer then overrides it via submit.
    if (
      settled !== undefined &&
      (settled.approved || trustedDenials.has(req.key))
    ) {
      return Promise.resolve(settled);
    }
    const running = inflight.get(req.key);
    if (running !== undefined) return running;
    pending.set(req.key, req);
    // The user/system path owns its verdicts: approvals go through submit
    // (refusal + override rules); denials are stored as our verdict object
    // and trusted, so a pre-existing untrusted denial can never shadow the
    // answer the user actually gave. An existing user approval is never
    // clobbered (unreachable after the short-circuit above; guarded).
    const settleUserPath = (
      verdict: OrchestratorVerdict,
    ): OrchestratorVerdict => {
      if (verdict.approved) return submit(req, verdict);
      const existing = decisions.get(req.key);
      if (existing?.approved) return existing;
      decisions.set(req.key, verdict);
      persist();
      pending.delete(req.key);
      trustedDenials.add(req.key);
      options.audit?.({
        type: 'orchestrator-approval-denied',
        detail: `${req.key} ${req.trigger} denied`,
      });
      return verdict;
    };
    const answer = options.awaitAnswer?.(req);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), options.maxPendingMs);
      timer.unref?.();
    });
    const promise: Promise<OrchestratorVerdict> =
      answer === undefined
        ? timeout.then(() =>
            settleUserPath({
              approved: false,
              reason: `approval ${TIMEOUT_REASON_MARKER} after ${options.maxPendingMs}ms with no user presentation — denied`,
            }),
          )
        : Promise.race([answer, timeout]).then((value) =>
            value === undefined
              ? settleUserPath({
                  approved: false,
                  reason: `approval ${TIMEOUT_REASON_MARKER} after ${options.maxPendingMs}ms with no user presentation — denied`,
                })
              : settleUserPath(value),
          );
    const tracked = promise.finally(() => {
      if (timer !== undefined) clearTimeout(timer);
      pending.delete(req.key);
      if (inflight.get(req.key) === tracked) inflight.delete(req.key);
    });
    inflight.set(req.key, tracked);
    return tracked;
  };

  return {
    request,
    submit,
    pendingRequests: () => [...pending.values()],
    decided: (key: string) => decisions.get(key),
  };
}
