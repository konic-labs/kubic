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
import { createNodeFileBridge } from '../../../exec/src/file-bridge.js';
import type { WorkerRow } from './registry.js';
import { WORKER_STATUSES } from './status.js';

// The file `kubic orchestrate` writes and `kubic workers` reads, relative
// to the orchestrator state dir (`<repo>/.kubic/orchestrator/`).
export const WORKER_ROWS_FILE = 'workers.json';

interface RowsPayload {
  version: 1;
  rows: WorkerRow[];
}

function isRow(value: unknown): value is WorkerRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  if (typeof row.workerId !== 'string' || row.workerId.length === 0) {
    return false;
  }
  if (typeof row.sessionId !== 'string') return false;
  if (typeof row.generation !== 'number') return false;
  if (typeof row.owner !== 'string') return false;
  if (typeof row.startedAtMs !== 'number') return false;
  if (
    typeof row.status !== 'string' ||
    !(WORKER_STATUSES as readonly string[]).includes(row.status)
  ) {
    return false;
  }
  return true;
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
  return payload.rows.filter(isRow);
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
    return readWorkerRows(
      createNodeFileBridge(join(repo, '.kubic', 'orchestrator')),
      WORKER_ROWS_FILE,
    );
  } catch {
    return [];
  }
}

export type { TaskResources, WorkerRow };
