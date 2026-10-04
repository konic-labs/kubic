// Composition-root half of the §46 trajectory (issue #383): gathers the I/O
// evidence a settled run left behind — the git base, the session journal,
// the audit ledger, the used tool env and this process's worker identity —
// and hands it to the pure assembler (packages/host/src/trajectory/
// run-trajectory.ts), which the fail-closed exporter backs. Called once per
// settled `kubic run` (solo, or an orchestrator worker child) and per TUI
// turn; the file lands at <sessions-root>/<id>/trajectory.json.

import { join } from 'node:path';
import { toolSpawnEnv } from '../../../packages/exec/src/env.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import { gitHeadOf } from '../../../packages/exec/src/git-clean.js';
import { FileJournalStore } from '../../../packages/exec/src/journal.js';
import {
  diffEntries,
  type FileChange,
} from '../../../packages/exec/src/journal-diff.js';
import type { OrgAuditRecord } from '../../../packages/host/src/policy/audit.js';
import {
  auditLedgerDirFor,
  readAuditLedger,
} from '../../../packages/host/src/policy/audit-ledger.js';
import { SESSION_ID_PATTERN } from '../../../packages/host/src/run-cli.js';
import {
  assembleRunTrajectory,
  type RunOutcome,
  TRAJECTORY_FILE,
  writeRunTrajectory,
} from '../../../packages/host/src/trajectory/run-trajectory.js';

// Recorded when the workspace is not a git checkout: the journal, not git,
// is Kubic's change record (§42), so there is no revision to pin — named,
// never an invented sha.
export const NO_VCS_REVISION = 'no-vcs';

// Recorded when the run ended before a model was selected (a refused role,
// an invalid provider override): provenance.model must be non-empty, and
// "none" is the truth.
export const NO_MODEL = { provider: 'none', id: 'none' } as const;

export interface PersistRunTrajectoryInput {
  sessionsRoot: string;
  sessionId: string;
  agentId: string;
  role: string;
  prompt: string;
  entries: readonly unknown[];
  model?: { provider: string; id: string };
  thinking?: string | null;
  cwd: string;
  skills: string[];
  startedAt: number;
  endedAt: number;
  outcome: RunOutcome;
  // Process identity; absent means this process (the prod default).
  processEnv?: NodeJS.ProcessEnv;
  pid?: number;
  // The git base captured when the run STARTED (null outside git). Absent
  // means probe it now — the settle-time HEAD (a TUI turn, a direct call).
  base?: { revision: string; branch: string | null } | null;
  // The run verifier's `signal:*` labels (issue #267).
  evalLabels?: Record<string, string>;
}

function gitBase(
  cwd: string,
  base: PersistRunTrajectoryInput['base'],
): { baseRevision: string; branch: string | null } {
  const head = base === undefined ? gitHeadOf(cwd) : base;
  if (head === null) return { baseRevision: NO_VCS_REVISION, branch: null };
  return { baseRevision: head.revision, branch: head.branch };
}

function journalChanges(sessionsRoot: string, sessionId: string): FileChange[] {
  try {
    return diffEntries(
      new FileJournalStore(join(sessionsRoot, sessionId, 'journal'), {}),
      {},
    );
  } catch {
    // No journal (the run ended before one existed): no recorded changes.
    return [];
  }
}

function ledger(cwd: string): OrgAuditRecord[] {
  try {
    return readAuditLedger(auditLedgerDirFor(cwd));
  } catch {
    return [];
  }
}

// The orchestrator's lifecycle layer hands each worker child its id and
// generation (KUBIC_WORKER_ID / KUBIC_WORKER_GENERATION, §3.8 allowlist);
// a solo run is generation 0 with no worker id.
function workerIdentity(env: NodeJS.ProcessEnv): {
  workerId: string | null;
  generation: number;
} {
  const workerId =
    env.KUBIC_WORKER_ID === undefined || env.KUBIC_WORKER_ID === ''
      ? null
      : env.KUBIC_WORKER_ID;
  const raw = env.KUBIC_WORKER_GENERATION;
  const parsed = raw === undefined || raw === '' ? Number.NaN : Number(raw);
  const generation =
    workerId !== null && Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  return { workerId, generation };
}

// `--session <id>` on export/replay (issue #383): the session's trajectory
// file stands in for `--trajectory <file>`. Both at once is a usage error,
// and the id is validated before any path join can see it.
export function resolveSessionTrajectory<
  T extends { readonly session?: string; readonly trajectory?: string },
>(
  options: T,
  sessionsRoot: string,
):
  | { options: Omit<T, 'session'> & { trajectory?: string } }
  | { error: string } {
  const { session, ...rest } = options;
  if (session === undefined) return { options: rest };
  if (options.trajectory !== undefined) {
    return { error: 'use either --trajectory or --session, not both' };
  }
  if (!SESSION_ID_PATTERN.test(session)) {
    return {
      error: `invalid --session id ${JSON.stringify(session)} (use [A-Za-z0-9_-])`,
    };
  }
  return {
    options: {
      ...rest,
      trajectory: join(sessionsRoot, session, TRAJECTORY_FILE),
    },
  };
}

// Assemble and write; returns the absolute path of trajectory.json. Throws
// (TrajectoryExportError or an I/O error) when the record cannot be built
// or written — the caller reports that without changing the run's result.
export function persistRunTrajectory(input: PersistRunTrajectoryInput): string {
  const processEnv = input.processEnv ?? process.env;
  const { workerId, generation } = workerIdentity(processEnv);
  const exported = assembleRunTrajectory({
    sessionId: input.sessionId,
    agentId: input.agentId,
    workerId,
    role: input.role,
    prompt: input.prompt,
    entries: input.entries,
    model: {
      ...(input.model ?? NO_MODEL),
      thinking: input.thinking ?? null,
    },
    pid: input.pid ?? process.pid,
    generation,
    cwd: input.cwd,
    ...gitBase(input.cwd, input.base),
    env: toolSpawnEnv(processEnv),
    changes: journalChanges(input.sessionsRoot, input.sessionId),
    approvals: ledger(input.cwd),
    skills: input.skills,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    outcome: input.outcome,
    evalLabels: input.evalLabels ?? {},
  });
  return writeRunTrajectory(
    createNodeFileBridge(input.sessionsRoot),
    input.sessionId,
    exported,
  );
}
