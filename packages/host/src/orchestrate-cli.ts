// `kubic orchestrate` (issue #76; §5.2, §9/§9.1, §44, §41.1, §78).
// Opt-in orchestrator entry: plans N workers, spawns them in git worktrees,
// settles/merges FIFO through the merge queue with per-agent attribution,
// routes merge approvals to the user, and reaps. Session-scoped with
// crash-resume: merge state persists per session, so a kill mid-run
// re-attaches and continues (or fails closed) — merges apply strictly
// one-at-a-time in queue order, so the tree is never half-merged. The
// manager authors nothing: every merge passes assertManagerZeroWrites over
// the merge-path trace first. Solo stays the default — this command never
// falls back to solo (outside a git repo it refuses with exit 2).
// Host owns presentation + orchestration only: git, processes, and files
// arrive injected (fakes in tests, the exec seam in prod via
// apps/kubic/src/orchestrate-run.ts).

import type {
  AttributedHunk,
  MergedHunk,
} from './orchestrator/merge/attribution.js';
import { attributeMergedHunks } from './orchestrator/merge/attribution.js';
import { createMergeQueue } from './orchestrator/merge/queue.js';
import { assertManagerZeroWrites } from './orchestrator/merge/settle.js';
import { ParallelScheduler } from './orchestrator/parallel/scheduler.js';
import { validateAgentId } from './orchestrator/worktree/naming.js';
import {
  RUN_EXIT_APPROVAL_DENIED,
  RUN_EXIT_FAILED,
  RUN_EXIT_OK,
  RUN_EXIT_USAGE,
  SESSION_ID_PATTERN,
} from './run-cli.js';

export const ORCHESTRATE_DEFAULT_AGENTS: string[] = ['worker-1', 'worker-2'];

export function orchestrateUsage(out: (line: string) => void): number {
  out(
    'usage: kubic orchestrate -p <prompt> [--agents <a,b>] [--session <id>] [--resume] [--yes] [--json]',
  );
  return RUN_EXIT_USAGE;
}

export class MergeConflictError extends Error {
  agentId: string;
  oursDiff: string;
  theirsDiff: string;

  constructor(
    agentId: string,
    diffs: { oursDiff: string; theirsDiff: string },
  ) {
    super(
      `merge conflict for worker '${agentId}': unresolvable automatically — queue stopped, candidates preserved`,
    );
    this.name = 'MergeConflictError';
    this.agentId = agentId;
    this.oursDiff = diffs.oursDiff;
    this.theirsDiff = diffs.theirsDiff;
  }
}

export interface OrchestratedWorkerRecord {
  agentId: string;
  branch: string;
  hunks: MergedHunk[];
}

export interface OrchestratorRunState {
  version: 1;
  sessionId: string;
  prompt: string;
  agents: string[];
  merged: string[];
  pending: string[];
  stopped: boolean;
  blocked?: { agentId: string; oursDiff: string; theirsDiff: string };
  records: OrchestratedWorkerRecord[];
  // Write-ahead merge intent (issue #76 fix): set to the agent being
  // merged BEFORE the merge runs, cleared after the outcome is recorded.
  // A kill between merge success and the post-merge save leaves the
  // branch merged on disk but still pending in state — on resume the
  // intent identifies the in-flight agent so the branch is checked with
  // isBranchMerged and marked merged WITHOUT re-running the worker.
  merging?: string | null;
}

// Stored resume state is untrusted JSON (a torn write, a hand edit, or
// a newer version could land here). Structural validation: anything
// that is not exactly a v1 state for this session is rejected, so
// resume fails closed with no_orchestrator_state instead of crashing
// on undefined.map / .push mid-run.
export function parseOrchestratorRunState(
  raw: unknown,
  sessionId: string,
): OrchestratorRunState | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || value.sessionId !== sessionId) return undefined;
  if (typeof value.prompt !== 'string') return undefined;
  if (
    !Array.isArray(value.agents) ||
    !value.agents.every((entry) => typeof entry === 'string')
  ) {
    return undefined;
  }
  if (
    !Array.isArray(value.merged) ||
    !value.merged.every((entry) => typeof entry === 'string')
  ) {
    return undefined;
  }
  if (
    !Array.isArray(value.pending) ||
    !value.pending.every((entry) => typeof entry === 'string')
  ) {
    return undefined;
  }
  if (typeof value.stopped !== 'boolean') return undefined;
  if (!Array.isArray(value.records)) return undefined;
  for (const record of value.records) {
    if (typeof record !== 'object' || record === null) return undefined;
    const entry = record as Record<string, unknown>;
    if (typeof entry.agentId !== 'string') return undefined;
    if (typeof entry.branch !== 'string') return undefined;
    if (!Array.isArray(entry.hunks)) return undefined;
  }
  if (value.blocked !== undefined) {
    if (typeof value.blocked !== 'object' || value.blocked === null) {
      return undefined;
    }
    const blocked = value.blocked as Record<string, unknown>;
    if (typeof blocked.agentId !== 'string') return undefined;
    if (typeof blocked.oursDiff !== 'string') return undefined;
    if (typeof blocked.theirsDiff !== 'string') return undefined;
  }
  if (
    value.merging !== undefined &&
    value.merging !== null &&
    typeof value.merging !== 'string'
  ) {
    return undefined;
  }
  return raw as OrchestratorRunState;
}

export class OrchestratorStateSaveError extends Error {
  reason: string;

  constructor(sessionId: string, reason: string) {
    super(
      `orchestrator state save failed for session '${sessionId}': ${reason}`,
    );
    this.name = 'OrchestratorStateSaveError';
    this.reason = reason;
  }
}

export interface OrchestrateWorktree {
  path: string;
  branch: string;
}

export interface ApprovalInput {
  agentId: string;
  branch: string;
}

export interface OrchestrateCommandDeps {
  out: (line: string) => void;
  debug?: (line: string) => void;
  now?: () => number;
  isGitRepo: () => boolean | Promise<boolean>;
  ensureWorktree: (
    agentId: string,
  ) => OrchestrateWorktree | Promise<OrchestrateWorktree>;
  runWorker: (
    agentId: string,
    worktree: OrchestrateWorktree,
    prompt: string,
    info?: { sessionId: string },
  ) => MergedHunk[] | Promise<MergedHunk[]>;
  mergeBranch: (
    agentId: string,
    worktree: OrchestrateWorktree,
  ) => void | Promise<void>;
  // Pre-merge guard (issue #76 fix a): abort a stale MERGE_HEAD left by
  // a kill-during-merge and refuse a dirty tree BEFORE the merge runs,
  // so resume never merges onto a half-merged tree. Optional so older
  // fakes keep working; absent means no guard (prod always provides it).
  prepareMerge?: (
    agentId: string,
    worktree: OrchestrateWorktree,
  ) => void | Promise<void>;
  // Already-merged probe (issue #76 fix b): true when the worker branch
  // is an ancestor of the merge target (git merge-base --is-ancestor in
  // prod). Used on resume to reconcile a leftover merging intent.
  // Absent means unknown — resume retries the worker (fail-closed
  // toward redoing work, never toward skipping a merge).
  isBranchMerged?: (
    agentId: string,
    worktree: OrchestrateWorktree,
  ) => boolean | Promise<boolean>;
  reapWorker: (agentId: string) => void | Promise<void>;
  requestApproval?: (input: ApprovalInput) => boolean | Promise<boolean>;
  loadState?: (
    sessionId: string,
  ) =>
    | OrchestratorRunState
    | undefined
    | Promise<OrchestratorRunState | undefined>;
  saveState?: (state: OrchestratorRunState) => void | Promise<void>;
}

export type OrchestrateStatus =
  | 'completed'
  | 'failed'
  | 'usage'
  | 'approval_denied'
  | 'merge_conflict';

export interface OrchestrateEnvelope {
  ok: boolean;
  exitCode: number;
  sessionId: string;
  status: OrchestrateStatus;
  workers: { agentId: string; branch: string; hunks: number }[];
  mergeOrder: string[];
  attribution: AttributedHunk[];
  error?: { kind: string; message: string; code: string };
}

// The manager-side merge-path trace (§9.2, issue #46): spawn, diff, merge,
// apply only — every entry is on MANAGER_MERGE_ALLOWLIST, so the manager
// merges worker-produced diffs but never authors. Pinned here so the
// zero-writes invariant is observable without running a session.
export function managerCallsForMerge(): string[] {
  return [
    'spawn_agent',
    'workspace_diff',
    'workspace_merge',
    'workspace_apply',
  ];
}

interface ParsedArgs {
  prompt?: string;
  agents: string[];
  sessionId?: string;
  resume: boolean;
  autoApprove: boolean;
  json: boolean;
}

function parseAgents(raw: string): string[] | undefined {
  const agents = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (agents.length === 0) return undefined;
  if (new Set(agents).size !== agents.length) return undefined;
  for (const agent of agents) {
    if (validateAgentId(agent).length > 0) return undefined;
  }
  return agents;
}

function parseArgs(args: string[]): ParsedArgs | undefined {
  const parsed: ParsedArgs = {
    agents: [...ORCHESTRATE_DEFAULT_AGENTS],
    resume: false,
    autoApprove: false,
    json: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '-p' || arg === '--prompt') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) return undefined;
      parsed.prompt = value;
      i += 1;
    } else if (arg === '--agents') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) return undefined;
      const agents = parseAgents(value);
      if (agents === undefined) return undefined;
      parsed.agents = agents;
      i += 1;
    } else if (arg === '--session') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) return undefined;
      parsed.sessionId = value;
      i += 1;
    } else if (arg === '--resume') {
      parsed.resume = true;
    } else if (arg === '--yes') {
      parsed.autoApprove = true;
    } else if (arg === '--json') {
      parsed.json = true;
    } else {
      return undefined;
    }
  }
  return parsed;
}

function statusForExit(exitCode: number, code: string): OrchestrateStatus {
  if (exitCode === RUN_EXIT_OK) return 'completed';
  if (exitCode === RUN_EXIT_USAGE) return 'usage';
  if (exitCode === RUN_EXIT_APPROVAL_DENIED) return 'approval_denied';
  if (code === 'merge_conflict') return 'merge_conflict';
  return 'failed';
}

export async function runOrchestrateCommand(
  args: string[],
  deps: OrchestrateCommandDeps,
): Promise<number> {
  const now = deps.now ?? Date.now;
  const debug = deps.debug ?? (() => undefined);
  const parsed = parseArgs(args);
  if (parsed === undefined) return orchestrateUsage(deps.out);
  if (parsed.resume && parsed.sessionId === undefined) {
    return orchestrateUsage(deps.out);
  }
  if (
    parsed.sessionId !== undefined &&
    !SESSION_ID_PATTERN.test(parsed.sessionId)
  ) {
    deps.out(
      `error: invalid --session id ${JSON.stringify(parsed.sessionId)} (use [A-Za-z0-9_-])`,
    );
    return RUN_EXIT_USAGE;
  }
  const sessionId = parsed.sessionId ?? `orch-${now()}`;

  const emit = (envelope: OrchestrateEnvelope, textLines: string[]): number => {
    if (parsed.json) {
      deps.out(JSON.stringify(envelope));
    } else {
      for (const line of textLines) deps.out(line);
      if (envelope.error !== undefined) {
        deps.out(
          `error: ${envelope.error.message} code=${envelope.error.code}`,
        );
      }
    }
    return envelope.exitCode;
  };
  const fail = (
    exitCode: number,
    code: string,
    message: string,
    partial?: Pick<
      OrchestrateEnvelope,
      'workers' | 'mergeOrder' | 'attribution'
    >,
  ): number => {
    const status = statusForExit(exitCode, code);
    return emit(
      {
        ok: false,
        exitCode,
        sessionId,
        status,
        workers: partial?.workers ?? [],
        mergeOrder: partial?.mergeOrder ?? [],
        attribution: partial?.attribution ?? [],
        error: { kind: status, message, code },
      },
      [`session: ${sessionId}`],
    );
  };

  if (parsed.prompt === undefined && !parsed.resume) {
    return orchestrateUsage(deps.out);
  }
  if (!(await deps.isGitRepo())) {
    deps.out(
      'error: orchestrator mode needs a git repository — run solo here (`kubic run -p <prompt>`) or retry inside a git checkout (orchestrator never falls back to solo)',
    );
    if (parsed.json) {
      return fail(RUN_EXIT_USAGE, 'not_a_repo', 'not a git repository');
    }
    deps.out(
      'usage: kubic orchestrate -p <prompt> [--agents <a,b>] [--session <id>] [--resume] [--yes] [--json]',
    );
    return RUN_EXIT_USAGE;
  }

  // Resume: re-attach to the stored session. The stored payload is
  // untrusted JSON — anything malformed fails closed here as
  // no_orchestrator_state. A stopped queue also fails closed here —
  // blocked candidates are re-reported, never retried silently.
  let state: OrchestratorRunState;
  if (parsed.resume) {
    const loaded = await deps.loadState?.(sessionId);
    const resumed =
      loaded === undefined
        ? undefined
        : parseOrchestratorRunState(loaded, sessionId);
    if (resumed === undefined) {
      return fail(
        RUN_EXIT_FAILED,
        'no_orchestrator_state',
        `no orchestrator state for session '${sessionId}' — start a run first, then --resume to continue it`,
      );
    }
    if (resumed.stopped) {
      return fail(
        RUN_EXIT_FAILED,
        'merge_conflict',
        `merge queue stopped by the unresolvable conflict on '${resumed.blocked?.agentId ?? 'unknown'}': candidates preserved, nothing merged on resume`,
        {
          workers: resumed.records.map((record) => ({
            agentId: record.agentId,
            branch: record.branch,
            hunks: record.hunks.length,
          })),
          mergeOrder: resumed.merged,
          attribution: resumed.records.flatMap((record) =>
            attributeMergedHunks(record.hunks, record.agentId),
          ),
        },
      );
    }
    state = resumed;
  } else {
    state = {
      version: 1,
      sessionId,
      prompt: parsed.prompt as string,
      agents: parsed.agents,
      merged: [],
      pending: [...parsed.agents],
      stopped: false,
      records: [],
    };
  }
  const prompt = parsed.prompt ?? state.prompt;
  const queue = createMergeQueue();
  const scheduler = new ParallelScheduler();
  const worktrees = new Map<string, OrchestrateWorktree>();
  const hunksByAgent = new Map<string, MergedHunk[]>();
  for (const record of state.records) {
    hunksByAgent.set(record.agentId, record.hunks);
  }

  const partial = (): Pick<
    OrchestrateEnvelope,
    'workers' | 'mergeOrder' | 'attribution'
  > => ({
    workers: state.agents.map((agentId) => {
      const record = state.records.find((entry) => entry.agentId === agentId);
      const hunks = hunksByAgent.get(agentId) ?? [];
      return {
        agentId,
        branch: record?.branch ?? `kubic/${agentId}`,
        hunks: hunks.length,
      };
    }),
    mergeOrder: [...state.merged],
    attribution: state.records.flatMap((record) =>
      attributeMergedHunks(record.hunks, record.agentId),
    ),
  });

  const reapSpawned = async (
    spawned: string[],
  ): Promise<{ agentId: string; message: string } | undefined> => {
    for (const agentId of spawned) {
      try {
        await deps.reapWorker(agentId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { agentId, message };
      }
    }
    return undefined;
  };

  // Fail-closed state save (issue #76 fix c): a store throw used to
  // escape as an unhandled rejection (or, in prod, be swallowed to
  // debug-only). Now every save maps to a machine-readable
  // state_save_failed envelope — the run never proceeds merge-side
  // without its state persisted.
  const saveOrFail = async (
    next: OrchestratorRunState,
  ): Promise<number | undefined> => {
    try {
      await deps.saveState?.(next);
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(
        RUN_EXIT_FAILED,
        'state_save_failed',
        `orchestrator state save failed for session '${next.sessionId}': ${message}`,
        partial(),
      );
    }
  };

  // Reconcile a leftover write-ahead merge intent (issue #76 fix b).
  // A kill between merge success and the post-merge save leaves the
  // branch merged on disk but still pending in state. When the intent
  // names such a branch (merge-base --is-ancestor in prod), mark it
  // merged WITHOUT re-running the worker — no double-merge. When the
  // branch is not merged (kill before the merge, or a failed merge),
  // drop the stale intent so the normal path retries the worker behind
  // the pre-merge guard. Unknown (no isBranchMerged probe) retries.
  const reconcileMergeIntent = async (): Promise<number | undefined> => {
    const inFlight = state.merging;
    if (inFlight === undefined || inFlight === null) return undefined;
    if (!state.pending.includes(inFlight)) {
      state = { ...state, merging: undefined };
      return undefined;
    }
    let worktree: OrchestrateWorktree;
    try {
      worktree = await deps.ensureWorktree(inFlight);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(
        RUN_EXIT_FAILED,
        'spawn_failed',
        `spawn failed for worker '${inFlight}': ${message}`,
        partial(),
      );
    }
    worktrees.set(inFlight, worktree);
    let alreadyMerged = false;
    try {
      alreadyMerged =
        (await deps.isBranchMerged?.(inFlight, worktree)) === true;
    } catch {
      alreadyMerged = false;
    }
    if (!alreadyMerged) {
      state = { ...state, merging: undefined };
      return undefined;
    }
    if (!state.records.some((record) => record.agentId === inFlight)) {
      state.records.push({
        agentId: inFlight,
        branch: worktree.branch,
        hunks: [],
      });
    }
    state.merged.push(inFlight);
    state.pending = state.pending.filter((entry) => entry !== inFlight);
    state = { ...state, merging: undefined };
    debug(
      `reconciled: ${inFlight} (branch ${worktree.branch}) already merged — skipped re-run`,
    );
    const saveFailure = await saveOrFail(state);
    if (saveFailure !== undefined) return saveFailure;
    return undefined;
  };

  // Spawn + run every pending worker, then enqueue in agent order. A kill
  // here leaves pending intact in the saved state, so resume retries the
  // workers that never reported — merged workers are never re-run.
  const spawned: string[] = [];
  {
    const reconcileFailure = await reconcileMergeIntent();
    if (reconcileFailure !== undefined) return reconcileFailure;
  }
  {
    const saveFailure = await saveOrFail(state);
    if (saveFailure !== undefined) return saveFailure;
  }
  for (const agentId of state.pending) {
    // Resume may already hold this worktree (intent reconciliation
    // resolved it for the isBranchMerged probe) — never ensure twice.
    let worktree = worktrees.get(agentId);
    if (worktree === undefined) {
      try {
        worktree = await deps.ensureWorktree(agentId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failure = await reapSpawned(spawned);
        void failure;
        return fail(
          RUN_EXIT_FAILED,
          'spawn_failed',
          `spawn failed for worker '${agentId}': ${message}`,
          partial(),
        );
      }
      worktrees.set(agentId, worktree);
    }
    spawned.push(agentId);
    const admission = scheduler.requestSpawn(
      { agentId, sessionId, worktree: worktree.path },
      'autonomous',
    );
    if (admission.outcome === 'denied') {
      const failure = await reapSpawned(spawned);
      void failure;
      return fail(
        RUN_EXIT_FAILED,
        'spawn_denied',
        `spawn denied for worker '${agentId}': ${admission.reason}`,
        partial(),
      );
    }
    if (admission.outcome === 'queued') {
      debug(`queued: worker '${agentId}' at position ${admission.position}`);
    }
    try {
      const hunks = await deps.runWorker(agentId, worktree, prompt, {
        sessionId,
      });
      hunksByAgent.set(agentId, [...hunks]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await reapSpawned(spawned);
      return fail(
        RUN_EXIT_FAILED,
        'worker_failed',
        `worker '${agentId}' failed: ${message}`,
        partial(),
      );
    }
    queue.enqueue({ agentId, branch: worktree.branch });
    debug(`spawn: worker '${agentId}' in ${worktree.path}`);
  }

  // Settle FIFO: approve → persist the write-ahead merge intent →
  // pre-merge guard → prove the manager trace write-free → merge →
  // attribute → record. Each merge is atomic per candidate and recorded
  // before the next dequeues, so a kill between merges resumes cleanly.
  let candidate = queue.dequeue();
  while (candidate !== undefined) {
    const { agentId } = candidate;
    const worktree = worktrees.get(agentId) as OrchestrateWorktree;
    const approved = parsed.autoApprove
      ? true
      : await deps.requestApproval?.({ agentId, branch: worktree.branch });
    if (approved !== true) {
      const saveFailure = await saveOrFail(state);
      if (saveFailure !== undefined) {
        await reapSpawned(spawned);
        return saveFailure;
      }
      await reapSpawned(spawned);
      return fail(
        RUN_EXIT_APPROVAL_DENIED,
        'approval_denied',
        `approval denied for worker '${agentId}': the decider is the user — rerun with --yes to auto-approve merges`,
        partial(),
      );
    }
    state = { ...state, merging: agentId };
    {
      const saveFailure = await saveOrFail(state);
      if (saveFailure !== undefined) {
        await reapSpawned(spawned);
        return saveFailure;
      }
    }
    try {
      // Pre-merge guard (fix a): a kill-during-merge can leave a stale
      // MERGE_HEAD behind — abort it and refuse a dirty tree BEFORE the
      // merge runs, so resume never merges onto a half-merged tree.
      await deps.prepareMerge?.(agentId, worktree);
      assertManagerZeroWrites(managerCallsForMerge());
      await deps.mergeBranch(agentId, worktree);
    } catch (error) {
      if (error instanceof MergeConflictError) {
        queue.markUnresolvable(agentId, {
          oursDiff: error.oursDiff,
          theirsDiff: error.theirsDiff,
        });
        state = {
          ...state,
          stopped: true,
          merging: undefined,
          blocked: {
            agentId,
            oursDiff: error.oursDiff,
            theirsDiff: error.theirsDiff,
          },
          // The failed candidate was already dequeued, so the queue no
          // longer lists it — pending keeps every unmerged agent in the
          // original order instead (resume retries exactly this set).
          pending: state.pending,
        };
        const saveFailure = await saveOrFail(state);
        if (saveFailure !== undefined) {
          await reapSpawned(spawned);
          return saveFailure;
        }
        await reapSpawned(spawned);
        return fail(
          RUN_EXIT_FAILED,
          'merge_conflict',
          `merge conflict for worker '${agentId}': unresolvable automatically — queue stopped, candidates preserved`,
          partial(),
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      // The merge may have succeeded on disk before the throw (kill
      // window) — keep the write-ahead intent so resume reconciles via
      // isBranchMerged instead of double-merging.
      const saveFailure = await saveOrFail(state);
      if (saveFailure !== undefined) {
        await reapSpawned(spawned);
        return saveFailure;
      }
      await reapSpawned(spawned);
      return fail(
        RUN_EXIT_FAILED,
        'merge_failed',
        `merge failed for worker '${agentId}': ${message}`,
        partial(),
      );
    }
    const hunks = hunksByAgent.get(agentId) ?? [];
    state.records.push({ agentId, branch: worktree.branch, hunks });
    state.merged.push(agentId);
    state.pending = state.pending.filter((entry) => entry !== agentId);
    state = { ...state, merging: undefined };
    {
      const saveFailure = await saveOrFail(state);
      if (saveFailure !== undefined) {
        await reapSpawned(spawned);
        return saveFailure;
      }
    }
    debug(`merged: ${agentId} (branch ${worktree.branch})`);
    candidate = queue.dequeue();
  }

  const reapError = await reapSpawned(spawned);
  if (reapError !== undefined) {
    return fail(
      RUN_EXIT_FAILED,
      'reap_failed',
      `reap failed for worker '${reapError.agentId}': ${reapError.message}`,
      partial(),
    );
  }

  const attribution = state.records.flatMap((record) =>
    attributeMergedHunks(record.hunks, record.agentId),
  );
  const perAgent = state.records
    .map((record) => `${record.agentId}=${record.hunks.length} hunk(s)`)
    .join(', ');
  const textLines = [
    `session: ${sessionId}`,
    ...state.records.map(
      (record) =>
        `worker: ${record.agentId} branch=${record.branch} hunks=${record.hunks.length}`,
    ),
    `merge order: ${state.merged.join(' -> ')}`,
    `attribution: ${perAgent}`,
    ...state.merged.map((agentId) => `merged: ${agentId}`),
    ...spawned.map((agentId) => `reaped: ${agentId}`),
    `result: orchestrated ${state.records.length} worker(s), merged ${state.merged.length}`,
  ];
  return emit(
    {
      ok: true,
      exitCode: RUN_EXIT_OK,
      sessionId,
      status: 'completed',
      workers: state.records.map((record) => ({
        agentId: record.agentId,
        branch: record.branch,
        hunks: record.hunks.length,
      })),
      mergeOrder: [...state.merged],
      attribution,
    },
    textLines,
  );
}
