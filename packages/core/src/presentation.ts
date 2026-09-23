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
}

export interface AgentSummary {
  agentId: string;
  role: string;
  status: string;
}

export interface LaneSnapshot {
  laneId: string;
}

export interface WorkerSummary {
  workerId: string;
}

export interface ApprovalRequest {
  requestId: string;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ConnectionState {
  status: 'connected' | 'disconnected' | 'reconnecting';
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
