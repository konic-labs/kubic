// The selected worker's live preview (EPIC N, issue #466; docs/ui 04-D):
// who it is, its last tool calls drawn as the very cards the solo transcript
// draws (a private transcript fed cells built from the worker's facts, so a
// diff is the same diff block), how it ended, and its budget when it has one.

import type {
  WorkerSummary,
  WorkerToolActivity,
} from '../../../core/src/presentation.js';
import { FAIL, OK } from '../../../core/src/ui/glyphs.js';
import type { UiTheme } from '../../../core/src/ui/style.js';
import {
  createTranscriptView,
  type ToolCallState,
  type TranscriptEntry,
  type TranscriptView,
} from '../transcript.js';
import { exactWidth, fitLine, leftRight } from '../ui/line.js';
import { gauge, sectionLabel } from '../ui/marks.js';
import { clock } from './render.js';
import type { DashboardWorker } from './state.js';

const DIFF_ADDED = /^\+\s*\d/;
const DIFF_REMOVED = /^-\s*\d/;
const GAUGE_CELLS = 12;

function diffCounts(text: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of text.split('\n')) {
    if (DIFF_ADDED.test(row)) added += 1;
    else if (DIFF_REMOVED.test(row)) removed += 1;
  }
  return { added, removed };
}

function outputCell(tool: WorkerToolActivity): TranscriptEntry {
  const diff = tool.diff;
  return {
    id: `o:${tool.id}`,
    kind: 'output',
    markdown: tool.outcome ?? '',
    toolCallId: tool.id,
    ...(tool.state === 'error' ? { isError: true } : {}),
    ...(diff === undefined
      ? {}
      : {
          display: {
            kind: 'diff',
            text: diff.text,
            firstChangedLine: diff.firstChangedLine ?? 1,
            ...diffCounts(diff.text),
          },
        }),
  };
}

/** A worker's recent calls as transcript cells: a card per call, oldest first. */
export function previewCells(worker: WorkerSummary): TranscriptEntry[] {
  const cells: TranscriptEntry[] = [];
  for (const tool of worker.recentTools ?? []) {
    cells.push({
      id: `t:${tool.id}`,
      kind: 'tool',
      markdown: `tool ${tool.tool}`,
      ...(tool.target === undefined ? {} : { detail: tool.target }),
      toolCallId: tool.id,
    });
    if (tool.state !== 'running') cells.push(outputCell(tool));
  }
  return cells;
}

/**
 * The cards of one worker at a time. The transcript keeps its cache by cell
 * id, so a frame that only adds a call redraws only that card.
 */
export class WorkerPreview {
  private readonly view: TranscriptView;
  private readonly now: () => number;
  private worker: WorkerSummary | undefined;
  private revision = 0;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.view = createTranscriptView({
      toolState: (toolCallId) => this.stateOf(toolCallId),
    });
  }

  private stateOf(toolCallId: string): ToolCallState | undefined {
    const tool = this.worker?.recentTools?.find(
      (entry) => entry.id === toolCallId,
    );
    if (tool?.state !== 'running') return undefined;
    return { runningMs: Math.max(0, this.now() - tool.at) };
  }

  /** The worker's tool cards at a width, newest at the bottom. */
  cards(worker: WorkerSummary, width: number): string[] {
    this.worker = worker;
    this.revision += 1;
    this.view.applyLaneSnapshot(
      { laneId: `preview:${worker.workerId}` },
      previewCells(worker),
      this.revision,
    );
    return this.view.render(Math.max(1, width));
  }
}

function basename(path: string): string {
  return (
    path
      .split('/')
      .filter((part) => part !== '')
      .at(-1) ?? path
  );
}

/** The pane's meta rows: who the worker is and where it works. */
function metaLines(
  ui: UiTheme,
  worker: WorkerSummary,
  width: number,
): string[] {
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
  return [
    leftRight(title, where, width),
    exactWidth(` ${facts.join(ui.fg('fg2')(' · '))}`, width),
  ];
}

/** How a settled worker ended: its change and its own last word. */
function settleLines(
  ui: UiTheme,
  row: DashboardWorker,
  width: number,
): string[] {
  if (row.group !== 'done') return [];
  const { worker } = row;
  const head = row.failed
    ? ui.fg('err')(` ${FAIL} ${worker.status ?? 'failed'}`)
    : ui.fg('ok')(` ${OK} ${worker.status ?? 'completed'}`);
  const change =
    worker.diffStat === undefined
      ? ''
      : worker.diffStat.files === 0
        ? ui.fg('fg2')(' · no changes')
        : `${ui.fg('fg2')(' · ')}${ui.fg('add')(`+${worker.diffStat.added}`)} ${ui.fg('del')(`−${worker.diffStat.removed}`)}${ui.fg('fg2')(` · ${worker.diffStat.files} file${worker.diffStat.files === 1 ? '' : 's'}`)}`;
  const time =
    row.elapsedMs === undefined
      ? ''
      : ui.fg('fg2')(` · ${clock(row.elapsedMs)}`);
  const lines = [exactWidth(`${head}${change}${time}`, width)];
  const last = row.failed ? worker.failure : worker.summary;
  if (last !== undefined && last !== '') {
    lines.push(
      exactWidth(ui.fg(row.failed ? 'err' : 'fg1')(`   ${last}`), width),
    );
  }
  return lines;
}

/** The worker's own budget, when it has a limit to burn down. */
function budgetLines(
  ui: UiTheme,
  worker: WorkerSummary,
  width: number,
): string[] {
  const budget = worker.budget;
  if (budget?.limitUsd === undefined || budget.limitUsd <= 0) return [];
  const used = budget.costUsd;
  return [
    exactWidth(` ${sectionLabel(ui, 'worker budget')}`, width),
    exactWidth(
      ` ${ui.fg('fg2')('cost ')}${gauge(ui, used / budget.limitUsd, GAUGE_CELLS)} ${ui.fg('fg1')(`$${used.toFixed(2)} / $${budget.limitUsd.toFixed(2)}`)}`,
      width,
    ),
  ];
}

export interface PreviewOptions {
  readonly width: number;
  readonly maxRows: number;
  /** The worker's tool cards at a width (WorkerPreview.cards). */
  readonly cards: (worker: WorkerSummary, width: number) => string[];
}

/**
 * 04-D: the meta rows, then as many of the newest cards as fit, then how it
 * ended and its budget — exactly `maxRows` rows of `width` cells.
 */
export function renderWorkerPreview(
  ui: UiTheme,
  row: DashboardWorker | undefined,
  options: PreviewOptions,
): string[] {
  const width = Math.max(1, Math.floor(options.width));
  const rows = Math.max(1, Math.floor(options.maxRows));
  const pad = (lines: string[]): string[] => [
    ...lines.slice(0, rows),
    ...Array.from({ length: Math.max(0, rows - lines.length) }, () =>
      ' '.repeat(width),
    ),
  ];
  if (row === undefined) {
    return pad([exactWidth(ui.fg('fg2')(' no worker selected'), width)]);
  }
  const { worker } = row;
  const head = [...metaLines(ui, worker, width), ' '.repeat(width)];
  const tail = [
    ...settleLines(ui, row, width),
    ...budgetLines(ui, worker, width),
  ];
  const room = rows - head.length - (tail.length === 0 ? 0 : tail.length + 1);
  let middle: string[];
  if ((worker.recentTools ?? []).length === 0) {
    middle = [
      exactWidth(
        ui.fg('fg2')(
          row.group === 'queued'
            ? ' not started yet'
            : row.group === 'done'
              ? ' no tool calls reported'
              : ' no tool calls yet',
        ),
        width,
      ),
    ];
  } else {
    const cards = options
      .cards(worker, width - 1)
      .map((line) => exactWidth(` ${fitLine(line, width - 1)}`, width));
    middle = room > 0 ? cards.slice(-room) : [];
  }
  return pad([
    ...head,
    ...middle.slice(0, Math.max(0, room)),
    ...(tail.length === 0 ? [] : [' '.repeat(width), ...tail]),
  ]);
}
