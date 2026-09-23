// 3-domain cancellation (issue #37; §32). On disconnect only
// invocation-scoped work is cancelled. Service-owned and durable work
// survive: they belong to the service or to durable execution, not to the
// disconnected invocation.

export const CANCELLATION_DOMAINS = [
  'invocation',
  'service',
  'durable',
] as const;

export type CancellationDomain = (typeof CANCELLATION_DOMAINS)[number];

export class TaskScope {
  readonly domain: CancellationDomain;
  readonly controller: AbortController;

  constructor(domain: CancellationDomain) {
    this.domain = domain;
    this.controller = new AbortController();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }
}

export interface DisconnectOutcome {
  cancelled: CancellationDomain[];
  preserved: CancellationDomain[];
}

export class DisconnectController {
  private scopes = new Set<TaskScope>();

  track(scope: TaskScope): void {
    this.scopes.add(scope);
  }

  untrack(scope: TaskScope): void {
    this.scopes.delete(scope);
  }

  onDisconnect(): DisconnectOutcome {
    const cancelled: CancellationDomain[] = [];
    const preserved: CancellationDomain[] = [];
    for (const scope of this.scopes) {
      if (scope.domain === 'invocation') {
        scope.controller.abort();
        cancelled.push(scope.domain);
      } else {
        preserved.push(scope.domain);
      }
    }
    return { cancelled, preserved };
  }
}
