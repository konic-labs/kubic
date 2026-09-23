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
// TTFT/latency choice: last-wins. The bar shows the LIVE reading, so
// the latest row reporting ttftMs/latencyMs wins (a silent row never
// clears a previous reading).
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
  readonly ttftMs?: number;
  readonly latencyMs?: number;
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
  readonly ttftMs?: number;
  readonly toolMs?: number;
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
  let ttftMs: number | undefined;
  let toolMs: number | undefined;
  for (const row of rows) {
    requests += 1;
    input += row.usage.input;
    output += row.usage.output;
    cacheRead += row.usage.cacheRead;
    cacheWrite += row.usage.cacheWrite;
    costTotal += row.usage.cost.total;
    if (row.ttftMs !== undefined) ttftMs = row.ttftMs;
    if (row.latencyMs !== undefined) toolMs = row.latencyMs;
  }
  return {
    requests,
    input,
    output,
    cacheRead,
    cacheWrite,
    costTotal,
    ttftMs,
    toolMs,
  };
}

export function formatStatusCost(total: number): string {
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

function truncateLine(line: string, width: number): string {
  if (statusVisibleWidth(line) <= width) return line;
  if (width <= 0) return '';
  const plain = stripAnsi(line);
  return `${plain.slice(0, width - 1)}…`;
}

function shortModel(model: string, width: number, rest: string): string {
  const room = width - statusVisibleWidth(rest);
  if (room <= 0) return '';
  if (model.length <= room) return model;
  if (room < 4) return model.slice(0, room);
  return `${model.slice(0, room - 1)}…`;
}

// Row 1 segments, highest truncation priority last: model goes first,
// thinking / tool-ms / TTFT drop next, tokens + session cost never go.
function renderRow1(
  state: StatusBarState,
  summary: StatusSummary,
  width: number,
): string {
  const tokens = `in ${summary.input} out ${summary.output} (cached ${summary.cacheRead})`;
  const cost = formatStatusCost(summary.costTotal);
  const ttft =
    summary.ttftMs === undefined ? '' : ` • TTFT ${summary.ttftMs}ms`;
  const tool =
    summary.toolMs === undefined ? '' : ` • tool ${summary.toolMs}ms`;
  const full = `${state.model} • thinking ${state.thinking} • ${tokens} • ${cost}${ttft}${tool}`;
  if (statusVisibleWidth(full) <= width) return full;
  const noThinking = `${shortModel(state.model, width, ` • ${tokens} • ${cost}${ttft}${tool}`)} • ${tokens} • ${cost}${ttft}${tool}`;
  if (statusVisibleWidth(noThinking) <= width) return noThinking;
  const noTool = `${shortModel(state.model, width, ` • ${tokens} • ${cost}${ttft}`)} • ${tokens} • ${cost}${ttft}`;
  if (statusVisibleWidth(noTool) <= width) return noTool;
  const bare = `${shortModel(state.model, width, ` • ${tokens} • ${cost}`)} • ${tokens} • ${cost}`;
  if (statusVisibleWidth(bare) <= width) return bare;
  return truncateLine(` • ${tokens} • ${cost}`, width);
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
  if (statusVisibleWidth(head) > width) {
    return truncateLine(head, width);
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
  return truncateLine(head, width);
}

// Pure headless render (no VirtualTerminal in Pi 0.85.1): callers
// assert these two lines directly like renderLayout in layout.test.ts.
export function renderStatusLines(
  state: StatusBarState,
  width: number,
  theme: StatusBarTheme = DEFAULT_STATUS_THEME,
): string[] {
  const w = Math.max(0, Math.floor(width));
  const summary = summarizeStatusRows(state.rows);
  return [renderRow1(state, summary, w), renderRow2(state, theme, w)];
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
    return renderStatusLines(this.barState, width, this.theme);
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
