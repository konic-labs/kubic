// KubicPresentationState event/presentation contract (issue #5; §66, §3.1).
// Pure types with zero implementation imports. Every field is a replicated
// value or a keyed service instance — no field requires the presentation to
// hold authority, and commands are narrow and typed.
//
// Negative rule: there is deliberately no `eval`-style command channel, no
// raw event stream, and no way for the presentation to reach the harness or
// the worker manager directly. This package (core) imports nothing internal;
// `scripts/dep-lint.mjs` rejects core → host/worker/exec imports structurally.
//
// Snapshot/summary shapes are stubs refined by their owners: session and
// connection in #14 (sessions), agents in #41 (spawn contract), lanes in #11
// (root lane), workers in #42 (worker lifecycle), approvals in #16,
// usage in #20 (models/cost).

// Issue #338 (§16.8 "Images"): one image content part of a prompt. The
// lane prompt contract carries text plus optional images; the worker maps
// these onto Pi's user-message content parts unchanged, so a session stores
// (and a resumed session replays) them exactly as Pi does. `data` is
// base64 without a `data:` prefix; `bytes` is the decoded size the
// transcript placeholder prints.
export interface LaneImagePart {
  readonly mimeType: string;
  readonly data: string;
  readonly filename?: string;
  readonly bytes?: number;
}

// Issue #464: an orchestrator run's phases, as the dashboard's timeline
// shows them (docs/ui 04-B). A phase the plan does not run is `skipped`.
export const RUN_PHASES = [
  'plan',
  'implement',
  'review',
  'merge',
  'verify',
] as const;

export type RunPhase = (typeof RUN_PHASES)[number];

export interface RunPhaseState {
  readonly phase: RunPhase;
  readonly state: 'running' | 'done' | 'failed' | 'skipped';
  /** When the phase reached this state. */
  readonly at: number;
  /** Issue #465: when the phase started running, once it has. */
  readonly startedAt?: number;
}

export interface SessionSnapshot {
  sessionId: string;
  // Issue #333 (§66): the live session's replicated facts.
  model?: string;
  thinking?: string;
  mode: 'solo' | 'orchestrator';
  approvalsSkipped: boolean;
  // Issue #464: the current orchestrator run's phases, in order.
  runPhases?: readonly RunPhaseState[];
}

// §41/§66: an agent's budget burn-down, as replicated.
export interface BudgetSummary {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  limitUsd?: number;
}

export interface AgentSummary {
  agentId: string;
  role: string;
  status: string;
  // §66: the agent's workspace (solo: the repo root; a worker: its worktree).
  workspace?: string;
  budget?: BudgetSummary;
}

// One tool call of a lane, as the presentation renders it (issue #333; §66,
// §18). `args`/`entry` are the replicated payloads the view summarizes for
// display — the state never carries a render string the projector invented.
export interface LaneToolSnapshot {
  toolCallId: string;
  toolName: string;
  status: 'running' | 'done';
  isError: boolean;
  args?: unknown;
  entry?: unknown;
  durationMs?: number;
}

export interface LaneSnapshot {
  laneId: string;
  agentId: string;
  status: 'idle' | 'running' | 'done';
  // The live turn's calls, oldest first; completed turns fold away.
  tools: readonly LaneToolSnapshot[];
  // §66 queues: the prompts the conversation's inbox holds but no turn has
  // placed yet (#334).
  queued: readonly string[];
  // §27: a compaction is in flight / the last fault / a retry backoff.
  compacting: boolean;
  fault?: string;
  retrying?: { attempt: number; error?: string };
}

// Issue #464: one tool call of a worker, as its process reported it — the
// tool, a redacted summary of its arguments and outcome (never the raw
// arguments), and for an edit or write the display diff, bounded.
export interface WorkerToolActivity {
  readonly id: string;
  readonly tool: string;
  readonly target?: string;
  readonly state: 'running' | 'done' | 'error';
  readonly outcome?: string;
  readonly diff?: { readonly text: string; readonly firstChangedLine?: number };
  readonly at: number;
}

// Issue #464: what a worker's changes add up to.
export interface WorkerDiffStat {
  readonly files: number;
  readonly added: number;
  readonly removed: number;
}

export interface WorkerSummary {
  workerId: string;
  role?: string;
  status?: string;
  workspace?: string;
  budget?: BudgetSummary;
  // Issue #342 (§18): the per-agent facts the orchestrator view shows — the
  // generation (a replacement is the next one), the model the worker runs,
  // and its own spend once its result reports it.
  generation?: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  // Issue #464 (docs/ui 04-C, 04-D): the worker's task (its assignment's
  // first line), its latest tool call, how many it made, the last eight,
  // its change summary, and the approval it waits on.
  task?: string;
  activity?: WorkerToolActivity;
  toolCount?: number;
  recentTools?: readonly WorkerToolActivity[];
  diffStat?: WorkerDiffStat;
  awaiting?: { readonly approvalKey: string; readonly summary: string };
  // Issue #465: when this generation started and, once settled, ended
  // (epoch ms) — the dashboard's elapsed column.
  startedAt?: number;
  endedAt?: number;
  // Issue #466: the settled worker's own summary line, and why it failed
  // (the preview's last rows).
  summary?: string;
  failure?: string;
}

export interface ApprovalRequest {
  requestId: string;
  toolName?: string;
  capability?: string;
  detail?: string;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  requests?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ConnectionState {
  status: 'connected' | 'disconnected' | 'reconnecting';
  detail?: string;
}

export interface KubicPresentationState {
  session: SessionSnapshot;
  agents: ReadonlyMap<string, AgentSummary>;
  lanes: ReadonlyMap<string, LaneSnapshot>;
  workers: ReadonlyMap<string, WorkerSummary>;
  approvals: readonly ApprovalRequest[];
  usage: UsageTotals;
  connection: ConnectionState;
}

// Closed-world field coverage: §66 fixes the state shape exactly.
export const PRESENTATION_STATE_FIELDS = {
  session: true,
  agents: true,
  lanes: true,
  workers: true,
  approvals: true,
  usage: true,
  connection: true,
} satisfies Record<keyof KubicPresentationState, true>;

export const PRESENTATION_COMMANDS = [
  'agent.spawn',
  'agent.send',
  'agent.cancel',
  'approval.respond',
  'session.attach',
  'session.detach',
  'session.fork',
  'session.navigate',
  'lane.prompt',
  'lane.steer',
  'lane.followUp',
  'lane.abort',
  'lane.compact',
  'lane.resume',
  'model.select',
  'thinking.cycle',
  'worker.inspect',
  'worker.terminate',
] as const;

export type PresentationCommand = (typeof PRESENTATION_COMMANDS)[number];

export function isPresentationCommand(cmd: string): cmd is PresentationCommand {
  return (PRESENTATION_COMMANDS as readonly string[]).includes(cmd);
}
