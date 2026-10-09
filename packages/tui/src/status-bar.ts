// The one-row status line: model and thinking level, the context gauge, the
// session's cost and journal count, and the turn's state word on the right.
// Usage rows are summed with the cache split kept. The approvals posture is
// part of this bar's state, but the header (chrome.ts) renders it.
//
// The usage fields mirror the agent's `KubicUsageRow`
// (packages/agent/src/usage.ts) without importing it: dep-lint forbids
// tui → agent. The line is pure strings; the Component seam stays in
// ./tui-boundary.js.
//
// There are no time-to-first-token or tool-time segments: Pi 1.0 exposes no
// timing Kubic could read (message deltas stay inside the harness, and the
// lane commits whole entries).
import { formatCost } from '@kubic/core/cli/kit';
import { TOOL } from '@kubic/core/ui/glyphs';
import type { UiTheme } from '@kubic/core/ui/style';
import type { TokenRole } from '@kubic/core/ui/tokens';
import { spinnerFrame, tuiTheme } from './theme.js';
import type { Component } from './tui-boundary.js';
import { visibleWidth } from './tui-boundary.js';
import { fitLine, leftRight } from './ui/line.js';
import { gauge } from './ui/marks.js';
import { fillLine } from './ui/surface.js';

interface StatusUsageCost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly total: number;
}

interface StatusUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  readonly cost: StatusUsageCost;
}

export interface StatusUsageRow {
  readonly model: string;
  readonly provider: string;
  readonly usage: StatusUsage;
  readonly toolCallId?: string;
  readonly entryId?: string;
}

export interface StatusSummary {
  readonly requests: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly costTotal: number;
  // The prompt size of the last COMMITTED request — its input
  // plus BOTH cache counters. pi-ai normalises `input` to exclude the cached
  // prefix it reused (cacheRead) and the prefix it wrote (cacheWrite), so
  // input + cacheRead + cacheWrite is the context the model actually
  // processed, the same quantity the harness's own compaction baseline
  // counts. Undefined until a row names its committed entry: the seeded
  // `pi.usage` buckets are cumulative, so reading them here would show
  // total spend as context pressure.
  readonly contextTokens?: number;
}

export function summarizeStatusRows(
  rows: ReadonlyArray<StatusUsageRow>,
): StatusSummary {
  let requests = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let costTotal = 0;
  let contextTokens: number | undefined;
  for (const row of rows) {
    requests += 1;
    input += row.usage.input;
    output += row.usage.output;
    cacheRead += row.usage.cacheRead;
    cacheWrite += row.usage.cacheWrite;
    costTotal += row.usage.cost.total;
    if (row.entryId !== undefined) {
      contextTokens =
        row.usage.input + row.usage.cacheRead + row.usage.cacheWrite;
    }
  }
  return {
    requests,
    input,
    output,
    cacheRead,
    cacheWrite,
    costTotal,
    contextTokens,
  };
}

export function formatStatusCost(total: number): string {
  // Sub-cent floor: a spending session must never read as free — any
  // positive total below the cent grid renders as `<$0.01` instead of
  // the `$0.00` that toFixed(2) would print. Exact zero stays `$0.00`.
  if (total > 0 && total < 0.005) return '<$0.01';
  return `$${total.toFixed(2)}`;
}

// The word at the right end of the status line.
export type StatusTurnState =
  | 'ready'
  | 'working'
  | 'approval'
  | 'cancelling'
  | 'error';

export interface StatusBarState {
  readonly model: string;
  readonly thinking: string;
  readonly rows: ReadonlyArray<StatusUsageRow>;
  // The session facts the header shows; the bar stays their one holder so the
  // posture has a single source the app and the loop read.
  readonly approvalsSkipped: boolean;
  readonly sessionId: string;
  // The model's context window and the token level at
  // which the lane compacts (window − reserve, the policy; will
  // make the reserve configurable). Both absent means the gauge stays off —
  // an unknown window must never render a made-up percentage.
  readonly contextWindow?: number;
  readonly compactionThreshold?: number;
  // The turn state word, when the running turn started (the
  // spinner's clock), and the session journal's change count.
  readonly turn?: StatusTurnState;
  readonly busySince?: number;
  readonly journalChanges?: number;
  // An `allow all edits this turn` answer applies right now.
  readonly turnEdits?: boolean;
}

const SEPARATOR = '  │  ';
const GAUGE_CELLS = 10;

const TURN_WORD: Record<StatusTurnState, string> = {
  ready: 'ready',
  working: 'working',
  approval: 'needs approval',
  cancelling: 'cancelling…',
  error: 'error',
};

const TURN_ROLE: Record<StatusTurnState, TokenRole> = {
  ready: 'ok',
  working: 'accent',
  approval: 'warn',
  cancelling: 'fg2',
  error: 'err',
};

// `200k`, `1M`: the window as people say it.
/** @internal */
export function compactCount(count: number): string {
  if (count >= 1_000_000) {
    const millions = Math.round(count / 100_000) / 10;
    return `${millions}M`;
  }
  if (count >= 1000) return `${Math.round(count / 1000)}k`;
  return String(Math.max(0, Math.round(count)));
}

interface StatusSegments {
  readonly model: string;
  readonly thinking: string;
  readonly ctxGauge: string;
  readonly ctxPercent: string;
  readonly ctxWindow: string;
  readonly cost: string;
  readonly journal: string;
}

// The context gauge. Unknown (no window, or no committed
// request yet) means no segment at all — a wrong percentage is worse than a
// missing one. At or above the compaction threshold the gauge and the
// percentage take the warning colour: the next turn is about to compact.
function contextParts(
  ui: UiTheme,
  state: StatusBarState,
  summary: StatusSummary,
): Pick<StatusSegments, 'ctxGauge' | 'ctxPercent' | 'ctxWindow'> {
  const window = state.contextWindow;
  const used = summary.contextTokens;
  if (window === undefined || !(window > 0) || used === undefined) {
    return { ctxGauge: '', ctxPercent: '', ctxWindow: '' };
  }
  const fraction = used / window;
  const percent = Math.min(100, Math.max(0, Math.round(fraction * 100)));
  const threshold = state.compactionThreshold;
  const warnAt = threshold === undefined ? 0.8 : threshold / window;
  const warned = fraction >= warnAt;
  return {
    ctxGauge: gauge(ui, fraction, GAUGE_CELLS, { warnAt, failAt: 1 }),
    ctxPercent: ui.fg(warned ? 'warn' : 'fg1')(`${percent}%`),
    ctxWindow: ui.fg('fg2')(` of ${compactCount(window)}`),
  };
}

// What drops first as the line narrows, one rung at a time: the window
// size, the journal count, the gauge cells, the thinking level, the context
// segment; then the model name is cut. The cost and the state
// word never drop.
const RUNGS: ReadonlyArray<ReadonlyArray<keyof StatusSegments>> = [
  [],
  ['ctxWindow'],
  ['ctxWindow', 'journal'],
  ['ctxWindow', 'journal', 'ctxGauge'],
  ['ctxWindow', 'journal', 'ctxGauge', 'thinking'],
  ['ctxWindow', 'journal', 'ctxGauge', 'thinking', 'ctxPercent'],
];

function assemble(
  ui: UiTheme,
  segments: StatusSegments,
  drop: ReadonlyArray<keyof StatusSegments>,
): string {
  const has = (key: keyof StatusSegments): boolean =>
    segments[key] !== '' && !drop.includes(key);
  const sep = ui.fg('fg3')(SEPARATOR);
  const parts: string[] = [
    `${segments.model}${has('thinking') ? segments.thinking : ''}`,
  ];
  if (has('ctxPercent')) {
    const bar = has('ctxGauge') ? `${segments.ctxGauge} ` : '';
    const size = has('ctxWindow') ? segments.ctxWindow : '';
    parts.push(`${ui.fg('fg2')('ctx ')}${bar}${segments.ctxPercent}${size}`);
  }
  parts.push(segments.cost);
  if (has('journal')) parts.push(segments.journal);
  return parts.join(sep);
}

/**
 * The one-row status line:
 * `● model · thinking │ ctx ━━━ 31% of 200k │ $0.031 │ journal 2 changes`
 * and the turn state word on the right, painted on bg1. A
 * running turn turns the mark into the spinner.
 */
/** @internal */
export function renderStatusLine(
  state: StatusBarState,
  width: number,
  ui: UiTheme = tuiTheme().ui,
  now: number = Date.now(),
): string {
  const w = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (w === 0) return '';
  const summary = summarizeStatusRows(state.rows);
  const turn = state.turn ?? 'ready';
  const role = TURN_ROLE[turn];
  const mark =
    turn === 'working'
      ? spinnerFrame(Math.max(0, now - (state.busySince ?? now)))
      : TOOL;
  const lead = ui.fg(role)(` ${mark} `);
  // A turn's edits approved at once say so beside the state.
  const word = `${
    state.turnEdits === true
      ? `${ui.fg('warn')('edits auto-approved this turn')}${ui.fg('fg3')(SEPARATOR)}`
      : ''
  }${ui.fg(role)(TURN_WORD[turn])} `;
  const changes = state.journalChanges ?? 0;
  const segments: StatusSegments = {
    model: ui.fg('fg1')(state.model),
    thinking: state.thinking === '' ? '' : ui.fg('fg2')(` · ${state.thinking}`),
    ...contextParts(ui, state, summary),
    cost: ui.fg('fg1')(formatCost(summary.costTotal)),
    journal:
      changes > 0
        ? `${ui.fg('fg2')('journal ')}${ui.fg('fg1')(`${changes} change${changes === 1 ? '' : 's'}`)}`
        : '',
  };
  const fill = (text: string): string => fillLine(ui, text, w, 'bg1');
  for (const drop of RUNGS) {
    const left = `${lead}${assemble(ui, segments, drop)}`;
    if (visibleWidth(left) + 1 + visibleWidth(word) <= w) {
      return fill(leftRight(left, word, w));
    }
  }
  // The model is cut to the room the cost and the state word leave.
  const tail = `${ui.fg('fg3')(SEPARATOR)}${segments.cost}`;
  const room =
    w - visibleWidth(lead) - visibleWidth(tail) - 1 - visibleWidth(word);
  if (room >= 2) {
    return fill(
      leftRight(`${lead}${fitLine(segments.model, room)}${tail}`, word, w),
    );
  }
  return fill(leftRight(`${lead}${segments.cost}`, word, w));
}

export interface StatusBarOptions {
  // The turn facts read at render time (the app's busy,
  // approval and cancel state), so the state word never lags a frame.
  readonly live?: () => Pick<
    StatusBarState,
    'turn' | 'busySince' | 'turnEdits'
  >;
}

export class StatusBar implements Component {
  private barState: StatusBarState;
  private readonly live: StatusBarOptions['live'];

  constructor(state: StatusBarState, options: StatusBarOptions = {}) {
    this.barState = state;
    this.live = options.live;
  }

  getState(): StatusBarState {
    return this.barState;
  }

  setState(state: StatusBarState): void {
    this.barState = state;
  }

  // Skip-flag toggle: synchronous, so the OFF indicator lands within
  // one frame. Session-scoped by construction — fresh instances start
  // safe (approvalsSkipped: false) and callers re-pass the flag.
  setApprovalsSkipped(skipped: boolean): void {
    this.setState({ ...this.barState, approvalsSkipped: skipped });
  }

  setRows(rows: ReadonlyArray<StatusUsageRow>): void {
    this.setState({ ...this.barState, rows });
  }

  render(width: number): string[] {
    const live = this.live?.();
    return [
      renderStatusLine(
        live === undefined ? this.barState : { ...this.barState, ...live },
        width,
      ),
    ];
  }

  invalidate(): void {}
}
