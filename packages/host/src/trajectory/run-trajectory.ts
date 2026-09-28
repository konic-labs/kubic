// Run → §46 trajectory (issue #383; design §46, §74, §84).
// Every settled run (solo `kubic run`, each orchestrator worker child, each
// TUI turn) persists one trajectory next to its session:
// <sessions-root>/<id>/trajectory.json. This module is the pure half: the
// run's own evidence in — session entries (actions, observations, usage),
// journal changes (the diff), ledger records (approvals), the USED spawn env
// and the settled §78 outcome — and the fail-closed exporter's record out
// (packages/trajectory/src/export.ts refuses a record without provenance, a
// used env, or a §52 category on a non-completed result).
//
// Only this run's evidence is recorded: a resumed session keeps one entry
// chain across runs, so entries, changes and approvals older than the
// run's start (or of another session) are left out.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { FileBridge } from '../../../exec/src/file-bridge.js';
import {
  type FileChange,
  unifiedHunks,
} from '../../../exec/src/journal-diff.js';
import {
  buildTrajectoryExport,
  type RawObservation,
} from '../../../trajectory/src/export.js';
import type {
  JsonValue,
  TrajectoryAction,
  TrajectoryApproval,
  TrajectoryExport,
  TrajectoryFailureCode,
  TrajectoryModelUsage,
  TrajectoryResult,
  TrajectoryResultStatus,
  TrajectoryUsage,
} from '../../../trajectory/src/schema.js';
import { classifyFailure } from '../../../worker/src/lane/failures.js';
import {
  type OperationErrorLike,
  settleTerminalStatus,
} from '../../../worker/src/lane/settle.js';
import type { TerminalStatus } from '../../../worker/src/pi-boundary.js';
import type { OrgAuditRecord } from '../policy/audit.js';
import type { RunTerminusKind } from '../run-cli.js';

export const TRAJECTORY_FILE = 'trajectory.json';

// The settled run as the composition root saw it: the §78 terminus and its
// summary, the lane's own terminal record when the lane settled, and
// whether an interrupt (SIGINT/SIGTERM/SIGHUP) ended the drive.
export interface RunOutcome {
  terminus: RunTerminusKind;
  summary: string;
  lane?: { status: TerminalStatus; error?: OperationErrorLike };
  interrupted?: boolean;
}

export interface RunTrajectoryInput {
  sessionId: string;
  agentId: string;
  // The orchestrator worker id (KUBIC_WORKER_ID); null on a solo run.
  workerId: string | null;
  // The role the lane ran as: 'solo', or the `--role` name.
  role: string;
  prompt: string;
  // The session's stored entries (any order; older runs filtered here).
  entries: readonly unknown[];
  model: { provider: string; id: string; thinking: string | null };
  pid: number | null;
  generation: number;
  // The workspace the run executed in (a worker's worktree), absolute.
  cwd: string;
  baseRevision: string;
  branch: string | null;
  // The USED tool spawn env (toolSpawnEnv): recorded verbatim.
  env: Record<string, string>;
  changes: readonly FileChange[];
  approvals: readonly OrgAuditRecord[];
  skills: string[];
  startedAt: number;
  endedAt: number;
  outcome: RunOutcome;
}

// Two runs of one prompt answer the same task, so they can form a §74
// preference pair (#269 refuses pairs across tasks); the id is a digest of
// the prompt text — stable, and never the prompt itself.
export function taskIdForPrompt(prompt: string): string {
  return `prompt:${createHash('sha256').update(prompt).digest('hex').slice(0, 16)}`;
}

interface StoredEntry {
  seq: number;
  timestamp: number;
  role: string;
  message: Record<string, unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// This run's message entries, in chain order.
function runEntries(
  entries: readonly unknown[],
  startedAt: number,
): StoredEntry[] {
  const out: StoredEntry[] = [];
  for (const entry of entries) {
    if (!isObject(entry) || entry.type !== 'message') continue;
    if (!isObject(entry.message)) continue;
    const timestamp = num(entry.timestamp);
    if (timestamp < startedAt) continue;
    const role = entry.message.role;
    if (typeof role !== 'string') continue;
    out.push({ seq: num(entry.seq), timestamp, role, message: entry.message });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        isObject(part) && part.type === 'text' && typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('\n');
}

function actionsAndObservations(entries: StoredEntry[]): {
  actions: TrajectoryAction[];
  observations: RawObservation[];
} {
  const actions: TrajectoryAction[] = [];
  const observations: RawObservation[] = [];
  const actionSeqByCall = new Map<string, number>();
  for (const entry of entries) {
    if (entry.role === 'assistant' && Array.isArray(entry.message.content)) {
      for (const part of entry.message.content) {
        if (!isObject(part) || part.type !== 'toolCall') continue;
        const seq = actions.length + 1;
        actions.push({
          seq,
          tool: typeof part.name === 'string' ? part.name : 'unknown',
          args: (part.arguments ?? null) as JsonValue,
        });
        if (typeof part.id === 'string') actionSeqByCall.set(part.id, seq);
      }
    }
    if (entry.role === 'toolResult') {
      const callId = entry.message.toolCallId;
      const actionSeq =
        typeof callId === 'string' ? actionSeqByCall.get(callId) : undefined;
      // A result whose call is not in this run has nothing to observe.
      if (actionSeq === undefined) continue;
      observations.push({
        seq: observations.length + 1,
        actionSeq,
        output: textOf(entry.message.content),
      });
    }
  }
  return { actions, observations };
}

function round(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

function usageOf(entries: StoredEntry[]): TrajectoryUsage {
  const total: TrajectoryUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    requests: 0,
    costUsd: 0,
    byModel: {},
  };
  for (const entry of entries) {
    if (entry.role !== 'assistant' || !isObject(entry.message.usage)) continue;
    const usage = entry.message.usage;
    const cost = isObject(usage.cost) ? num(usage.cost.total) : 0;
    total.inputTokens += num(usage.input);
    total.outputTokens += num(usage.output);
    total.cachedTokens += num(usage.cacheRead);
    total.requests += 1;
    total.costUsd = round(total.costUsd + cost);
    const key = `${String(entry.message.provider ?? 'unknown')}/${String(entry.message.model ?? 'unknown')}`;
    const row: TrajectoryModelUsage = total.byModel[key] ?? {
      requests: 0,
      input: 0,
      output: 0,
      costTotal: 0,
    };
    row.requests += 1;
    row.input += num(usage.input);
    row.output += num(usage.output);
    row.costTotal = round(row.costTotal + cost);
    total.byModel[key] = row;
  }
  return total;
}

function diffOf(
  changes: readonly FileChange[],
  sessionId: string,
  startedAt: number,
): TrajectoryExport['diff'] {
  const mine = changes.filter(
    (change) => change.sessionId === sessionId && change.timestamp >= startedAt,
  );
  const filesChanged = [...new Set(mine.map((change) => change.path))];
  return {
    filesChanged,
    files: mine.map((change) => ({
      path: change.path,
      // A deliberately omitted after-side (binary or oversized) has no
      // text to diff: the path is recorded, the hunks are not invented.
      hunks: change.afterOmitted
        ? []
        : unifiedHunks(change.before ?? '', change.after ?? ''),
    })),
  };
}

function verdictOf(record: OrgAuditRecord): TrajectoryApproval['verdict'] {
  if (record.result === 'ok') return 'approved';
  return /timed? ?out/i.test(record.reason) ? 'timed-out' : 'denied';
}

function approvalsOf(
  records: readonly OrgAuditRecord[],
  sessionId: string,
  startedAt: number,
): TrajectoryApproval[] {
  return records
    .filter(
      (record) =>
        record.agent?.session === sessionId &&
        Date.parse(record.when) >= startedAt,
    )
    .map((record, index) => ({
      approvalId: `${sessionId}:${index + 1}`,
      capability: record.permission.permission,
      verdict: verdictOf(record),
      by: record.who === '' ? null : record.who,
    }));
}

// §78 terminus → §46 result status + §52 category. A non-completed result
// always carries a category (the exporter refuses one without): lane
// failures go through the §52 taxonomy, guard and gate termini name their
// own code, and a failure outside the lane (boot, interrupt) is a process
// failure.
export function trajectoryResultFor(outcome: RunOutcome): TrajectoryResult {
  const { terminus, summary } = outcome;
  if (terminus === 'completed') {
    return { status: 'completed', summary, failureCategory: null, error: null };
  }
  let status: TrajectoryResultStatus = 'failed';
  let category: TrajectoryFailureCode;
  switch (terminus) {
    case 'budget_exhausted':
      status = /timed out/.test(summary) ? 'timeout' : 'budget_exhausted';
      category = 'budget_exhausted';
      break;
    case 'approval_denied':
      category = 'approval_denied';
      break;
    case 'approval_timed_out':
      category = 'approval_timed_out';
      break;
    case 'workspace_unavailable':
      category = 'workspace_failed';
      break;
    case 'provider_probe_failed':
      category = classifyFailure('provider', '', summary).code;
      break;
    default: {
      const lane = outcome.lane;
      if (lane !== undefined) {
        const settled = settleTerminalStatus(lane.status, lane.error);
        status = settled.status === 'cancelled' ? 'cancelled' : 'failed';
        category =
          settled.error === undefined || lane.error === undefined
            ? 'process_crashed'
            : classifyFailure(
                settled.error.kind,
                lane.error.code,
                lane.error.message,
              ).code;
      } else {
        if (outcome.interrupted === true) status = 'cancelled';
        category = 'process_crashed';
      }
    }
  }
  return {
    status,
    summary,
    failureCategory: category,
    error: { kind: terminus, message: summary },
  };
}

export function assembleRunTrajectory(
  input: RunTrajectoryInput,
): TrajectoryExport {
  const entries = runEntries(input.entries, input.startedAt);
  const { actions, observations } = actionsAndObservations(entries);
  const taskId = taskIdForPrompt(input.prompt);
  const modelRef = `${input.model.provider}/${input.model.id}`;
  const result = trajectoryResultFor(input.outcome);
  return buildTrajectoryExport({
    task: { taskId, objective: input.prompt, role: input.role },
    identity: {
      sessionId: input.sessionId,
      agentId: input.agentId,
      workerId: input.workerId,
    },
    model: {
      provider: input.model.provider,
      model: input.model.id,
      thinking: input.model.thinking,
      escalations: [],
    },
    prompt: { text: input.prompt, constraints: [] },
    resources: { skills: input.skills, promptTemplates: [] },
    transfer: { taskId, worktree: input.cwd, grantRef: `role:${input.role}` },
    actions,
    observations,
    state: { phase: input.outcome.terminus, snapshot: null },
    provenance: {
      sessionId: input.sessionId,
      agentId: input.agentId,
      pid: input.pid,
      generation: input.generation,
      worktree: input.cwd,
      model: modelRef,
    },
    environment: { capturedFrom: 'used', cwd: input.cwd, env: input.env },
    worktree: {
      path: input.cwd,
      baseRevision: input.baseRevision,
      branch: input.branch,
    },
    diff: diffOf(input.changes, input.sessionId, input.startedAt),
    approvals: approvalsOf(input.approvals, input.sessionId, input.startedAt),
    timestamps: {
      startedAt: new Date(input.startedAt).toISOString(),
      endedAt: new Date(input.endedAt).toISOString(),
    },
    usage: usageOf(entries),
    result,
  });
}

// Persist next to the session (bridge rooted at the sessions root) and
// return the absolute path — the ref `kubic run` prints resolves to it.
export function writeRunTrajectory(
  bridge: FileBridge,
  sessionId: string,
  exported: TrajectoryExport,
): string {
  const path = join(sessionId, TRAJECTORY_FILE);
  bridge.writeFile(path, `${JSON.stringify(exported, null, 2)}\n`);
  return bridge.absolutePath(path);
}
