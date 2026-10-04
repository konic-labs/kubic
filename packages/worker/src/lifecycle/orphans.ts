// Crash recovery for the durable worker rows (§50, §51). A manager that is
// SIGKILLed (or crashes past its signal guard) leaves `workers.json` rows
// that claim a live status. Those rows are reconciled, never trusted:
//   - manager alive            → untouched (it still owns the worker);
//   - worker pid dead          → `crashed` (the manager was lost);
//   - worker pid alive, and its command line names the row's own
//     `--session <id>`         → its process group is killed, `cancelled`;
//   - worker pid alive, command does not match (pid reuse) → never killed,
//     marked `crashed`.
// No child_process here (dep-lint): the probe is injected by the caller.

import type { WorkerRow } from './registry.js';

export interface ProcessProbe {
  alive: (pid: number) => boolean;
  /** The process's command line, or undefined when it cannot be read. */
  command?: (pid: number) => Promise<string | undefined>;
  killGroup: (pid: number) => void;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
}

/** Pid-reuse guard: the process's command line must name the worker's own
 *  `--session <id>` before anything signals it. */
export function commandOwnsSession(
  command: string | undefined,
  sessionId: string,
): boolean {
  return command?.includes(`--session ${sessionId}`) === true;
}

// §13 (issue #151): a row is live while its PROCESS has not exited. The agent
// state is what the listing reports; the process phase is what decides whether
// a pid still belongs to this worker.
function claimsLive(row: WorkerRow): boolean {
  return row.status !== 'exiting';
}

/** The §13 pair a dead row is reconciled to: the process is gone and the
 *  agent failed, or was cancelled by the reconciler's own kill. */
function exited(
  row: WorkerRow,
  agentStatus: 'failed' | 'cancelled',
): WorkerRow {
  return { ...row, status: 'exiting', agentStatus };
}

function managerAlive(
  row: WorkerRow,
  alive: (pid: number) => boolean,
): boolean {
  return row.managerPid !== undefined && alive(row.managerPid);
}

/** A row whose worker process is still running (clean refuses to dispose it). */
export function isLiveWorkerRow(
  row: WorkerRow,
  alive: (pid: number) => boolean = pidAlive,
): boolean {
  return claimsLive(row) && row.pid !== undefined && alive(row.pid);
}

/** Sync read-only view for `kubic workers`: a live-status row whose worker
 *  AND manager are both dead is shown as `crashed`. Nothing is killed. */
export function viewWorkerRows(
  rows: readonly WorkerRow[],
  alive: (pid: number) => boolean = pidAlive,
): WorkerRow[] {
  return rows.map((row) =>
    claimsLive(row) &&
    !managerAlive(row, alive) &&
    (row.pid === undefined || !alive(row.pid))
      ? exited(row, 'failed')
      : row,
  );
}

export async function reconcileWorkerRows(
  rows: readonly WorkerRow[],
  probe: ProcessProbe,
): Promise<{ rows: WorkerRow[]; reaped: string[]; marked: string[] }> {
  const out: WorkerRow[] = [];
  const reaped: string[] = [];
  const marked: string[] = [];
  for (const row of rows) {
    if (!claimsLive(row) || managerAlive(row, probe.alive)) {
      out.push(row);
      continue;
    }
    // A legacy row names no manager: ownership is UNKNOWN, so a live
    // worker is never killed — only a dead one is marked crashed.
    if (row.managerPid === undefined) {
      const dead = row.pid === undefined || !probe.alive(row.pid);
      out.push(dead ? exited(row, 'failed') : row);
      if (dead) marked.push(row.workerId);
      continue;
    }
    if (row.pid !== undefined && probe.alive(row.pid)) {
      const command = await probe.command?.(row.pid);
      if (commandOwnsSession(command, row.sessionId)) {
        probe.killGroup(row.pid);
        out.push(exited(row, 'cancelled'));
        reaped.push(row.workerId);
        continue;
      }
    }
    out.push(exited(row, 'failed'));
    marked.push(row.workerId);
  }
  return { rows: out, reaped, marked };
}
