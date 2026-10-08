// Run → trajectory.
// Every settled run (`kubic run`, each TUI turn) persists one trajectory
// next to its session:
// <sessions-root>/<id>/trajectory.json. This module is the pure half: the
// run's own evidence in — session entries (actions, observations, usage),
// journal changes (the diff), ledger records (approvals), the USED spawn env
// and the settled outcome — and the fail-closed exporter's record out
// (packages/trajectory/src/export.ts refuses a record without provenance, a
// used env, or a failure category on a non-completed result).
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
  TrajectoryEscalation,
  TrajectoryExport,
  TrajectoryFailureCode,
  TrajectoryModelUsage,
  TrajectoryResult,
  TrajectoryResultStatus,
  TrajectoryUsage,
} from '../../../trajectory/src/schema.js';
import { classifyFailure } from '../../../worker/src/lane/failures.js';
import {
  classifyHarnessError,
  type OperationErrorLike,
} from '../../../worker/src/lane/settle.js';
import {
  entriesToTranscript,
  type TranscriptItem,
} from '../../../worker/src/lane/transcript.js';
import type { EntryRecord } from '../../../worker/src/pi-boundary.js';
import type { OrgAuditRecord } from '../policy/audit.js';
import type { RunTerminusKind } from '../run-cli.js';

export const TRAJECTORY_FILE = 'trajectory.json';

// The settled run as the composition root saw it: the terminus and its
// summary, the lane's own terminal record when the lane settled, and
// whether an interrupt (SIGINT/SIGTERM/SIGHUP) ended the drive.
export interface RunOutcome {
  terminus: RunTerminusKind;
  summary: string;
  // The lane's terminal record: its outcome kind
  // ('completed' | 'failed' | 'aborted') and, for a failure, the lane error
  // that explains it.
  lane?: { status: string; error?: OperationErrorLike };
  interrupted?: boolean;
}

export interface RunTrajectoryInput {
  sessionId: string;
  agentId: string;
  // The role the lane ran as: 'solo', or the `--role` name.
  role: string;
  prompt: string;
  // The session's durable entries (any order; older runs filtered here).
  entries: readonly unknown[];
  model: { provider: string; id: string; thinking: string | null };
  pid: number | null;
  generation: number;
  // The workspace the run executed in, absolute.
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
  // The run verifier's `signal:*` labels; absent means none —
  // every gate stays unknown.
  evalLabels?: Record<string, string>;
  // The lane's escalation record: every model climb this
  // run recorded, oldest first. Absent means no climb — never an empty
  // array from a lane that cannot climb.
  escalations?: TrajectoryEscalation[];
}

// Two runs of one prompt answer the same task, so they can form a
// preference pair; the id is a digest of
// the prompt text — stable, and never the prompt itself.
export function taskIdForPrompt(prompt: string): string {
  return `prompt:${createHash('sha256').update(prompt).digest('hex').slice(0, 16)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// A durable entry as far as this module needs to identify one: the entry
// record shape `Storage.scanEntries` returns. Anything else (a foreign object)
// is skipped, never guessed at.
function isEntryRecord(value: unknown): value is EntryRecord {
  return (
    isObject(value) &&
    typeof value.id === 'number' &&
    typeof value.kind === 'string'
  );
}

// When the entry was written: the newest timestamp among its model messages.
// Entries carry no timestamp of their own (entry ids are the only order);
// the messages they contribute do. An entry with no stamped message (a
// bookkeeping entry, a positional prompt update) has no place in a run's
// evidence and is filtered out.
function entryTimestamp(entry: EntryRecord): number | undefined {
  if (!Array.isArray(entry.model)) return undefined;
  let newest: number | undefined;
  for (const message of entry.model) {
    if (!isObject(message)) continue;
    const timestamp = message.timestamp;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) continue;
    if (newest === undefined || timestamp > newest) newest = timestamp;
  }
  return newest;
}

// This run's durable entries, in transcript order. The run-start boundary is
// inclusive.
function runEntries(
  entries: readonly unknown[],
  startedAt: number,
): EntryRecord[] {
  const out: EntryRecord[] = [];
  for (const entry of entries) {
    if (!isEntryRecord(entry)) continue;
    const timestamp = entryTimestamp(entry);
    if (timestamp === undefined || timestamp < startedAt) continue;
    out.push(entry);
  }
  return out;
}

function actionsAndObservations(items: readonly TranscriptItem[]): {
  actions: TrajectoryAction[];
  observations: RawObservation[];
} {
  const actions: TrajectoryAction[] = [];
  const observations: RawObservation[] = [];
  const actionSeqByCall = new Map<string, number>();
  for (const item of items) {
    if (item.kind === 'assistant') {
      for (const call of item.toolCalls) {
        const seq = actions.length + 1;
        actions.push({
          seq,
          tool: call.name === '' ? 'unknown' : call.name,
          args: (call.args ?? null) as JsonValue,
        });
        if (call.id !== '') actionSeqByCall.set(call.id, seq);
      }
    }
    if (item.kind === 'tool-result') {
      const actionSeq = actionSeqByCall.get(item.callId);
      // A result whose call is not in this run has nothing to observe.
      if (actionSeq === undefined) continue;
      observations.push({
        seq: observations.length + 1,
        actionSeq,
        output: item.text,
      });
    }
  }
  return { actions, observations };
}

function round(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

function usageOf(items: readonly TranscriptItem[]): TrajectoryUsage {
  const total: TrajectoryUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    requests: 0,
    costUsd: 0,
    byModel: {},
  };
  for (const item of items) {
    if (item.kind !== 'assistant' || item.usage === undefined) continue;
    const usage = item.usage;
    const cost = num(usage.cost?.total);
    total.inputTokens += num(usage.input);
    total.outputTokens += num(usage.output);
    total.cachedTokens += num(usage.cacheRead);
    total.requests += 1;
    total.costUsd = round(total.costUsd + cost);
    const key = `${item.provider ?? 'unknown'}/${item.model ?? 'unknown'}`;
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

// The thinking level the run actually ended at: the newest
// assistant response's `thinkingLevel`. Recorded in `model.thinking` when
// the caller could not name one (a resumed session, a lane that escalated).
function thinkingLevelOf(items: readonly TranscriptItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind !== 'assistant') continue;
    if (item.thinkingLevel !== undefined) return item.thinkingLevel;
  }
  return null;
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

// Terminus → result status + failure category. A non-completed result
// always carries a category (the exporter refuses one without): lane
// failures go through the taxonomy, guard and gate termini name their
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
    case 'turn_limit':
      status = 'turn_limit';
      category = 'run_limit';
      break;
    case 'timeout':
      // A wall-clock bound is its own terminus; its category is the
      // guard's, like the turn limit.
      status = 'timeout';
      category = 'run_limit';
      break;
    case 'cancelled':
      status = 'cancelled';
      category = 'process_crashed';
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
    // A mid-run provider error keeps its own terminus — 6
    // is the pre-run probe, never a transient/auth failure during the run.
    case 'provider_transient':
    case 'provider_auth':
      category = classifyFailure('provider', terminus, summary).code;
      break;
    default: {
      const lane = outcome.lane;
      if (lane !== undefined) {
        // The lane's own terminal record: an aborted/declined lane is a
        // cancellation, everything else a failure, and a failure without a
        // named error is a process failure (never an invented category).
        status =
          lane.status === 'aborted' || lane.status === 'declined'
            ? 'cancelled'
            : 'failed';
        category =
          lane.error === undefined
            ? 'process_crashed'
            : classifyFailure(
                classifyHarnessError(lane.error.code, lane.error.message).kind,
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
  const items = entriesToTranscript(entries);
  const { actions, observations } = actionsAndObservations(items);
  const taskId = taskIdForPrompt(input.prompt);
  const modelRef = `${input.model.provider}/${input.model.id}`;
  const result = trajectoryResultFor(input.outcome);
  return buildTrajectoryExport({
    task: {
      taskId,
      objective: input.prompt,
      role: input.role,
    },
    identity: {
      sessionId: input.sessionId,
      agentId: input.agentId,
      workerId: null,
    },
    model: {
      provider: input.model.provider,
      model: input.model.id,
      // A caller that cannot name the level still records the one the
      // responses actually ran at.
      thinking: input.model.thinking ?? thinkingLevelOf(items),
      escalations: input.escalations ?? [],
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
    usage: usageOf(items),
    result,
    eval: {
      suite: null,
      caseId: null,
      labels: { ...(input.evalLabels ?? {}) },
    },
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
