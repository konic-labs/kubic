// Worker process lifecycle status kernel (issue #42; §13, §81).
// Pure: the §13 vocabulary (CREATED→SPAWNING→READY→RUNNING→terminal
// COMPLETED/SPAWN_FAILED/CRASHED/TIMEOUT/BUDGET_EXHAUSTED, plus
// CANCELLED per §51 cancel terminates), legal-transition guard, and
// the exit classification (crash vs tool vs budget vs cancel) feeding
// the result + trajectory payloads.

export const WORKER_STATUSES = [
  'created',
  'spawning',
  'ready',
  'running',
  'completed',
  'spawn_failed',
  'crashed',
  'timeout',
  'budget_exhausted',
  'cancelled',
] as const;

export type WorkerStatus = (typeof WORKER_STATUSES)[number];

export const TERMINAL_STATUSES: readonly WorkerStatus[] = [
  'completed',
  'spawn_failed',
  'crashed',
  'timeout',
  'budget_exhausted',
  'cancelled',
];

export function isTerminalStatus(status: WorkerStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

const LIVE_TRANSITIONS: Record<string, readonly WorkerStatus[]> = {
  // Happy path: readiness is mandatory — spawning never jumps to
  // running without the handshake (§13).
  created: ['spawning', 'cancelled'],
  spawning: ['ready', 'spawn_failed', 'cancelled'],
  ready: ['running', 'cancelled'],
  running: ['completed', 'crashed', 'timeout', 'budget_exhausted', 'cancelled'],
};

export class WorkerTransitionError extends Error {
  constructor(from: WorkerStatus, to: WorkerStatus) {
    if (isTerminalStatus(from)) {
      super(
        `worker is terminal (${from}): refusing transition → ${to} (cancelled workers are never reused)`,
      );
    } else if (from === 'spawning' && to === 'running') {
      super(
        `illegal worker transition ${from} → ${to} (readiness handshake required: spawning → ready → running)`,
      );
    } else {
      super(`illegal worker transition ${from} → ${to}`);
    }
    this.name = 'WorkerTransitionError';
  }
}

export function assertTransition(
  from: WorkerStatus,
  to: WorkerStatus,
): WorkerStatus {
  if (isTerminalStatus(from)) {
    throw new WorkerTransitionError(from, to);
  }
  const allowed = LIVE_TRANSITIONS[from] ?? [];
  if (!(allowed as readonly string[]).includes(to)) {
    throw new WorkerTransitionError(from, to);
  }
  return to;
}

export type ExitKind =
  | 'completed'
  | 'crash'
  | 'tool'
  | 'budget'
  | 'cancel'
  | 'timeout'
  | 'spawn_failed';

export type ExitResultStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'budget_exhausted'
  | 'spawn_failed';

export interface ExitSource {
  code: number | null;
  signal: string | null;
  cancelled: boolean;
  budgetExhausted?: boolean;
  timedOut?: boolean;
}

export interface ClassifiedExit {
  kind: ExitKind;
  status: ExitResultStatus;
}

const STATUS_BY_KIND: Record<ExitKind, ExitResultStatus> = {
  completed: 'completed',
  crash: 'failed',
  tool: 'failed',
  budget: 'budget_exhausted',
  cancel: 'cancelled',
  timeout: 'timeout',
  spawn_failed: 'spawn_failed',
};

export function classifyExit(source: ExitSource): ClassifiedExit {
  let kind: ExitKind;
  if (source.code === null && source.signal === null) {
    kind = 'spawn_failed';
  } else if (source.cancelled) {
    kind = 'cancel';
  } else if (source.budgetExhausted === true) {
    kind = 'budget';
  } else if (source.timedOut === true) {
    kind = 'timeout';
  } else if (source.signal !== null) {
    kind = 'crash';
  } else if (source.code === 0) {
    kind = 'completed';
  } else {
    kind = 'tool';
  }
  return { kind, status: STATUS_BY_KIND[kind] };
}
