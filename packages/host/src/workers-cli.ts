// `kubic workers [--json] [--debug]` (issue #42; §50, §49.3, §13),
// `kubic workers inspect <id>` and `kubic workers terminate <id>`
// (issue #167; §66 worker.inspect/worker.terminate).
// Presentation only: live procs with age/owner/resources (§50), the
// §13 status verbatim, startup span ms (§49.3) per row — one table row
// per worker — and --debug spawn + clean-exit lines in the §50
// vocabulary. Rows arrive injected
// (the registry lives in @kubic/worker lifecycle) — this module never
// touches processes, the filesystem, or the network: terminate signals
// through an injected `signal` (the lifecycle's group reap, wired by the
// composition root), so the owning run observes the exit and settles the
// worker itself.

import type { TaskResources } from '../../agents/src/task.js';
import { createLineLogger } from '../../core/src/cli/logger.js';
import { formatJson } from '../../core/src/cli/output.js';
import { renderTable, type TableColumn } from '../../core/src/cli/table.js';
import { type CliTheme, createCliTheme } from '../../core/src/cli/theme.js';
import { commandOwnsSession } from '../../worker/src/lifecycle/orphans.js';
import {
  AGENT_STATUSES,
  type AgentStatus,
  isTerminalAgentStatus,
} from '../../worker/src/lifecycle/status.js';

export interface WorkerListRow {
  workerId: string;
  sessionId: string;
  generation: number;
  /** §13 PROCESS status (issue #151): spawning | ready | exiting. */
  status: string;
  /** §13 AGENT status (issue #151): starting | running | waiting | settling |
   *  completed | failed | cancelled | timeout | budget_exhausted |
   *  spawn_failed. Optional so an embedder that only knows the process phase
   *  still lists its rows (the column then shows `-`). */
  agentStatus?: string;
  /** The signal the process died from, when it was signalled (issue #151). */
  signal?: string;
  /** §51 cancel outcome (issue #249): `settled` (the worker's own shutdown
   *  finished inside its grace) or `forced` (the SIGKILL escalation beat it). */
  cancel?: string;
  /** The named failure the worker settled on (§82, issue #163): the resource
   *  code a limit breach carries, or the §52 code of a crash. */
  failure?: { code: string; message: string };
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

// §13 statuses by tone (issue #151): the AGENT column carries the outcome
// the operator acts on; the PROCESS column carries the child's own phase, so
// `exiting / settling` reads as "the child is gone, the manager is validating
// its work" — which the old single status could only render as `crashed`.
const GOOD_STATUSES: ReadonlySet<string> = new Set([
  'running',
  'completed',
  'ready',
]);
const BAD_STATUSES: ReadonlySet<string> = new Set([
  'spawn_failed',
  'failed',
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
  { header: 'AGENT' },
  { header: 'PROCESS' },
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
          agentStatus: row.agentStatus,
          ...(row.signal === undefined ? {} : { signal: row.signal }),
          ...(row.cancel === undefined ? {} : { cancel: row.cancel }),
          ...(row.failure === undefined ? {} : { failure: row.failure }),
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
          row.agentStatus === undefined
            ? '-'
            : row.failure === undefined
              ? styleStatus(row.agentStatus, theme)
              : `${styleStatus(row.agentStatus, theme)}(${row.failure.code})`,
          row.signal === undefined
            ? styleStatus(row.status, theme)
            : `${styleStatus(row.status, theme)}(${row.signal})`,
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

// The `kubic workers` invocation the registrar parses (issue #167): the
// bare list keeps its own options; the subcommands carry an id.
export type WorkersInvocation =
  | { command: 'list'; json?: boolean; debug?: boolean }
  | { command: 'inspect'; id: string; json?: boolean }
  | { command: 'terminate'; id: string; generation?: number; json?: boolean };

export interface WorkerInspectOptions {
  readonly json?: boolean;
}

export interface WorkerWorktreeView {
  path: string;
  branch: string;
  clean: boolean;
  changed: number;
}

export interface WorkerRunView {
  /** The worker-specific budget bound, when the run stored one. */
  budget?: { shared?: Record<string, number>; worker?: Record<string, number> };
  /** The settled usage rollup from the run's own record, when settled. */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    toolCalls?: number;
    costUsd?: number;
  };
  /** Where live usage accrues when the worker has not settled. */
  usageHint?: string;
  /** The row's agent state is `waiting`: an approval ask is outstanding. */
  pendingApproval: boolean;
  /** The newest §60 decision for the worker session, when any. */
  lastDecision?: string;
}

export interface WorkerInspectDeps {
  find: (
    id: string,
  ) => WorkerListRow | undefined | Promise<WorkerListRow | undefined>;
  worktree: (
    row: WorkerListRow,
  ) => WorkerWorktreeView | undefined | Promise<WorkerWorktreeView | undefined>;
  run: (
    row: WorkerListRow,
  ) => WorkerRunView | undefined | Promise<WorkerRunView | undefined>;
  now?: () => number;
  out: (line: string) => void;
  err: (line: string) => void;
  theme?: CliTheme;
  errTheme?: CliTheme;
  fancy?: boolean;
}

export interface WorkerTerminateOptions {
  readonly generation?: number;
  readonly json?: boolean;
}

export interface WorkerTerminateDeps {
  find: (
    id: string,
  ) => WorkerListRow | undefined | Promise<WorkerListRow | undefined>;
  /** The pid's command line, or undefined when it cannot be read. */
  command: (pid: number) => string | undefined | Promise<string | undefined>;
  /** The lifecycle's group reap (SIGTERM the process group). */
  signal: (pid: number) => void;
  out: (line: string) => void;
  err: (line: string) => void;
  theme?: CliTheme;
  errTheme?: CliTheme;
}

function workerError(
  deps: Pick<WorkerInspectDeps, 'err' | 'errTheme'>,
  message: string,
): void {
  createLineLogger(deps.err, {
    theme: deps.errTheme ?? createCliTheme('none'),
  }).error(message);
}

function renderSpec(spec: Record<string, number>): string {
  return Object.entries(spec)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
}

function renderUsage(usage: NonNullable<WorkerRunView['usage']>): string {
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`input=${usage.inputTokens}`);
  if (usage.outputTokens !== undefined)
    parts.push(`output=${usage.outputTokens}`);
  if (usage.costUsd !== undefined) parts.push(`costUsd=${usage.costUsd}`);
  if (usage.toolCalls !== undefined) parts.push(`toolCalls=${usage.toolCalls}`);
  return parts.join(' ');
}

// `kubic workers inspect <id>` (issue #167): the full row plus the four
// operator facets — worktree, budget, usage, approvals. Every facet is
// served by an injected provider; an absent one reads as an honest
// `not found` / `none`, never an invented value.
export async function runWorkerInspectCommand(
  id: string,
  options: WorkerInspectOptions,
  deps: WorkerInspectDeps,
): Promise<number> {
  const theme = deps.theme ?? createCliTheme('none');
  const now = deps.now?.() ?? Date.now();
  const row = await deps.find(id);
  if (row === undefined) {
    workerError(deps, `no such worker '${id}' code=no_such_worker`);
    return 1;
  }
  const worktree = await deps.worktree(row);
  const run = await deps.run(row);
  if (options.json === true) {
    deps.out(
      formatJson({
        workerId: row.workerId,
        sessionId: row.sessionId,
        generation: row.generation,
        status: row.status,
        agentStatus: row.agentStatus,
        ...(row.signal === undefined ? {} : { signal: row.signal }),
        ...(row.cancel === undefined ? {} : { cancel: row.cancel }),
        ...(row.failure === undefined ? {} : { failure: row.failure }),
        ageMs: now - row.startedAtMs,
        owner: row.owner,
        resources: row.resources,
        pid: row.pid,
        startupMs: row.startupMs,
        ...(worktree === undefined ? {} : { worktree }),
        ...(run?.budget === undefined ? {} : { budget: run.budget }),
        ...(run?.usage === undefined ? {} : { usage: run.usage }),
        ...(run?.usageHint === undefined ? {} : { usageHint: run.usageHint }),
        approvals: {
          pending: run?.pendingApproval ?? false,
          ...(run?.lastDecision === undefined
            ? {}
            : { lastDecision: run.lastDecision }),
        },
      }),
    );
    return 0;
  }
  deps.out(
    renderTable(
      [
        [
          row.workerId,
          row.agentStatus === undefined
            ? '-'
            : row.failure === undefined
              ? styleStatus(row.agentStatus, theme)
              : `${styleStatus(row.agentStatus, theme)}(${row.failure.code})`,
          row.signal === undefined
            ? styleStatus(row.status, theme)
            : `${styleStatus(row.status, theme)}(${row.signal})`,
          String(row.generation),
          formatAge(now - row.startedAtMs),
          row.owner,
          row.pid === undefined ? '-' : String(row.pid),
          row.startupMs === undefined ? '-' : `${row.startupMs}ms`,
          formatResources(row.resources),
        ],
      ],
      COLUMNS,
      { fancy: deps.fancy === true, theme },
    ),
  );
  deps.out(
    worktree === undefined
      ? 'worktree: not found'
      : `worktree: ${worktree.path} (${worktree.branch}, ${worktree.clean ? 'clean' : `dirty: ${worktree.changed} files`})`,
  );
  const budget =
    run?.budget?.worker !== undefined
      ? `worker ${renderSpec(run.budget.worker)}`
      : run?.budget?.shared !== undefined
        ? `shared ${renderSpec(run.budget.shared)}`
        : undefined;
  deps.out(
    budget === undefined ? 'budget: none recorded' : `budget: ${budget}`,
  );
  const usage = run?.usage === undefined ? undefined : renderUsage(run.usage);
  deps.out(
    usage !== undefined && usage.length > 0
      ? `usage: ${usage}`
      : run?.usageHint !== undefined
        ? `usage: accruing (${run.usageHint})`
        : 'usage: no record yet',
  );
  const pending = run?.pendingApproval === true;
  const last =
    run?.lastDecision === undefined ? '' : `; last: ${run.lastDecision}`;
  deps.out(
    pending
      ? `approvals: 1 ask pending (worker is waiting)${last}`
      : `approvals: none pending${last}`,
  );
  return 0;
}

// `kubic workers terminate <id>` (issue #167): stop a runaway worker
// through the lifecycle layer — the pid-reuse guard, then the group reap —
// never a raw kill. The child observes the SIGTERM and reports `cancelled`
// in its own §68 report, so the owning run settles the worker as cancelled
// (not a crash) when its wait resolves. A `--generation` names the
// generation the operator saw: a worker replaced since is refused, so the
// signal can never land on its successor.
export async function runWorkerTerminateCommand(
  id: string,
  options: WorkerTerminateOptions,
  deps: WorkerTerminateDeps,
): Promise<number> {
  const row = await deps.find(id);
  if (row === undefined) {
    workerError(deps, `no such worker '${id}' code=no_such_worker`);
    return 1;
  }
  // A stale operator view names a generation the worker has moved past:
  // refuse before anything is signalled (exit 2 — the invocation, not the
  // worker, is wrong).
  if (
    options.generation !== undefined &&
    options.generation !== row.generation
  ) {
    workerError(
      deps,
      `worker '${id}' is at generation ${row.generation}, not ${options.generation} code=stale_generation`,
    );
    return 2;
  }
  // Only a live worker is signallable: a settled one has nothing to stop,
  // and a pid that is gone — or belongs to someone else now — is never
  // signalled blind. The row's agent state is a durable string, so only a
  // known-terminal value refuses; an unknown one falls through to the
  // pid-reuse probe, which is the real authority on liveness.
  const agentStatus: AgentStatus | undefined =
    row.agentStatus !== undefined &&
    (AGENT_STATUSES as readonly string[]).includes(row.agentStatus)
      ? (row.agentStatus as AgentStatus)
      : undefined;
  if (
    (agentStatus !== undefined && isTerminalAgentStatus(agentStatus)) ||
    row.pid === undefined
  ) {
    workerError(deps, `worker '${id}' is not running code=worker_not_running`);
    return 1;
  }
  const command = await deps.command(row.pid);
  if (!commandOwnsSession(command, row.sessionId)) {
    workerError(
      deps,
      `worker '${id}' is not running (pid ${row.pid} is gone or reused) code=worker_not_running`,
    );
    return 1;
  }
  deps.signal(row.pid);
  if (options.json === true) {
    deps.out(
      formatJson({
        workerId: id,
        pid: row.pid,
        generation: row.generation,
        terminated: true,
      }),
    );
    return 0;
  }
  deps.out(
    `terminated worker '${id}' (pid ${row.pid}, generation ${row.generation})`,
  );
  return 0;
}
