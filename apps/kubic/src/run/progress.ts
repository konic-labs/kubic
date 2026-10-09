// `kubic run` on an interactive terminal: a heading, the one-line no-isolation notice,
// a spinner while the model works, one settled line per tool call, then — after
// the answer the command prints on stdout — the receipt and the next steps.
// Everything here goes to stderr; the run's data (the answer) stays on stdout.
//
// Built only when stdout and stderr are both a coloured TTY and the run is
// not `--json` (prod-runners.ts); every other run keeps the plain lines the
// binary contract and scripts depend on.

import {
  brandHeading,
  formatDuration,
  nextActions,
  receipt,
  statusMark,
} from '@kubic/core/cli/kit';
import {
  createSpinner,
  type SpinnerOptions,
  type SpinnerStream,
} from '@kubic/core/cli/spinner';
import type { CliTheme } from '@kubic/core/cli/theme';
import {
  padVisible,
  truncateVisible,
  visibleWidth,
} from '@kubic/core/cli/width';
import { runRoleLabel } from '@kubic/core/run-role';
import type { HeadlessRunResult, RunProgressSink } from '@kubic/host/run';
import {
  summarizeToolArguments,
  summarizeToolOutcome,
} from '@kubic/tui/lane-cells';

export interface RunProgressStream extends SpinnerStream {
  readonly columns?: number;
}

export interface RunProgressOptions {
  /** The run's working directory, shown in the heading (home as `~`). */
  readonly cwd: string;
  readonly home?: string;
  readonly now?: () => number;
  readonly spinner?: SpinnerOptions;
  /** How often the elapsed time next to the spinner refreshes. */
  readonly tickMs?: number;
}

const TOOL_COLUMN = 7;
const DEFAULT_COLUMNS = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A tool result's `details` (pi-durable EntryRecord: the message is the
// first model message; the coarse lane shape carries `message`).
function resultDetails(entry: unknown): Record<string, unknown> | undefined {
  if (!isRecord(entry)) return undefined;
  const model = entry.model;
  const message =
    Array.isArray(model) && isRecord(model[0])
      ? model[0]
      : isRecord(entry.message)
        ? entry.message
        : undefined;
  return message !== undefined && isRecord(message.details)
    ? message.details
    : undefined;
}

// Pi's display diff: `+12 text`, `-12 text`, ` 12 text`, ` <pad> ...`.
export function countDiffLines(diff: string): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (/^\+\s*\d/.test(line)) added += 1;
    else if (/^-\s*\d/.test(line)) removed += 1;
  }
  return { added, removed };
}

// An edit's line counts: Kubic's display record (tools-adapter.ts) carries
// them; Pi's own `details.diff` is counted.
function editStat(
  details: Record<string, unknown> | undefined,
): { added: number; removed: number } | undefined {
  const display = details?.display;
  if (
    isRecord(display) &&
    display.kind === 'diff' &&
    typeof display.added === 'number' &&
    typeof display.removed === 'number'
  ) {
    return { added: display.added, removed: display.removed };
  }
  return typeof details?.diff === 'string'
    ? countDiffLines(details.diff)
    : undefined;
}

function lineCount(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

function shortPath(path: string, home: string | undefined): string {
  if (
    home !== undefined &&
    home !== '' &&
    (path === home || path.startsWith(`${home}/`))
  ) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

// The lines a settled edit or write changed, for its settled line and the
// receipt. Undefined for any other call, and for a failed one.
function fileStat(
  toolName: string,
  failed: boolean,
  entry: unknown,
  args: unknown,
): { added: number; removed: number } | undefined {
  if (failed) return undefined;
  if (toolName === 'edit') return editStat(resultDetails(entry));
  if (toolName === 'write' && isRecord(args)) {
    const content = typeof args.content === 'string' ? args.content : '';
    return { added: lineCount(content), removed: 0 };
  }
  return undefined;
}

// The settled line of one tool call: its mark and name, the target cut to
// the room the meta leaves, then the meta.
function settledToolLine(
  theme: CliTheme,
  columns: number,
  toolName: string,
  failed: boolean,
  target: string,
  meta: readonly string[],
): string {
  const ui = theme.ui;
  const head = `${statusMark(theme, failed ? 'fail' : 'ok')} ${ui.style({ fg: 'fg0', bold: true })(padVisible(toolName, TOOL_COLUMN))} `;
  const tail = meta.length === 0 ? '' : `  ${meta.join('  ')}`;
  const room = Math.max(
    8,
    columns - visibleWidth(head) - visibleWidth(tail) - 1,
  );
  return `${head}${ui.fg('fg1')(truncateVisible(target, room))}${tail}`;
}

function clock(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function createRunProgress(
  stream: RunProgressStream,
  theme: CliTheme,
  options: RunProgressOptions,
): RunProgressSink {
  const ui = theme.ui;
  const now = options.now ?? Date.now;
  const spinner = createSpinner(stream, theme, options.spinner);
  const started = new Map<string, number>();
  // The call's arguments, kept from the start event: the end event carries
  // only the result, but the settled line names the target and the stats.
  const pendingArgs = new Map<string, unknown>();
  const files = new Map<string, { added: number; removed: number }>();
  let tools = 0;
  let runStart = now();
  let state = 'thinking';
  let ticker: ReturnType<typeof setInterval> | undefined;

  const write = (line: string): void => {
    stream.write(`${line}\n`);
  };
  const spinnerText = (): string =>
    `${ui.fg('fg1')(state)}${ui.fg('fg2')(` · ${clock(now() - runStart)}`)}`;
  const stopTicker = (): void => {
    if (ticker !== undefined) clearInterval(ticker);
    ticker = undefined;
  };

  return {
    begin(info) {
      runStart = now();
      const parts = [runRoleLabel(info.role)];
      if (info.model !== undefined) parts.push(info.model);
      const where = shortPath(options.cwd, options.home);
      const columns = stream.columns ?? DEFAULT_COLUMNS;
      let heading = brandHeading(theme, 'run', [...parts, where]);
      if (visibleWidth(heading) > columns) {
        // Keep the end of a long path: its last two segments say where.
        const tail = where.split('/').filter(Boolean).slice(-2).join('/');
        heading = truncateVisible(
          brandHeading(theme, 'run', [...parts, `…/${tail}`]),
          columns,
        );
      }
      write(heading);
      if (info.notice) {
        write(
          `${ui.fg('fg2')('○ Kubic has no isolation — approvals + journal are the controls · details: ')}${ui.fg('fg1')('kubic doctor')}`,
        );
      }
      write('');
      spinner.start(spinnerText());
      if (stream.isTTY === true) {
        ticker = setInterval(
          () => spinner.update(spinnerText()),
          options.tickMs ?? 500,
        );
        ticker.unref?.();
      }
    },
    toolStart(event) {
      started.set(event.toolCallId, now());
      pendingArgs.set(event.toolCallId, event.args);
      const target = summarizeToolArguments(event.args);
      state = target === '' ? event.toolName : `${event.toolName} ${target}`;
      spinner.update(spinnerText());
    },
    toolEnd(event) {
      tools += 1;
      const begun = started.get(event.toolCallId);
      started.delete(event.toolCallId);
      const outcome = summarizeToolOutcome(event.entry, event.toolName);
      const failed =
        event.isError || (outcome !== undefined && /^exit [1-9]/.test(outcome));
      const args = pendingArgs.get(event.toolCallId);
      pendingArgs.delete(event.toolCallId);
      const stat = fileStat(event.toolName, failed, event.entry, args);
      const path =
        isRecord(args) && typeof args.path === 'string' ? args.path : undefined;
      if (stat !== undefined && path !== undefined) {
        const prior = files.get(path) ?? { added: 0, removed: 0 };
        files.set(path, {
          added: prior.added + stat.added,
          removed: prior.removed + stat.removed,
        });
      }
      const meta: string[] = [];
      if (stat !== undefined) {
        meta.push(
          `${ui.fg('add')(`+${stat.added}`)} ${ui.fg('del')(`−${stat.removed}`)}`,
        );
      } else if (outcome !== undefined) {
        meta.push(failed ? ui.fg('err')(outcome) : ui.fg('fg1')(outcome));
      } else if (failed) {
        meta.push(ui.fg('err')('failed'));
      }
      if (begun !== undefined)
        meta.push(ui.fg('fg2')(formatDuration(now() - begun)));
      spinner.print(
        settledToolLine(
          theme,
          stream.columns ?? DEFAULT_COLUMNS,
          event.toolName,
          failed,
          summarizeToolArguments(args),
          meta,
        ),
      );
      state = 'thinking';
      spinner.update(spinnerText());
    },
    settle() {
      stopTicker();
      spinner.stop();
    },
    receipt(result: HeadlessRunResult, exitCode: number) {
      let added = 0;
      let removed = 0;
      for (const stat of files.values()) {
        added += stat.added;
        removed += stat.removed;
      }
      const ok = exitCode === 0;
      write(
        receipt(theme, {
          ok,
          durationMs: now() - runStart,
          tools: result.usage?.toolCalls ?? tools,
          ...(files.size === 0 ? {} : { files: files.size, added, removed }),
          ...(result.usage === undefined
            ? {}
            : {
                tokensIn: result.usage.input,
                tokensOut: result.usage.output,
                costUsd: result.usage.costUsd,
              }),
          ...(ok ? {} : { outcome: result.terminus }),
        }),
      );
      const actions: [string, string][] = [];
      if (files.size > 0) {
        actions.push(['review', 'kubic diff'], ['revert', 'kubic undo']);
      }
      if (result.sessionId !== '' && result.sessionId !== 'unassigned') {
        actions.push(['continue', `kubic resume ${result.sessionId}`]);
      }
      if (actions.length > 0) write(nextActions(theme, actions));
    },
  };
}
