// `kubic workers [--json] [--debug]` (issue #42; §50, §49.3, §13).
// Presentation only: live procs with age/owner/resources (§50), the
// §13 status verbatim, startup span ms (§49.3) per row — one table row
// per worker — and --debug spawn + clean-exit lines in the §50
// vocabulary. Rows arrive injected
// (the registry lives in @kubic/worker lifecycle) — this module never
// touches processes, the filesystem, or the network.

import type { TaskResources } from '../../agents/src/task.js';
import { createLineLogger } from '../../core/src/cli/logger.js';
import { formatJson } from '../../core/src/cli/output.js';
import { renderTable, type TableColumn } from '../../core/src/cli/table.js';
import { type CliTheme, createCliTheme } from '../../core/src/cli/theme.js';

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

// The parsed `kubic workers` options (commander owns the argv:
// apps/kubic/src/commands/orchestrator.ts).
export interface WorkersCliOptions {
  readonly json?: boolean;
  readonly debug?: boolean;
}

export interface WorkersCommandDeps {
  list: () => WorkerListRow[] | Promise<WorkerListRow[]>;
  now?: () => number;
  // stdout: the table or the `--json` document.
  out: (line: string) => void;
  // stderr: logger diagnostics (`info: …`).
  err: (line: string) => void;
  // stderr: the §50 `--debug` spawn/exit lines.
  debug?: (line: string) => void;
  // Status colours and header accent; colourless when absent.
  theme?: CliTheme;
  // Colour of the stderr diagnostics, from stderr's own TTY state (never
  // stdout's); absent means plain.
  errTheme?: CliTheme;
  // Box-drawn table (an interactive, coloured stdout); plain otherwise.
  fancy?: boolean;
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

// §13 statuses by tone: the run is fine, still settling, or ended badly.
const GOOD_STATUSES: ReadonlySet<string> = new Set(['running', 'completed']);
const BAD_STATUSES: ReadonlySet<string> = new Set([
  'spawn_failed',
  'crashed',
  'timeout',
  'budget_exhausted',
]);

function styleStatus(status: string, theme: CliTheme): string {
  if (GOOD_STATUSES.has(status)) return theme.success(status);
  if (BAD_STATUSES.has(status)) return theme.error(status);
  if (status === 'cancelled') return theme.warning(status);
  return theme.muted(status);
}

const COLUMNS: readonly TableColumn[] = [
  { header: 'WORKER' },
  { header: 'STATUS' },
  { header: 'GEN', align: 'right' },
  { header: 'AGE' },
  { header: 'OWNER' },
  { header: 'PID', align: 'right' },
  { header: 'STARTUP', align: 'right' },
  { header: 'RESOURCES' },
];

export async function runWorkersCommand(
  options: WorkersCliOptions,
  deps: WorkersCommandDeps,
): Promise<number> {
  const theme = deps.theme ?? createCliTheme('none');
  const now = deps.now?.() ?? Date.now();
  const rows = await deps.list();
  if (options.json === true) {
    deps.out(
      formatJson(
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
      ),
    );
  } else if (rows.length === 0) {
    // stdout stays empty (scripts see no rows); the note is a diagnostic.
    createLineLogger(deps.err, {
      theme: deps.errTheme ?? createCliTheme('none'),
    }).info('no orchestrator workers recorded in this repo');
  } else {
    deps.out(
      renderTable(
        rows.map((row) => [
          row.workerId,
          styleStatus(row.status, theme),
          String(row.generation),
          formatAge(now - row.startedAtMs),
          row.owner,
          row.pid === undefined ? '-' : String(row.pid),
          row.startupMs === undefined ? '-' : `${row.startupMs}ms`,
          formatResources(row.resources),
        ]),
        COLUMNS,
        { fancy: deps.fancy === true, theme },
      ),
    );
  }
  if (options.debug === true && deps.debug !== undefined) {
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
