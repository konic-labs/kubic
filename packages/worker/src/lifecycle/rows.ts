// Worker lifecycle rows as a durable record (issue #94; §50, §13).
//
// The registry is in-memory and per-process; the invocation that spawns
// workers and the invocation that answers `kubic workers` are different
// processes, so a registry rebuilt from nothing could only ever list zero
// rows — the defect issue #94 names. The orchestration writes its rows to
// a small JSON file under the repo's runtime state (`<repo>/.kubic/…`,
// §35 keeps that out of the commit path) and `kubic workers` reads it
// back. Reading is deliberately forgiving: an absent, torn, or
// hand-edited file reads as no rows, never a crash — a stale list is not
// worth failing a status command over.

import { join } from 'node:path';
import type { TaskResources } from '../../../agents/src/task.js';
import type { FileBridge } from '../../../exec/src/file-bridge.js';
import {
  createNodeFileBridge,
  updateFileLocked,
} from '../../../exec/src/file-bridge.js';
import { viewWorkerRows } from './orphans.js';
import type { WorkerRow } from './registry.js';
import { AGENT_STATUSES, PROCESS_STATUSES } from './status.js';

// §13 rows written before issue #151 carried ONE status field that mixed the
// process phase and the agent state. A row is read through this mapping
// instead of being discarded: the listing keeps showing what the row said.
const LEGACY_STATUS: Record<
  string,
  { status: WorkerRow['status']; agentStatus: WorkerRow['agentStatus'] }
> = {
  created: { status: 'spawning', agentStatus: 'starting' },
  spawning: { status: 'spawning', agentStatus: 'starting' },
  ready: { status: 'ready', agentStatus: 'running' },
  running: { status: 'ready', agentStatus: 'running' },
  completed: { status: 'exiting', agentStatus: 'completed' },
  spawn_failed: { status: 'exiting', agentStatus: 'spawn_failed' },
  crashed: { status: 'exiting', agentStatus: 'failed' },
  timeout: { status: 'exiting', agentStatus: 'timeout' },
  budget_exhausted: { status: 'exiting', agentStatus: 'budget_exhausted' },
  cancelled: { status: 'exiting', agentStatus: 'cancelled' },
};

// The file `kubic orchestrate` writes and `kubic workers` reads, relative
// to the orchestrator state dir (`<repo>/.kubic/orchestrator/`).
export const WORKER_ROWS_FILE = 'workers.json';

interface RowsPayload {
  version: 1;
  rows: WorkerRow[];
}

function isSafePid(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 1;
}

function isRow(value: unknown): value is WorkerRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  if (typeof row.workerId !== 'string' || row.workerId.length === 0) {
    return false;
  }
  if (typeof row.sessionId !== 'string' || row.sessionId.length === 0)
    return false;
  // A pid is signalled on recovery: only a real process id (> 1) is kept,
  // so kill(-0)/kill(-1) (own group / every process) can never happen.
  if (row.pid !== undefined && !isSafePid(row.pid)) return false;
  if (row.managerPid !== undefined && !isSafePid(row.managerPid)) return false;
  if (typeof row.generation !== 'number') return false;
  if (typeof row.owner !== 'string') return false;
  if (typeof row.startedAtMs !== 'number') return false;
  if (typeof row.status !== 'string') return false;
  const process = (PROCESS_STATUSES as readonly string[]).includes(row.status);
  const agent =
    typeof row.agentStatus === 'string' &&
    (AGENT_STATUSES as readonly string[]).includes(row.agentStatus);
  if (process && agent) return true;
  // A pre-#151 row (or a new row whose agent state was dropped) reads through
  // the legacy mapping, so an upgrade never loses the listing.
  return LEGACY_STATUS[row.status] !== undefined;
}

/** Normalize a parsed row: a legacy single-status row gets the §13 pair. */
function normalized(row: WorkerRow): WorkerRow {
  if (
    (PROCESS_STATUSES as readonly string[]).includes(row.status) &&
    typeof row.agentStatus === 'string' &&
    (AGENT_STATUSES as readonly string[]).includes(row.agentStatus)
  ) {
    return row;
  }
  const legacy = LEGACY_STATUS[row.status] ?? {
    status: 'exiting' as const,
    agentStatus: 'failed' as const,
  };
  return { ...row, status: legacy.status, agentStatus: legacy.agentStatus };
}

// Last write per worker wins; the order is registration order.
export function writeWorkerRows(
  bridge: FileBridge,
  path: string,
  rows: readonly WorkerRow[],
): number {
  const payload: RowsPayload = { version: 1, rows: [...rows] };
  bridge.writeFile(path, `${JSON.stringify(payload, null, 2)}\n`);
  return rows.length;
}

export function readWorkerRows(bridge: FileBridge, path: string): WorkerRow[] {
  let raw: string;
  try {
    raw = bridge.readTextFile(path);
  } catch {
    // No file (or unreadable): no rows.
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const payload = parsed as { version?: unknown; rows?: unknown };
  if (payload.version !== 1 || !Array.isArray(payload.rows)) return [];
  return payload.rows.filter(isRow).map(normalized);
}

// Convenience for a caller holding a registry: snapshot it into the file.
export function persistWorkerRows(
  bridge: FileBridge,
  path: string,
  rows: readonly WorkerRow[],
): void {
  writeWorkerRows(bridge, path, rows);
}

// Where a repo's rows live: `<repo>/.kubic/orchestrator/workers.json`, the
// same dir the run state uses (§35 keeps `.kubic/` out of the commit path).
export function workerRowsPath(repo: string): string {
  return join(repo, '.kubic', 'orchestrator', WORKER_ROWS_FILE);
}

// The rows of a repo, read through the exec FileBridge (`kubic workers`
// calls this for a cwd outside a run). Any problem — no repo, no file,
// torn file — reads as no rows, never a crash: a status command that
// fails because of stale runtime state helps nobody.
export function workersListFromRepo(repo: string): WorkerRow[] {
  try {
    // A manager that died hard leaves rows claiming a live status: the
    // listing shows them as `crashed` when both worker and manager are gone.
    return viewWorkerRows(
      readWorkerRows(
        createNodeFileBridge(join(repo, '.kubic', 'orchestrator')),
        WORKER_ROWS_FILE,
      ),
    );
  } catch {
    return [];
  }
}

// Atomic, serialized read-modify-write of workers.json (review fix): the
// update runs under an O_EXCL lock against the rows on disk AT WRITE TIME,
// the write is tmp+rename, and a present-but-unparsable file is refused —
// never read as [] and overwritten.
export function updateWorkerRowsFile(
  absPath: string,
  update: (rows: WorkerRow[]) => WorkerRow[],
): void {
  updateFileLocked(absPath, (current) => {
    let rows: WorkerRow[] = [];
    if (current !== undefined) {
      let parsed: { version?: unknown; rows?: unknown };
      try {
        parsed = JSON.parse(current) as typeof parsed;
      } catch {
        throw new Error(`${absPath} is unparsable — refusing to overwrite it`);
      }
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        parsed.version !== 1 ||
        !Array.isArray(parsed.rows)
      ) {
        throw new Error(`${absPath} is unparsable — refusing to overwrite it`);
      }
      rows = parsed.rows.filter(isRow);
    }
    const payload: RowsPayload = { version: 1, rows: update(rows) };
    return `${JSON.stringify(payload, null, 2)}\n`;
  });
}

export type { TaskResources, WorkerRow };
