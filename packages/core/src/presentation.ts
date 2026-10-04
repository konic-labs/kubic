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

export interface SessionSnapshot {
  sessionId: string;
  // Issue #333 (§66): the live session's replicated facts.
  model?: string;
  thinking?: string;
  mode: 'solo' | 'orchestrator';
  approvalsSkipped: boolean;
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

export interface WorkerSummary {
  workerId: string;
  role?: string;
  status?: string;
  workspace?: string;
  budget?: BudgetSummary;
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
