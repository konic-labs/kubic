// Cost/Model status bar + mode indicator (issue #27).
// §39 usage rows aggregated with the cache split; §18 model +
// thinking / tokens / cache / cost / mode / approvals-disabled; §17
// always-visible solo/orchestrator + OFF indicator; §16.2 StatusBar
// basis 2; §80 cost + status + indicator. Budget burn-down is out of
// scope (orchestrator).
//
// Structural usage mirror: the fields below repeat the shape read in
// packages/worker/src/usage.ts (KubicUsageRow) WITHOUT importing it —
// dep-lint forbids tui → worker. Pi is untouched here (pure strings);
// the Component seam stays in ./tui-boundary.js. No node:fs (I/O
// confinement). Faux-only tests: fixtures, zero network.
//
// Issue #346: the TTFT/tool-ms segments were deleted, not repaired. Pi 1.0
// routes no streaming/timing field Kubic could read (message deltas stay
// inside the harness; the lane watch commits whole entries), so the two
// segments could never render — dead code, which was the bug. The bar shows
// what the lane really reports: tokens, cache, cost, mode, posture.
import { tuiTheme } from './theme.js';
import type { Component } from './tui-boundary.js';

export interface StatusUsageCost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly total: number;
}

export interface StatusUsage {
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
  // Issue #347: the prompt size of the last COMMITTED request (its input plus
  // the cache-read tokens it reused — pi's `input` excludes the cached
  // prefix). Undefined until a row names its committed entry: the seeded
  // `pi.usage` buckets (#346) are cumulative, so reading them here would show
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
      contextTokens = row.usage.input + row.usage.cacheRead;
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

export type StatusMode = 'solo' | 'orchestrator';

export interface StatusBarState {
  readonly model: string;
  readonly thinking: string;
  readonly rows: ReadonlyArray<StatusUsageRow>;
  readonly mode: StatusMode;
  readonly approvalsSkipped: boolean;
  readonly sessionId: string;
  // Issue #347 (§18): the model's context window and the token level at
  // which the solo lane compacts (window − reserve, #399's policy; #239 will
  // make the reserve configurable). Both absent means the gauge stays off —
  // an unknown window must never render a made-up percentage.
  readonly contextWindow?: number;
  readonly compactionThreshold?: number;
}

export interface StatusBarTheme {
  readonly warning: (text: string) => string;
}

const ESC = String.fromCharCode(27);

export const DEFAULT_STATUS_THEME: StatusBarTheme = {
  warning: (text: string): string => `${ESC}[33;1m${text}${ESC}[0m`,
};

function stripAnsi(line: string): string {
  return line.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
}

export function statusVisibleWidth(line: string): number {
  return stripAnsi(line).length;
}

function truncateLine(
  line: string,
  width: number,
  wrap?: (text: string) => string,
): string {
  if (statusVisibleWidth(line) <= width) return line;
  if (width <= 0) return '';
  const plain = stripAnsi(line);
  const head = `${plain.slice(0, width - 1)}…`;
  // ANSI re-wrap: truncation strips SGR spans, so callers whose source
  // line carries theme styling re-apply it to the truncated head —
  // otherwise a narrowed OFF line loses its warning color entirely.
  return wrap === undefined ? head : wrap(head);
}

function shortModel(model: string, width: number, rest: string): string {
  const room = width - statusVisibleWidth(rest);
  if (room <= 0) return '';
  if (model.length <= room) return model;
  if (room < 4) return model.slice(0, room);
  return `${model.slice(0, room - 1)}…`;
}

// Issue #347: the context gauge. `undefined` (unknown window, or no
// committed request yet) means no segment at all — a wrong percentage is
// worse than a missing one. At or above the compaction threshold the segment
// takes the warning colour: the next turn is about to compact.
function contextSegment(
  state: StatusBarState,
  summary: StatusSummary,
  theme: StatusBarTheme,
): string | undefined {
  const window = state.contextWindow;
  const used = summary.contextTokens;
  if (window === undefined || !(window > 0) || used === undefined) {
    return undefined;
  }
  const percent = Math.min(100, Math.max(0, Math.round((used / window) * 100)));
  const text = `ctx ${percent}%`;
  const threshold = state.compactionThreshold;
  return threshold !== undefined && used >= threshold
    ? theme.warning(text)
    : text;
}

// Row 1 segments, highest truncation priority last: the context gauge drops
// first, then thinking, then the model shrinks; tokens + session cost never
// go.
function renderRow1(
  state: StatusBarState,
  summary: StatusSummary,
  width: number,
  theme: StatusBarTheme,
): string {
  const tokens = `in ${summary.input} out ${summary.output} (cached ${summary.cacheRead})`;
  const cost = formatStatusCost(summary.costTotal);
  const base = `${state.model} • thinking ${state.thinking} • ${tokens} • ${cost}`;
  const ctx = contextSegment(state, summary, theme);
  const full = ctx === undefined ? base : `${base} • ${ctx}`;
  if (statusVisibleWidth(full) <= width) return full;
  if (statusVisibleWidth(base) <= width) return base;
  const bare = `${shortModel(state.model, width, ` • ${tokens} • ${cost}`)} • ${tokens} • ${cost}`;
  if (statusVisibleWidth(bare) <= width) return bare;
  // The last rung keeps the cost (#346 review): truncating the tail would
  // drop the one number the bar exists for, so the token half is cut to the
  // room left over and the cost is always appended.
  const tail = ` • ${cost}`;
  const room = width - statusVisibleWidth(tail);
  if (room < 2) return truncateLine(cost, width);
  return `${truncateLine(` • ${tokens}`, room)}${tail}`;
}

// Row 2: always-visible posture indicator. OFF is warning-themed and
// unmissable (`! warning: … OFF (full-access)` — the same `warning:` +
// `full-access` vocabulary `kubic sessions` prints, so doctor output
// and the bar agree). Session id truncates first; mode + approvals
// survive narrowing.
function renderRow2(
  state: StatusBarState,
  theme: StatusBarTheme,
  width: number,
): string {
  const approvals = state.approvalsSkipped
    ? theme.warning('! warning: approvals OFF (full-access)')
    : 'approvals:on';
  const full = `${state.mode} • ${approvals} • session ${state.sessionId}`;
  if (statusVisibleWidth(full) <= width) return full;
  const head = `${state.mode} • ${approvals}`;
  // Only the OFF head carries warning styling; a narrowed ON line is
  // plain text and must not gain warning color through truncation.
  const wrap = state.approvalsSkipped === true ? theme.warning : undefined;
  if (statusVisibleWidth(head) > width) {
    return truncateLine(head, width, wrap);
  }
  const room = width - statusVisibleWidth(head) - ' • session '.length;
  if (room >= 4) {
    const shortId =
      state.sessionId.length <= room
        ? state.sessionId
        : `${state.sessionId.slice(0, room - 1)}…`;
    const attempt = `${state.mode} • ${approvals} • session ${shortId}`;
    if (statusVisibleWidth(attempt) <= width) return attempt;
  }
  return truncateLine(head, width, wrap);
}

// Pure headless render (no VirtualTerminal in Pi 0.85.1): callers
// assert these two lines directly like renderLayout in layout.test.ts.
//
// Supported minimum width is 40 columns: below that the rows still
// clamp to the given width (best-effort, cost + mode survive longest)
// but layout priority is no longer guaranteed. Non-finite widths
// (NaN/Infinity) normalize to 0 and render empty lines.
export function renderStatusLines(
  state: StatusBarState,
  width: number,
  theme: StatusBarTheme = DEFAULT_STATUS_THEME,
): string[] {
  const w = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const summary = summarizeStatusRows(state.rows);
  return [renderRow1(state, summary, w, theme), renderRow2(state, theme, w)];
}

// Inner body: renders the exact pre-truncated lines (no padding/wrap)
// so headless snapshots assert content, not pixels — same pattern as
// the tree's TreeBody (Pi's Text pads to full width).
class StatusBody implements Component {
  private barState: StatusBarState;
  private theme: StatusBarTheme;

  constructor(state: StatusBarState, theme: StatusBarTheme) {
    this.barState = state;
    this.theme = theme;
  }

  setState(state: StatusBarState): void {
    this.barState = state;
  }

  render(width: number): string[] {
    const lines = renderStatusLines(this.barState, width, this.theme);
    const palette = tuiTheme();
    if (palette.level === 'none') return lines;
    // Colour over the already width-fitted plain rows: the model in bold,
    // the rest secondary; row 2 keeps its own warning styling when
    // approvals are off.
    const [row1 = '', row2 = ''] = lines;
    const model = this.barState.model;
    const styled1 = row1.startsWith(model)
      ? `${palette.bold(model)}${palette.muted(row1.slice(model.length))}`
      : palette.muted(row1);
    const styled2 = this.barState.approvalsSkipped
      ? row2
      : row2.startsWith(this.barState.mode)
        ? `${palette.accent(this.barState.mode)}${palette.muted(row2.slice(this.barState.mode.length))}`
        : palette.muted(row2);
    return [styled1, styled2];
  }

  invalidate(): void {}
}

export interface StatusBarOptions {
  readonly theme?: StatusBarTheme;
}

export class StatusBar implements Component {
  private readonly body: StatusBody;
  private barState: StatusBarState;

  constructor(state: StatusBarState, options: StatusBarOptions = {}) {
    this.barState = state;
    this.body = new StatusBody(state, options.theme ?? DEFAULT_STATUS_THEME);
  }

  getState(): StatusBarState {
    return this.barState;
  }

  setState(state: StatusBarState): void {
    this.barState = state;
    this.body.setState(state);
  }

  // Skip-flag toggle: synchronous, so the OFF indicator lands within
  // one frame. Session-scoped by construction — fresh instances start
  // safe (approvalsSkipped: false) and callers re-pass the flag.
  setApprovalsSkipped(skipped: boolean): void {
    this.setState({ ...this.barState, approvalsSkipped: skipped });
  }

  // Issue #327: the session mode toggle lands on the always-visible
  // indicator within one frame (the same synchronous path the skip flag
  // takes). Session-scoped by construction: fresh instances start from the
  // seed's mode and callers re-pass every change.
  setMode(mode: StatusMode): void {
    this.setState({ ...this.barState, mode });
  }

  setRows(rows: ReadonlyArray<StatusUsageRow>): void {
    this.setState({ ...this.barState, rows });
  }

  render(width: number): string[] {
    return this.body.render(width);
  }

  invalidate(): void {
    this.body.invalidate();
  }
}
