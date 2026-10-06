// Session-journal pruning for `kubic clean --journal` (issue #367).
//
// The legacy workspace store (`<root>/.kubic/journal`) is one no run
// writes to, so the retention bounds must also reach the live session
// journals under the sessions root: by default those whose recorded
// workspace is this workspace (the #362 association —
// `defaultSessionWorkspaces` plus `workspaceContains`, so a session
// created in a subdirectory still belongs to its repo), plus the legacy
// store. `--session <id>` narrows the pass to that journal;
// `--all-sessions` drops the workspace filter.
import { join } from 'node:path';
import {
  createNodeFileBridge,
  liveLockHolder,
} from '../../../../exec/src/file-bridge.js';
import {
  FileJournalStore,
  journalMutationLockPath,
} from '../../../../exec/src/journal.js';
import {
  defaultSessionWorkspaces,
  workspaceContains,
} from '../../journal-cli.js';
import { SESSION_ID_PATTERN } from '../../run-cli.js';
import { defaultSessionsRoot } from '../../sessions-cli.js';

export interface SessionJournalPrune {
  sessionId: string;
  entries: number;
  bytes: number;
  // Same over-bound semantics as the store pass: bytes the kept journal
  // is still over the bound by, when the newest entry alone cannot fit.
  overBound: number;
  // The pid holding the journal's mutation lock, when this session's
  // prune was skipped because a writer is live.
  lockedBy?: number;
}

export interface JournalPruneResult {
  entries: number;
  bytes: number;
  // Issue #348: bytes the kept journal is still over the retention bound by,
  // when the newest entry alone cannot fit — it is never dropped, so the
  // excess is reported instead of deleted. 0 means the bound holds.
  overBound: number;
  // Issue #337: the pid holding the journal's mutation lock, when the prune
  // was skipped because a writer is live. Pruning under a live run can drop
  // entries it just appended and delete blobs it just wrote, so the pass
  // steps aside and says who it stepped aside for.
  lockedBy?: number;
  // Issue #367: the per-session passes. Totals above aggregate the legacy
  // store and every visited session journal. Absent when no session
  // journal was visited, so session-less invocations keep the exact
  // legacy shape.
  sessions?: SessionJournalPrune[];
}

export interface JournalScope {
  sessionsRoot?: string;
  sessionId?: string;
  allSessions?: boolean;
}

export interface PrunableSessionJournal {
  sessionId: string;
  dir: string;
}

function hasJournalIndex(dir: string): boolean {
  return createNodeFileBridge(dir).exists('index.jsonl');
}

// The session journals this clean may prune: `--session <id>` names one
// explicitly (no workspace association needed — the naming is the opt-in);
// otherwise every recorded session whose workspace is this workspace, or
// every recorded session under `--all-sessions`. Only sessions that
// actually hold a journal index are visited. Never throws: an unreadable
// sessions root is "nothing here".
export async function listPrunableSessionJournals(
  workspace: string,
  scope?: JournalScope,
): Promise<PrunableSessionJournal[]> {
  const sessionsRoot = scope?.sessionsRoot ?? defaultSessionsRoot();
  if (scope?.sessionId !== undefined) {
    if (!SESSION_ID_PATTERN.test(scope.sessionId)) return [];
    const dir = join(sessionsRoot, scope.sessionId, 'journal');
    return hasJournalIndex(dir) ? [{ sessionId: scope.sessionId, dir }] : [];
  }
  let recorded: Map<string, string>;
  try {
    recorded = await defaultSessionWorkspaces(sessionsRoot);
  } catch {
    return [];
  }
  const out: PrunableSessionJournal[] = [];
  for (const [id, recordedWorkspace] of recorded) {
    // SESSION_ID_PATTERN-checked before any path join — contained by
    // construction, the same rule `latestSessionJournal` uses.
    if (!SESSION_ID_PATTERN.test(id)) continue;
    if (
      scope?.allSessions !== true &&
      !workspaceContains(recordedWorkspace, workspace)
    ) {
      continue;
    }
    const dir = join(sessionsRoot, id, 'journal');
    if (hasJournalIndex(dir)) out.push({ sessionId: id, dir });
  }
  return out;
}

export function defaultPruneJournal(
  policy: { maxAgeMs?: number; maxBytes?: number },
  repoRoot: string,
  scope?: JournalScope,
): Promise<JournalPruneResult> {
  return pruneJournalWithSessions(policy, repoRoot, scope);
}

async function pruneJournalWithSessions(
  policy: { maxAgeMs?: number; maxBytes?: number },
  repoRoot: string,
  scope?: JournalScope,
): Promise<JournalPruneResult> {
  const dir = join(repoRoot, '.kubic', 'journal');
  // Issue #337: a live writer holds the journal's mutation lock for the
  // length of one mutation, but `kubic clean --journal` is a destructive
  // pass over the whole store — under a live run it can drop entries the run
  // just appended and delete blobs it just wrote. It steps aside instead.
  const holder = liveLockHolder(
    journalMutationLockPath(join(dir, 'index.jsonl')),
  );
  const legacy: {
    entries: number;
    bytes: number;
    overBound: number;
    lockedBy?: number;
  } =
    holder !== undefined
      ? { entries: 0, bytes: 0, overBound: 0, lockedBy: holder }
      : new FileJournalStore(dir).enforceRetention(policy);
  // No canonicalization here: `workspaceContains` resolves symlinks on
  // both sides, so an unresolved temp-dir workspace still matches.
  const visits = await listPrunableSessionJournals(repoRoot, scope);
  const sessions: SessionJournalPrune[] = [];
  let entries = legacy.entries;
  let bytes = legacy.bytes;
  let overBound = legacy.overBound;
  for (const visit of visits) {
    const sessionHolder = liveLockHolder(
      journalMutationLockPath(join(visit.dir, 'index.jsonl')),
    );
    if (sessionHolder !== undefined) {
      sessions.push({
        sessionId: visit.sessionId,
        entries: 0,
        bytes: 0,
        overBound: 0,
        lockedBy: sessionHolder,
      });
      continue;
    }
    const pruned = new FileJournalStore(visit.dir).enforceRetention(policy);
    sessions.push({ sessionId: visit.sessionId, ...pruned });
    entries += pruned.entries;
    bytes += pruned.bytes;
    overBound += pruned.overBound;
  }
  return {
    entries,
    bytes,
    overBound,
    ...(legacy.lockedBy === undefined ? {} : { lockedBy: legacy.lockedBy }),
    ...(sessions.length === 0 ? {} : { sessions }),
  };
}

export function noopPrune(): JournalPruneResult {
  return { entries: 0, bytes: 0, overBound: 0 };
}
