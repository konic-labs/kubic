// The orchestrator dashboard's rows (EPIC N, issue #465; docs/ui 04-A
// header, 04-B run timeline, 04-C workers grouped by what they need from
// you, 04-E run budget). Pure renders of the dashboard model at a width:
// every row is exactly `width` cells, and at depth none they are plain text.
// The two columns are zipped line by line with a faint `│` between them;
// under 100 columns the list is the whole body.

import { RUN_PHASES } from '../../../core/src/presentation.js';
import {
  BRANCH,
  BRAND,
  COLLAPSED,
  FAIL,
  FOCUS_EDGE,
  OK,
  SPINNER_FRAMES,
} from '../../../core/src/ui/glyphs.js';
import type { UiTheme } from '../../../core/src/ui/style.js';
import type { TokenRole } from '../../../core/src/ui/tokens.js';
import { sanitizeLaneText } from '../lane-cells.js';
import { visibleWidth } from '../tui-boundary.js';
import { frameInnerWidth, frameLines } from '../ui/frame.js';
import { exactWidth, fitLine, leftRight } from '../ui/line.js';
import { badge, gauge, rule, sectionLabel } from '../ui/marks.js';
import { fillLine } from '../ui/surface.js';
import type {
  DashboardGroup,
  DashboardModel,
  DashboardWorker,
} from './state.js';

/** Under this width the worker list is the whole body (no side column). */
export const DASHBOARD_NARROW_COLUMNS = 100;
/** From this width the list keeps its fixed width; below, 40% of the row. */
export const DASHBOARD_WIDE_COLUMNS = 120;
export const DASHBOARD_LIST_CELLS = 50;

const AWAITING_MARK = '◆';
const IDLE_SPINNER = SPINNER_FRAMES[0] ?? '⠋';
const GAUGE_CELLS = 12;
const ID_MAX_CELLS = 16;

const GROUP_LABEL: Record<DashboardGroup, string> = {
  awaiting: 'awaiting you',
  working: 'working',
  done: 'done',
  queued: 'queued',
};

/** The worker list's width at a body width (the whole row when narrow). */
export function dashboardListWidth(width: number): number {
  const w = Math.max(0, Math.floor(width));
  if (w < DASHBOARD_NARROW_COLUMNS) return w;
  return w < DASHBOARD_WIDE_COLUMNS
    ? Math.floor(w * 0.4)
    : DASHBOARD_LIST_CELLS;
}

/** `0:42`, `3:10`, `1:02:05`. */
export function clock(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}`
    : `${minutes}:${rest}`;
}

/** `950`, `1.2k`, `18k`, `400k`, `1.2M`. */
export function compactTokens(count: number): string {
  const n = Math.max(0, Math.round(count));
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

function dollars(usd: number): string {
  return `$${Math.max(0, usd).toFixed(2)}`;
}

function basename(path: string): string {
  const parts = path.split('/').filter((part) => part !== '');
  return parts.at(-1) ?? path;
}

/** 04-A: brand, mode badge, the run's objective and branch; live counts. */
export function renderDashboardHeader(
  ui: UiTheme,
  model: DashboardModel,
  width: number,
  spinner: string,
): string {
  const w = Math.max(0, Math.floor(width));
  if (w === 0) return '';
  const sep = ui.fg('fg3')(' │ ');
  const brand = ui.style({ fg: 'accent', bold: true })(` ${BRAND} KUBIC `);
  const mode = badge(ui, 'ORCHESTRATE', 'accent');
  const branch =
    model.branch === undefined || model.branch === ''
      ? ''
      : ui.fg('fg2')(`  ${BRANCH} ${model.branch}`);
  const c = model.counts;
  const failedRole: TokenRole = c.failed > 0 ? 'err' : 'fg2';
  // The spinner turns only while something works.
  const working = c.working > 0 ? spinner : IDLE_SPINNER;
  const full = `${[
    ui.fg('warn')(`${AWAITING_MARK} ${c.awaiting} awaiting`),
    ui.fg('accent')(`${working} ${c.working} working`),
    ui.fg('ok')(`${OK} ${c.done} done`),
    ui.fg(failedRole)(`${FAIL} ${c.failed}`),
  ].join(sep)} `;
  const compact = `${[
    ui.fg('warn')(`${AWAITING_MARK}${c.awaiting}`),
    ui.fg('accent')(`${working}${c.working}`),
    ui.fg('ok')(`${OK}${c.done}`),
    ui.fg(failedRole)(`${FAIL}${c.failed}`),
  ].join(' ')} `;
  const fixed = `${brand}${sep}${mode}`;
  const right =
    visibleWidth(fixed) + visibleWidth(full) + 1 <= w ? full : compact;
  const room =
    w - visibleWidth(fixed) - visibleWidth(branch) - visibleWidth(right) - 1;
  const task =
    model.task === undefined || model.task === '' || room < 6
      ? ''
      : ui.fg('fg0')(fitLine(`  ${model.task}`, room));
  return fillLine(
    ui,
    leftRight(`${fixed}${task}${branch}`, right, w),
    w,
    'bg1',
  );
}

function phaseLabel(
  ui: UiTheme,
  model: DashboardModel,
  phase: (typeof RUN_PHASES)[number],
  spinner: string,
): string {
  const at = model.phases.find((entry) => entry.phase === phase);
  const busy = model.counts.working + model.counts.awaiting;
  const name =
    phase === 'implement' && at?.state === 'running' && busy > 1
      ? `${phase} ×${busy}`
      : phase;
  switch (at?.state) {
    case 'done':
      return ui.fg('ok')(`${OK} ${name}`);
    case 'running':
      return ui.style({ fg: 'accent', bold: true })(`${spinner} ${name}`);
    case 'failed':
      return ui.fg('err')(`${FAIL} ${name}`);
    case 'skipped':
      return `${ui.fg('fg3')(`${COLLAPSED} `)}${ui.style({ fg: 'fg3', strike: true })(name)}`;
    default:
      return ui.fg('fg2')(`${COLLAPSED} ${name}`);
  }
}

/** 04-B: `RUN  ✓ plan ━━━ ⠹ implement ×2 ━━━ ○ review …   elapsed 3:42`. */
export function renderTimeline(
  ui: UiTheme,
  model: DashboardModel,
  width: number,
  spinner: string,
): string {
  const w = Math.max(0, Math.floor(width));
  if (w === 0) return '';
  const label = ui.fg('fg2')(' RUN  ');
  const parts = RUN_PHASES.map((phase) =>
    phaseLabel(ui, model, phase, spinner),
  );
  const right =
    model.elapsedMs === undefined
      ? ''
      : `${ui.fg('fg2')('elapsed ')}${ui.fg('fg1')(clock(model.elapsedMs))} `;
  const fixed =
    visibleWidth(label) +
    parts.reduce((sum, part) => sum + visibleWidth(part), 0) +
    visibleWidth(right) +
    1;
  // Four connectors share what is left: ` ━━━━━ ` at most, a space at least.
  const each = Math.floor((w - fixed) / (parts.length - 1));
  const dashes = Math.max(0, Math.min(5, each - 2));
  const connector =
    dashes === 0 ? ' ' : ui.fg('fg3')(` ${'━'.repeat(dashes)} `);
  return leftRight(`${label}${parts.join(connector)}`, right, w);
}

interface ListLine {
  readonly text: string;
  readonly worker?: string;
}

function workerMark(
  ui: UiTheme,
  row: DashboardWorker,
  spinner: string,
): string {
  switch (row.group) {
    case 'awaiting':
      return ui.fg('warn')(AWAITING_MARK);
    case 'working':
      return ui.fg('accent')(spinner);
    case 'queued':
      return ui.fg('fg2')(COLLAPSED);
    default:
      return row.failed ? ui.fg('err')(FAIL) : ui.fg('ok')(OK);
  }
}

function detailLine(ui: UiTheme, row: DashboardWorker): string | undefined {
  const { worker } = row;
  const tools =
    worker.toolCount === undefined
      ? undefined
      : `${worker.toolCount} tool${worker.toolCount === 1 ? '' : 's'}`;
  const tokens =
    worker.inputTokens === undefined
      ? undefined
      : `${compactTokens(worker.inputTokens + (worker.outputTokens ?? 0))} tok`;
  if (row.group === 'working') {
    const activity =
      worker.activity === undefined
        ? 'starting'
        : `${worker.activity.tool}${worker.activity.target === undefined ? '' : ` ${worker.activity.target}`}`;
    return ui.fg('fg2')(
      [activity, tools, tokens]
        .filter((part) => part !== undefined)
        .join(' · '),
    );
  }
  if (row.group !== 'done') return undefined;
  const parts: string[] = [];
  if (worker.diffStat !== undefined) {
    const { files, added, removed } = worker.diffStat;
    parts.push(
      files === 0
        ? ui.fg('fg2')('no changes')
        : `${ui.fg('add')(`+${added}`)} ${ui.fg('del')(`−${removed}`)}${ui.fg('fg2')(` · ${files} file${files === 1 ? '' : 's'}`)}`,
    );
  }
  for (const part of [tools, tokens]) {
    if (part !== undefined) parts.push(ui.fg('fg2')(part));
  }
  if (row.failed) parts.push(ui.fg('err')(worker.status ?? 'failed'));
  return parts.length === 0 ? undefined : parts.join(ui.fg('fg2')(' · '));
}

function workerLines(
  ui: UiTheme,
  row: DashboardWorker,
  options: {
    readonly selected: boolean;
    readonly width: number;
    readonly idCells: number;
    readonly spinner: string;
  },
): string[] {
  const { worker } = row;
  const { width, selected } = options;
  const edge = selected ? ui.fg('accent')(FOCUS_EDGE) : ' ';
  const id = exactWidth(worker.workerId, options.idCells);
  const name = selected
    ? ui.style({ fg: 'fg0', bold: true })(id)
    : ui.fg('fg0')(id);
  const text =
    row.group === 'awaiting'
      ? ui.fg('warn')(worker.awaiting?.summary ?? '')
      : ui.fg(row.group === 'queued' ? 'fg2' : 'fg1')(worker.task ?? '');
  const time =
    row.elapsedMs === undefined
      ? ''
      : `${ui.fg(row.group === 'working' ? 'fg1' : 'fg2')(clock(row.elapsedMs))} `;
  const background: TokenRole | undefined = selected
    ? 'bg3'
    : row.group === 'awaiting'
      ? 'warnBg'
      : undefined;
  const paint = (line: string): string =>
    background === undefined
      ? exactWidth(line, width)
      : fillLine(ui, exactWidth(line, width), width, background);
  const lines = [
    paint(
      leftRight(
        `${edge}${workerMark(ui, row, options.spinner)} ${name}  ${text}`,
        time,
        width,
      ),
    ),
  ];
  const detail = detailLine(ui, row);
  if (detail !== undefined) lines.push(paint(`      ${detail}`));
  return lines;
}

/**
 * 04-C: the workers under their group labels, the selected one edged and
 * raised. Longer than `maxRows`, the list is a window that keeps the
 * selection in view and says what it hides.
 */
export function renderWorkerList(
  ui: UiTheme,
  model: DashboardModel,
  options: {
    readonly selected?: string;
    readonly width: number;
    readonly maxRows: number;
    readonly spinner: string;
  },
): string[] {
  const width = Math.max(0, Math.floor(options.width));
  if (model.workers.length === 0) {
    const empty =
      model.total > 0
        ? ` no worker matches “${model.filter}”`
        : model.phases.length === 0
          ? ' no run yet — tab, then give the manager an objective'
          : ' no workers yet — the run is planning';
    return [exactWidth(ui.fg('fg2')(empty), width)];
  }
  const idCells = Math.min(
    ID_MAX_CELLS,
    Math.max(...model.workers.map((row) => visibleWidth(row.worker.workerId))),
  );
  const lines: ListLine[] = [];
  let group: DashboardGroup | undefined;
  for (const row of model.workers) {
    if (row.group !== group) {
      if (group !== undefined) lines.push({ text: ' '.repeat(width) });
      group = row.group;
      lines.push({
        text: exactWidth(` ${sectionLabel(ui, GROUP_LABEL[row.group])}`, width),
      });
    }
    for (const text of workerLines(ui, row, {
      selected: row.worker.workerId === options.selected,
      width,
      idCells,
      spinner: options.spinner,
    })) {
      lines.push({ text, worker: row.worker.workerId });
    }
  }
  const max = Math.max(3, Math.floor(options.maxRows));
  const total = lines.length;
  if (total <= max) return lines.map((line) => line.text);
  // A window around the selection, with a row each way for what it hides.
  const more = (count: number, arrow: string): string =>
    exactWidth(ui.fg('fg3')(`  ${arrow} ${count} more`), width);
  const text = (from: number, to: number): string[] =>
    lines.slice(from, to).map((line) => line.text);
  let first = lines.findIndex((line) => line.worker === options.selected);
  if (first === -1) first = 0;
  let last = first;
  while (lines[last + 1]?.worker === options.selected) last += 1;
  if (last < max - 1) {
    return [...text(0, max - 1), more(total - (max - 1), '↓')];
  }
  if (first >= total - (max - 1)) {
    return [more(total - (max - 1), '↑'), ...text(total - (max - 1), total)];
  }
  const size = max - 2;
  let top = first;
  if (last >= top + size) top = last - size + 1;
  top = Math.max(1, Math.min(top, total - size - 1));
  return [
    more(top, '↑'),
    ...text(top, top + size),
    more(total - top - size, '↓'),
  ];
}

/** The side column until the live preview: who the selected worker is. */
export function renderWorkerMeta(
  ui: UiTheme,
  row: DashboardWorker | undefined,
  width: number,
): string[] {
  const w = Math.max(0, Math.floor(width));
  if (row === undefined)
    return [exactWidth(ui.fg('fg2')(' no worker selected'), w)];
  const { worker } = row;
  const title = `${ui.style({ fg: 'fg0', bold: true })(` ${worker.workerId}`)}${
    worker.task === undefined
      ? ''
      : `${ui.fg('fg2')(' · ')}${ui.fg('fg1')(worker.task)}`
  }`;
  const where =
    worker.workspace === undefined
      ? ''
      : `${ui.fg('fg2')('worktree ')}${ui.fg('fg1')(basename(worker.workspace))} `;
  const facts: string[] = [];
  const fact = (label: string, value: string | undefined): void => {
    if (value !== undefined && value !== '') {
      facts.push(`${ui.fg('fg2')(label)} ${ui.fg('fg1')(value)}`);
    }
  };
  fact('role', worker.role);
  fact('model', worker.model);
  fact(
    'generation',
    worker.generation === undefined ? undefined : String(worker.generation),
  );
  fact('status', worker.status);
  return [
    leftRight(title, where, w),
    exactWidth(` ${facts.join(ui.fg('fg2')(' · '))}`, w),
  ];
}

/** 04-B and 04-C: the timeline, a rule, then the list and the side column. */
export function renderDashboardBody(
  ui: UiTheme,
  model: DashboardModel,
  options: {
    readonly selected?: string;
    readonly width: number;
    readonly maxRows: number;
    readonly spinner: string;
    /**
     * Issue #466: the side column for the selected worker (the live
     * preview). Absent draws its facts only.
     */
    readonly side?: (
      row: DashboardWorker | undefined,
      width: number,
      rows: number,
    ) => string[];
  },
): string[] {
  const width = Math.max(0, Math.floor(options.width));
  const listWidth = dashboardListWidth(width);
  const rows = Math.max(1, Math.floor(options.maxRows) - 2);
  const list = renderWorkerList(ui, model, {
    ...(options.selected === undefined ? {} : { selected: options.selected }),
    width: listWidth,
    maxRows: rows,
    spinner: options.spinner,
  });
  const head = [
    renderTimeline(ui, model, width, options.spinner),
    rule(ui, width),
  ];
  if (listWidth === width) return [...head, ...list];
  const sideWidth = width - listWidth - 1;
  const selectedRow = model.workers.find(
    (row) => row.worker.workerId === options.selected,
  );
  const side =
    options.side === undefined
      ? renderWorkerMeta(ui, selectedRow, sideWidth)
      : options.side(selectedRow, sideWidth, rows);
  const height = Math.max(list.length, side.length);
  const divider = ui.fg('fg3')('│');
  return [
    ...head,
    ...Array.from(
      { length: height },
      (_, index) =>
        `${exactWidth(list[index] ?? '', listWidth)}${divider}${exactWidth(side[index] ?? '', sideWidth)}`,
    ),
  ];
}

function dimension(
  ui: UiTheme,
  label: string,
  used: number,
  limit: number | undefined,
  text: (used: number, limit: number) => string,
  plain: string,
): string {
  if (limit === undefined || limit <= 0) {
    return `${ui.fg('fg2')(`${label} `)}${ui.fg('fg1')(plain)}`;
  }
  return `${ui.fg('fg2')(`${label} `)}${gauge(ui, used / limit, GAUGE_CELLS)} ${ui.fg('fg1')(text(used, limit))}`;
}

/** 04-E: a rule, then the run's spend against its limits as gauges. */
export function renderDashboardFooter(
  ui: UiTheme,
  model: DashboardModel,
  width: number,
): string[] {
  const w = Math.max(0, Math.floor(width));
  const limits = model.limits ?? {};
  const elapsed = model.elapsedMs ?? 0;
  const dims = [
    dimension(
      ui,
      'tokens',
      model.usage.tokens,
      limits.maxTokens,
      (used, limit) =>
        `${Math.round((used / limit) * 100)}% of ${compactTokens(limit)}`,
      compactTokens(model.usage.tokens),
    ),
    dimension(
      ui,
      'cost',
      model.usage.costUsd,
      limits.maxCostUsd,
      (used, limit) => `${dollars(used)} / ${dollars(limit)}`,
      dollars(model.usage.costUsd),
    ),
    dimension(
      ui,
      'wall',
      elapsed,
      limits.maxRuntimeMs,
      (used, limit) => `${clock(used)} / ${clock(limit)}`,
      clock(elapsed),
    ),
  ];
  const limited =
    limits.maxTokens !== undefined ||
    limits.maxCostUsd !== undefined ||
    limits.maxRuntimeMs !== undefined;
  const head = ` ${sectionLabel(ui, 'run budget')}  ${limited ? '' : `${ui.fg('fg2')('no limits')}${ui.fg('fg2')('  ·  ')}`}`;
  return [
    rule(ui, w),
    exactWidth(
      `${head}${dims.join(ui.fg('fg2')(limited ? '     ' : '  ·  '))}`,
      w,
    ),
  ];
}

/**
 * `⏎` on a worker (until the live preview): everything the view knows about
 * it, one fact a row, in plain text for the read-only inspector list.
 */
export function workerInspectorLines(row: DashboardWorker): string[] {
  const { worker } = row;
  const lines: string[] = [];
  const add = (label: string, value: string | undefined): void => {
    if (value !== undefined && value !== '') lines.push(`${label}: ${value}`);
  };
  add('task', worker.task);
  add(
    'status',
    `${row.group === 'awaiting' ? 'waiting on you' : (worker.status ?? 'running')}${
      worker.generation === undefined
        ? ''
        : ` (generation ${worker.generation})`
    }`,
  );
  add('waiting on', worker.awaiting?.summary);
  add('role', worker.role);
  add('model', worker.model);
  add('worktree', worker.workspace);
  add(
    'elapsed',
    row.elapsedMs === undefined ? undefined : clock(row.elapsedMs),
  );
  add(
    'latest tool',
    worker.activity === undefined
      ? undefined
      : `${worker.activity.tool}${worker.activity.target === undefined ? '' : ` ${worker.activity.target}`} (${worker.activity.state}${
          worker.activity.outcome === undefined
            ? ''
            : `, ${worker.activity.outcome}`
        })`,
  );
  add(
    'tools',
    worker.toolCount === undefined ? undefined : String(worker.toolCount),
  );
  add(
    'changes',
    worker.diffStat === undefined
      ? undefined
      : worker.diffStat.files === 0
        ? 'none'
        : `${worker.diffStat.files} file${worker.diffStat.files === 1 ? '' : 's'} +${worker.diffStat.added} −${worker.diffStat.removed}`,
  );
  add(
    'tokens',
    worker.inputTokens === undefined
      ? undefined
      : `${worker.inputTokens} in / ${worker.outputTokens ?? 0} out`,
  );
  add(
    'cost',
    worker.costUsd === undefined ? undefined : dollars(worker.costUsd),
  );
  return lines;
}

/**
 * `^O` on a worker: its unified diff for the viewer — additions and
 * removals in their colours, hunk heads in the accent, file heads raised.
 * The text is the worker's file content (untrusted): every row is
 * sanitized and cut to the width.
 */
export function renderWorkerDiff(
  ui: UiTheme,
  text: string,
  width: number,
): string[] {
  const w = Math.max(1, Math.floor(width));
  const rows = text.replace(/\n$/, '').split('\n');
  let body = false;
  return rows.map((raw) => {
    const row = fitLine(sanitizeLaneText(raw), w);
    if (raw.startsWith('diff --git ')) {
      body = false;
      return ui.style({ fg: 'fg0', bold: true })(row);
    }
    if (raw.startsWith('@@')) {
      body = true;
      return ui.fg('accent')(row);
    }
    if (body && raw.startsWith('+')) return ui.fg('add')(row);
    if (body && raw.startsWith('-')) return ui.fg('del')(row);
    return ui.fg(body ? 'fg1' : 'fg2')(row);
  });
}

/** Issue #466 (04-F): the dispatch box — message the selected worker, or
 * (`^N`) give a new worker of the chosen role its task. */
export function renderDispatchBox(
  ui: UiTheme,
  state: {
    readonly mode: 'message' | 'new';
    readonly text: string;
    readonly focused: boolean;
    readonly role: string;
    readonly target?: string;
  },
  width: number,
): string[] {
  const w = Math.max(6, Math.floor(width));
  const inner = frameInnerWidth(w - 2);
  const title = state.mode === 'new' ? `new ${state.role} worker` : 'dispatch';
  const prompt = ui.style({ fg: 'accent', bold: true })('› ');
  const placeholder =
    state.mode === 'new'
      ? `the task for a new ${state.role} worker · tab role · ^N message`
      : `message ${state.target ?? 'the selected worker'}, or ^N to dispatch a new worker`;
  const body =
    state.text === ''
      ? `${prompt}${state.focused ? ui.fg('accent')('▏') : ''}${ui.style({ fg: 'fg2', italic: true })(placeholder)}`
      : `${prompt}${ui.fg('fg0')(state.text)}${state.focused ? ui.fg('accent')('▏') : ''}`;
  // The newest text stays in view: a long draft scrolls left.
  const shown =
    visibleWidth(body) <= inner
      ? body
      : `${prompt}…${ui.fg('fg0')(state.text.slice(-(inner - 4)))}${state.focused ? ui.fg('accent')('▏') : ''}`;
  return frameLines(ui, [shown], w - 2, {
    title,
    color: state.focused ? 'accent' : 'fg3',
  }).map((line) => ` ${line} `);
}

/**
 * Issue #466: the full worker view (`⏎`): its facts, then every recent
 * call as a card, then where the rest lives.
 */
export function workerViewLines(
  row: DashboardWorker,
  cards: (width: number) => string[],
  width: number,
): string[] {
  const w = Math.max(1, Math.floor(width));
  const tools = (row.worker.recentTools ?? []).length;
  return [
    ...workerInspectorLines(row).map((line) => fitLine(line, w)),
    '',
    tools === 0
      ? 'no tool calls yet'
      : `last ${tools} tool call${tools === 1 ? '' : 's'}:`,
    ...(tools === 0 ? [] : cards(w)),
    '',
    fitLine(`more: kubic workers inspect ${row.worker.workerId}`, w),
  ];
}
