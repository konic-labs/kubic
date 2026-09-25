// `kubic workers [--json] [--debug]` (issue #42; §50, §49.3, §13).
// Presentation only: live procs with age/owner/resources (§50), the
// §13 status verbatim, startup span ms (§49.3) per row, and --debug
// spawn + clean-exit lines in the §50 vocabulary. Rows arrive injected
// (the registry lives in @kubic/worker lifecycle) — this module never
// touches processes, the filesystem, or the network.

import type { TaskResources } from '../../agents/src/task.js';
import { answerHelp } from '../../core/src/cli-help.js';

export interface WorkerListRow {
  workerId: string;
  sessionId: string;
  generation: number;
  status: string;
  startedAtMs: number;
  owner: string;
  resources?: TaskResources;
  pid?: number;
  startupMs?: number;
}

export interface WorkersCommandDeps {
  list: () => WorkerListRow[] | Promise<WorkerListRow[]>;
  now?: () => number;
  out: (line: string) => void;
  debug?: (line: string) => void;
}

function formatAge(ageMs: number): string {
  if (ageMs < 1000) return `${Math.max(0, Math.floor(ageMs))}ms`;
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function formatResources(resources: TaskResources | undefined): string {
  if (resources === undefined) return '-';
  const parts: string[] = [];
  if (resources.skills !== undefined && resources.skills.length > 0) {
    parts.push(`skills=${resources.skills.join(',')}`);
  }
  if (
    resources.promptTemplates !== undefined &&
    resources.promptTemplates.length > 0
  ) {
    parts.push(`templates=${resources.promptTemplates.join(',')}`);
  }
  return parts.length > 0 ? parts.join(' ') : '-';
}

const WORKERS_USAGE = 'usage: kubic workers [--json] [--debug]';

function usage(out: (line: string) => void): number {
  out(WORKERS_USAGE);
  return 1;
}

export async function runWorkersCommand(
  args: string[],
  deps: WorkersCommandDeps,
): Promise<number> {
  // `--help`/`-h` prints the usage line and exits 0 (issue #100).
  const help = answerHelp(args, deps.out, WORKERS_USAGE);
  if (help !== null) return help;
  const unknown = args.filter((a) => a !== '--json' && a !== '--debug');
  if (unknown.length > 0) return usage(deps.out);
  const now = deps.now?.() ?? Date.now();
  const rows = await deps.list();
  if (args.includes('--json')) {
    deps.out(
      JSON.stringify(
        rows.map((row) => ({
          workerId: row.workerId,
          sessionId: row.sessionId,
          generation: row.generation,
          status: row.status,
          ageMs: now - row.startedAtMs,
          owner: row.owner,
          resources: row.resources,
          pid: row.pid,
          startupMs: row.startupMs,
        })),
        null,
        2,
      ),
    );
  } else {
    for (const row of rows) {
      deps.out(
        `${row.workerId}  ${row.status}  gen=${row.generation}  age=${formatAge(now - row.startedAtMs)}  owner=${row.owner}  pid=${row.pid ?? '-'}  startup=${row.startupMs === undefined ? '-' : `${row.startupMs}ms`}  resources=${formatResources(row.resources)}`,
      );
    }
  }
  if (args.includes('--debug') && deps.debug !== undefined) {
    for (const row of rows) {
      const startup = row.startupMs === undefined ? '-' : `${row.startupMs}ms`;
      deps.debug(
        `[worker] spawn id=${row.workerId} session=${row.sessionId} gen=${row.generation} pid=${row.pid ?? '-'} startup=${startup}`,
      );
    }
    deps.debug('[exit] code=0 exited cleanly');
  }
  return 0;
}
