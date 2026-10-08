// Composition-root half of the trajectory: gathers the I/O
// evidence a settled run left behind — the git base, the session journal,
// the audit ledger and the used tool env — and hands it to the pure
// assembler (packages/host/src/trajectory/
// run-trajectory.ts), which the fail-closed exporter backs. Called once per
// settled `kubic run` and per TUI turn; the file lands at <sessions-root>/<id>/trajectory.json.

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
import type { TrajectoryEscalation } from '../../../packages/trajectory/src/schema.js';

// Recorded when the workspace is not a git checkout: the journal, not git,
// is Kubic's change record, so there is no revision to pin — named,
// never an invented sha.
const NO_VCS_REVISION = 'no-vcs';

// Recorded when the run ended before a model was selected (a refused role,
// an invalid provider override): provenance.model must be non-empty, and
// "none" is the truth.
const NO_MODEL = { provider: 'none', id: 'none' } as const;

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
  // The run verifier's `signal:*` labels.
  evalLabels?: Record<string, string>;
  // The lane's escalation record: every model climb this
  // run recorded, oldest first. Absent means no climb.
  escalations?: TrajectoryEscalation[];
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

// `--session <id>` on export/replay: the session's trajectory
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
  const exported = assembleRunTrajectory({
    sessionId: input.sessionId,
    agentId: input.agentId,
    role: input.role,
    prompt: input.prompt,
    entries: input.entries,
    model: {
      ...(input.model ?? NO_MODEL),
      thinking: input.thinking ?? null,
    },
    pid: input.pid ?? process.pid,
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
    ...(input.escalations === undefined
      ? {}
      : { escalations: input.escalations }),
  });
  return writeRunTrajectory(
    createNodeFileBridge(input.sessionsRoot),
    input.sessionId,
    exported,
  );
}
