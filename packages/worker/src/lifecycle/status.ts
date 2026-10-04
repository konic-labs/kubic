// Worker lifecycle status kernel (issue #42; §13, §81; split by issue #151).
//
// §13 says three lifecycles must not be conflated, and the first two are what
// this module owns:
//
//   - the PROCESS lifecycle — `spawning → ready → exiting`: whether the child
//     process is booting, up, or gone. A process exiting is NOT an outcome.
//   - the AGENT lifecycle — `starting → running → (waiting) → settling →
//     completed | failed | cancelled | timeout | budget_exhausted |
//     spawn_failed`: what the delegated work actually did. An exit code alone
//     never settles it: a child that exits 0 without a valid §68 report is a
//     FAILED agent (the run path settles that, after validating the report).
//
// Both vocabularies are closed, their transitions are guarded, and
// `classifyExit` maps a child terminus onto both. Pure: no I/O, no clock.

// §13 process status: the child process's own phase.
export const PROCESS_STATUSES = ['spawning', 'ready', 'exiting'] as const;

export type ProcessStatus = (typeof PROCESS_STATUSES)[number];

const PROCESS_TRANSITIONS: Record<ProcessStatus, readonly ProcessStatus[]> = {
  // A launch that never becomes ready still ends: spawning → exiting.
  spawning: ['ready', 'exiting'],
  ready: ['exiting'],
  exiting: [],
};

export class ProcessTransitionError extends Error {
  constructor(from: ProcessStatus, to: ProcessStatus) {
    super(
      from === 'exiting'
        ? `worker process already exited: refusing transition → ${to}`
        : `illegal worker process transition ${from} → ${to}`,
    );
    this.name = 'ProcessTransitionError';
  }
}

export function assertProcessTransition(
  from: ProcessStatus,
  to: ProcessStatus,
): ProcessStatus {
  if (!(PROCESS_TRANSITIONS[from] as readonly string[]).includes(to)) {
    throw new ProcessTransitionError(from, to);
  }
  return to;
}

// §13 agent status: what the delegated agent did. The process can be up while
// the agent waits on an approval (WAITING) or while the manager validates and
// commits its work (SETTLING).
export const AGENT_STATUSES = [
  'starting',
  'running',
  'waiting',
  'settling',
  'completed',
  'failed',
  'cancelled',
  'timeout',
  'budget_exhausted',
  'spawn_failed',
] as const;

export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const AGENT_TERMINAL_STATUSES: readonly AgentStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'timeout',
  'budget_exhausted',
  'spawn_failed',
];

export function isTerminalAgentStatus(status: AgentStatus): boolean {
  return (AGENT_TERMINAL_STATUSES as readonly string[]).includes(status);
}

const AGENT_TRANSITIONS: Record<AgentStatus, readonly AgentStatus[]> = {
  // Readiness is mandatory: starting never jumps straight to settling (§13).
  starting: [
    'running',
    'failed',
    'cancelled',
    'timeout',
    'budget_exhausted',
    'spawn_failed',
  ],
  running: [
    'waiting',
    'settling',
    'failed',
    'cancelled',
    'timeout',
    'budget_exhausted',
  ],
  // A held ask: the agent is blocked on an approval, and RUNNING resumes the
  // moment the router answers (or settles/terminates if it never does).
  waiting: [
    'running',
    'settling',
    'failed',
    'cancelled',
    'timeout',
    'budget_exhausted',
  ],
  // The child is gone and the manager is validating/committing: only the
  // §68 verdict (completed/failed) or a manager-side terminus can follow.
  settling: ['completed', 'failed', 'cancelled', 'timeout', 'budget_exhausted'],
  completed: [],
  failed: [],
  cancelled: [],
  timeout: [],
  budget_exhausted: [],
  spawn_failed: [],
};

export class AgentTransitionError extends Error {
  constructor(from: AgentStatus, to: AgentStatus) {
    if (isTerminalAgentStatus(from)) {
      super(
        `worker agent is terminal (${from}): refusing transition → ${to} (a settled agent is never reused)`,
      );
    } else if (from === 'starting' && to === 'settling') {
      super(
        `illegal worker agent transition ${from} → ${to} (readiness handshake required: starting → running → settling)`,
      );
    } else {
      super(`illegal worker agent transition ${from} → ${to}`);
    }
    this.name = 'AgentTransitionError';
  }
}

export function assertAgentTransition(
  from: AgentStatus,
  to: AgentStatus,
): AgentStatus {
  if (!(AGENT_TRANSITIONS[from] as readonly string[]).includes(to)) {
    throw new AgentTransitionError(from, to);
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

// The §68 result status the exit maps to (worker/result.ts RESULT_STATUSES).
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
  /** The §78 exit code the child declared for itself (issue #151): 3 is a
   *  budget terminus and 4 an approval one, even when the child reported no
   *  detail — the code already says what KIND of failure it was. */
  declaredExit?: number;
}

export interface ClassifiedExit {
  kind: ExitKind;
  /** The §68 result status (unchanged by the split). */
  status: ExitResultStatus;
  /** §13 agent status the exit settles the agent on. Exit 0 is `settling`:
   *  the process is gone, but the agent is only COMPLETED once its report
   *  validates (the run path calls that). */
  agent: AgentStatus;
  /** The process's own phase after the exit: always `exiting`. */
  process: ProcessStatus;
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

// §13: the agent terminus an exit names. An exit is never COMPLETED on its
// own — a clean exit puts the agent in SETTLING, and only the §68 report
// check settles it as COMPLETED (or FAILED). Exit 4 is an approval terminus
// (FAILED, kind `approval`), never a crash.
const AGENT_BY_KIND: Record<ExitKind, AgentStatus> = {
  completed: 'settling',
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
  } else if (source.budgetExhausted === true || source.declaredExit === 3) {
    kind = 'budget';
  } else if (source.timedOut === true) {
    kind = 'timeout';
  } else if (source.declaredExit === 4) {
    // The child declared an approval terminus (§78 code 4). The §52 kind is
    // `approval`; the agent state is FAILED, never CRASHED.
    kind = 'tool';
  } else if (source.signal !== null) {
    kind = 'crash';
  } else if (source.code === 0) {
    kind = 'completed';
  } else {
    kind = 'tool';
  }
  return {
    kind,
    status: STATUS_BY_KIND[kind],
    agent: AGENT_BY_KIND[kind],
    process: 'exiting',
  };
}
