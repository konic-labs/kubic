// The orchestrator dashboard's model (EPIC N, issue #465; docs/ui 04-A,
// 04-B, 04-C, 04-E): what the run is doing, which workers need you and
// what it spent. Pure over the presentation state the projector folds
// (#464), plus the operator's own view state (the filter, the selection),
// so every frame is a function of facts.

import type {
  KubicPresentationState,
  RunPhaseState,
  WorkerSummary,
} from '../../../core/src/presentation.js';

/** Workers grouped by what they need from you, in this order (04-C). */
export type DashboardGroup = 'awaiting' | 'working' | 'done' | 'queued';

export const DASHBOARD_GROUPS: readonly DashboardGroup[] = [
  'awaiting',
  'working',
  'done',
  'queued',
];

export interface DashboardWorker {
  readonly worker: WorkerSummary;
  readonly group: DashboardGroup;
  /** A settled worker that did not complete. */
  readonly failed: boolean;
  /** How long this generation ran (still running: so far). */
  readonly elapsedMs?: number;
}

export interface DashboardCounts {
  readonly awaiting: number;
  readonly working: number;
  readonly done: number;
  readonly failed: number;
  readonly queued: number;
}

/** The run's limits, when it has any (an absent dimension is unlimited). */
export interface DashboardLimits {
  readonly maxTokens?: number;
  readonly maxCostUsd?: number;
  readonly maxRuntimeMs?: number;
}

export interface DashboardModel {
  readonly task?: string;
  readonly branch?: string;
  readonly counts: DashboardCounts;
  /** The run's phases as reported, in run order. */
  readonly phases: readonly RunPhaseState[];
  /** Since the run's plan started (to its last report once it settled). */
  readonly elapsedMs?: number;
  /** The rows shown: grouped, in group order, filtered. */
  readonly workers: readonly DashboardWorker[];
  /** How many workers there are before the filter. */
  readonly total: number;
  readonly filter: string;
  readonly usage: { readonly tokens: number; readonly costUsd: number };
  readonly limits?: DashboardLimits;
}

export interface DashboardInput {
  readonly now: number;
  /** The objective the run is working on. */
  readonly task?: string;
  readonly branch?: string;
  readonly filter?: string;
  readonly limits?: DashboardLimits;
}

const RUNNING = 'running';
const QUEUED = 'queued';
const COMPLETED = 'completed';

function groupOf(worker: WorkerSummary): {
  group: DashboardGroup;
  failed: boolean;
} {
  if (worker.awaiting !== undefined)
    return { group: 'awaiting', failed: false };
  const status = worker.status ?? RUNNING;
  if (status === QUEUED) return { group: 'queued', failed: false };
  if (status === RUNNING) return { group: 'working', failed: false };
  return { group: 'done', failed: status !== COMPLETED };
}

function matches(worker: WorkerSummary, filter: string): boolean {
  if (filter === '') return true;
  const needle = filter.toLowerCase();
  return [worker.workerId, worker.role, worker.task].some(
    (text) => text?.toLowerCase().includes(needle) === true,
  );
}

function runElapsed(
  phases: readonly RunPhaseState[],
  now: number,
): number | undefined {
  if (phases.length === 0) return undefined;
  const start = Math.min(...phases.map((phase) => phase.startedAt ?? phase.at));
  const running = phases.some((phase) => phase.state === 'running');
  const end = running ? now : Math.max(...phases.map((phase) => phase.at));
  return Math.max(0, end - start);
}

export function dashboardModel(
  state: KubicPresentationState,
  input: DashboardInput,
): DashboardModel {
  const filter = input.filter ?? '';
  const all = [...state.workers.values()].map((worker) => {
    const { group, failed } = groupOf(worker);
    const elapsedMs =
      worker.startedAt === undefined
        ? undefined
        : Math.max(0, (worker.endedAt ?? input.now) - worker.startedAt);
    return {
      worker,
      group,
      failed,
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
    };
  });
  const counts = {
    awaiting: all.filter((row) => row.group === 'awaiting').length,
    working: all.filter((row) => row.group === 'working').length,
    done: all.filter((row) => row.group === 'done' && !row.failed).length,
    failed: all.filter((row) => row.failed).length,
    queued: all.filter((row) => row.group === 'queued').length,
  };
  const workers = DASHBOARD_GROUPS.flatMap((group) =>
    all.filter((row) => row.group === group && matches(row.worker, filter)),
  );
  let tokens = 0;
  let costUsd = 0;
  for (const { worker } of all) {
    tokens += (worker.inputTokens ?? 0) + (worker.outputTokens ?? 0);
    costUsd += worker.costUsd ?? 0;
  }
  const phases = state.session.runPhases ?? [];
  const elapsedMs = runElapsed(phases, input.now);
  return {
    ...(input.task === undefined ? {} : { task: input.task }),
    ...(input.branch === undefined ? {} : { branch: input.branch }),
    counts,
    phases,
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
    workers,
    total: all.length,
    filter,
    usage: { tokens, costUsd },
    ...(input.limits === undefined ? {} : { limits: input.limits }),
  };
}

/** What a fresh view selects: the first worker waiting on you, else the first. */
export function defaultSelection(model: DashboardModel): string | undefined {
  return (
    model.workers.find((row) => row.group === 'awaiting') ?? model.workers[0]
  )?.worker.workerId;
}

/** The selection, kept while its worker is shown, else the default. */
export function resolveSelection(
  model: DashboardModel,
  selected: string | undefined,
): string | undefined {
  return model.workers.some((row) => row.worker.workerId === selected)
    ? selected
    : defaultSelection(model);
}

/** Moves the selection by whole workers (group headers are never selected). */
export function moveSelection(
  model: DashboardModel,
  selected: string | undefined,
  delta: number,
): string | undefined {
  const current = resolveSelection(model, selected);
  const at = model.workers.findIndex((row) => row.worker.workerId === current);
  if (at === -1) return current;
  const next = Math.max(0, Math.min(model.workers.length - 1, at + delta));
  return model.workers[next]?.worker.workerId;
}

export function selectedWorker(
  model: DashboardModel,
  selected: string | undefined,
): DashboardWorker | undefined {
  const id = resolveSelection(model, selected);
  return model.workers.find((row) => row.worker.workerId === id);
}
