// Orchestrator approval routing (issue #48; §41.2, §14.2 deferred
// keyed-service). The decider is the user: worker asks route to the user
// dialog over a durable deferred channel, never to the manager. The
// manager sees a read-only blocked indicator; any manager approve attempt
// is refused and logged. Bounded waits deny on maxPendingMs (never hang
// headless). memoOnce: first answer wins, persisted — restarts reuse the
// settled decision and concurrent races share one pending prompt.
import type { OrchestratorApprovalRequest } from './request.js';

export type OrchestratorVerdict =
  | { approved: true; by: string }
  | { approved: false; reason: string };

export interface DecisionStore {
  load(): Record<string, OrchestratorVerdict>;
  save(decisions: Record<string, OrchestratorVerdict>): void;
}

export class MemoryDecisionStore implements DecisionStore {
  private decisions: Record<string, OrchestratorVerdict> = {};
  load(): Record<string, OrchestratorVerdict> {
    return { ...this.decisions };
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
  deps: { audit?: (event: { type: string; detail: string }) => void } = {},
): OrchestratorVerdict {
  const reason = `manager cannot approve request ${request.key}: the decider is the user (§41.2)`;
  deps.audit?.({ type: 'manager-approve-refused', detail: reason });
  return { approved: false, reason };
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
  const decisions = new Map<string, OrchestratorVerdict>(
    Object.entries(store.load()),
  );
  const pending = new Map<string, OrchestratorApprovalRequest>();
  const inflight = new Map<string, Promise<OrchestratorVerdict>>();
  const persist = (): void => {
    store.save(Object.fromEntries(decisions));
  };

  const submit = (
    request: OrchestratorApprovalRequest,
    verdict: OrchestratorVerdict,
  ): OrchestratorVerdict => {
    const existing = decisions.get(request.key);
    if (existing !== undefined) return existing;
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
    if (settled !== undefined) return Promise.resolve(settled);
    const running = inflight.get(req.key);
    if (running !== undefined) return running;
    pending.set(req.key, req);
    const answer = options.awaitAnswer?.(req);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), options.maxPendingMs);
      timer.unref?.();
    });
    const promise: Promise<OrchestratorVerdict> =
      answer === undefined
        ? timeout.then(() =>
            submit(req, {
              approved: false,
              reason: `approval timed out after ${options.maxPendingMs}ms with no user presentation — denied`,
            }),
          )
        : Promise.race([answer, timeout]).then((value) =>
            value === undefined
              ? submit(req, {
                  approved: false,
                  reason: `approval timed out after ${options.maxPendingMs}ms with no user presentation — denied`,
                })
              : submit(req, value),
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
