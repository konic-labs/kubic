// KubicPresentationState event/presentation contract.
// Pure types with zero implementation imports. Every field is a replicated
// value or a keyed service instance — no field requires the presentation to
// hold authority, and commands are narrow and typed.
//
// Negative rule: there is deliberately no `eval`-style command channel, no
// raw event stream, and no way for the presentation to reach the harness
// directly. This package (core) imports nothing internal;
// `scripts/dep-lint.mjs` rejects core → host/worker/exec imports structurally.
//

// One image content part of a prompt. The
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

interface SessionSnapshot {
  sessionId: string;
  // The live session's replicated facts.
  model?: string;
  thinking?: string;
  approvalsSkipped: boolean;
}

export interface AgentSummary {
  agentId: string;
  role: string;
  status: string;
  // The agent's workspace: the repo root.
  workspace?: string;
}

// One tool call of a lane, as the presentation renders it. `args`/`entry` are
// the replicated payloads the view summarizes for display — the state never
// carries a render string the projector invented.
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
  // Queues: the prompts the conversation's inbox holds but no turn has
  // placed yet.
  queued: readonly string[];
  // A compaction is in flight / the last fault / a retry backoff.
  compacting: boolean;
  fault?: string;
  retrying?: { attempt: number; error?: string };
}

interface ApprovalRequest {
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

interface ConnectionState {
  status: 'connected' | 'disconnected' | 'reconnecting';
  detail?: string;
}

export interface KubicPresentationState {
  session: SessionSnapshot;
  agents: ReadonlyMap<string, AgentSummary>;
  lanes: ReadonlyMap<string, LaneSnapshot>;
  approvals: readonly ApprovalRequest[];
  usage: UsageTotals;
  connection: ConnectionState;
}

// Closed-world field coverage: fixes the state shape exactly.
export const PRESENTATION_STATE_FIELDS = {
  session: true,
  agents: true,
  lanes: true,
  approvals: true,
  usage: true,
  connection: true,
} satisfies Record<keyof KubicPresentationState, true>;

export const PRESENTATION_COMMANDS = [
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
] as const;

export type PresentationCommand = (typeof PRESENTATION_COMMANDS)[number];

export function isPresentationCommand(cmd: string): cmd is PresentationCommand {
  return (PRESENTATION_COMMANDS as readonly string[]).includes(cmd);
}
