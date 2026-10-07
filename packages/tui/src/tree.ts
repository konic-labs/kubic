// AgentTreeView: always-visible one-node tree (issue #24).
// §18 tree always visible one node with live tool calls; §80 one-node +
// collapsing; §16.5 AgentTreeView; §16.7 click expand/collapse, wheel
// chains; §49.1 glyphs ✓/●/◌ with the root's $cost in/out tokens: the root
// and its tool children. Issue #345 adds the tool row's args + outcome and the ✗ error
// glyph, groups calls per turn (run-start closes a group) and measures
// truncation in columns.
//
// The lane feed accepts the worker's KubicLaneEvent shape structurally
// (packages/worker/src/lane/events.ts) WITHOUT importing it: the tui
// package must never import host/worker implementation (dep-lint), so
// only the fields the tree reads are typed here. `usage` rows sum into the
// root row; `fault` events are ignored.

import {
  sanitizeLaneText,
  summarizeToolArguments,
  summarizeToolOutcome,
} from './lane-cells.js';
import { formatStatusCost } from './status-bar.js';
import { tuiTheme } from './theme.js';
import type { Component, MouseRegionHandler } from './tui-boundary.js';
import { MouseRegion, truncateToWidth } from './tui-boundary.js';

export type RunStatus = 'idle' | 'running' | 'done';
export type ToolCallState = 'running' | 'done';

export function rootGlyph(status: RunStatus): string {
  if (status === 'running') return '●';
  if (status === 'done') return '✓';
  return '◌';
}

// Issue #345: a finished call that failed gets its own glyph — ✓ on an error
// was the bug. The colour is applied at render time (styleTreeLine), so the
// glyph stays distinct with NO_COLOR too.
export function toolGlyph(state: ToolCallState, error = false): string {
  if (state === 'running') return '●';
  return error ? '✗' : '✓';
}

export interface TreeToolCall {
  id: string;
  name: string;
  done: boolean;
  error: boolean;
  // Issue #345: the key argument (the bash command, the read/edit path) and
  // the finished call's outcome (a test summary, a non-zero exit). Both are
  // derived from untrusted model/tool output and sanitized at ingress.
  argsSummary?: string;
  outcome?: string;
  durationMs?: number;
}

// The conversation's own spend, summed from usage events (#345; §49.1): the
// root row shows `$cost in/out`. `seen` keeps the segment off a fresh tree
// that has not heard a usage row yet.
export interface TreeUsage {
  seen: boolean;
  costTotal: number;
  inputTokens: number;
  outputTokens: number;
}

// One completed turn, rolled up (#345): the tree only ever folds past turns
// into a count line, so it keeps the counts — not the calls — and its state
// stays bounded by the number of turns, never by the session's tool calls.
export interface TreeTurnSummary {
  calls: number;
  durationMs: number;
}

export interface AgentTreeState {
  label: string;
  rootStatus: RunStatus;
  // The LIVE turn's calls; a run-start rolls them into `previousTurns`.
  tools: TreeToolCall[];
  // One entry per completed turn, oldest first (#345): earlier turns fold
  // into a single line that names how many turns and calls it covers, so the
  // live turn is its own group instead of mixing into one count.
  previousTurns: TreeTurnSummary[];
  collapsed: boolean;
  usage: TreeUsage;
}

export function createTreeState(label = 'solo'): AgentTreeState {
  return {
    label,
    rootStatus: 'idle',
    tools: [],
    previousTurns: [],
    collapsed: false,
    usage: { seen: false, costTotal: 0, inputTokens: 0, outputTokens: 0 },
  };
}

export function toggleTree(state: AgentTreeState): void {
  state.collapsed = !state.collapsed;
}

function previousCalls(state: AgentTreeState): number {
  return state.previousTurns.reduce((sum, turn) => sum + turn.calls, 0);
}

function previousDurationMs(state: AgentTreeState): number {
  return state.previousTurns.reduce((sum, turn) => sum + turn.durationMs, 0);
}

// Issue #333 (§66): the tree renders the replicated presentation state the
// host projector folds — there is ONE lane input (the snapshot below), not a
// second event-driven path beside it. The summarizers stay here, so the state
// never carries a display string.
export interface TreeToolSnapshot {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status: 'running' | 'done';
  readonly isError: boolean;
  readonly args?: unknown;
  readonly entry?: unknown;
  readonly durationMs?: number;
}

export interface TreeLaneSnapshot {
  readonly status: RunStatus;
  readonly tools: ReadonlyArray<TreeToolSnapshot>;
  readonly usage?: {
    readonly costTotal: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
}

export function applyTreeSnapshot(
  state: AgentTreeState,
  lane: TreeLaneSnapshot,
): void {
  // A new turn (the root goes back to running) closes the previous group, the
  // same boundary the run-start event draws in the event-driven path.
  if (
    lane.status === 'running' &&
    state.rootStatus !== 'running' &&
    state.tools.length > 0
  ) {
    state.previousTurns.push({
      calls: state.tools.length,
      durationMs: state.tools.reduce(
        (sum, call) => sum + (call.durationMs ?? 0),
        0,
      ),
    });
    state.tools = [];
  }
  state.rootStatus = lane.status;
  state.tools = lane.tools.map((tool) => ({
    id: tool.toolCallId,
    name: sanitizeLaneText(tool.toolName),
    done: tool.status === 'done',
    error: tool.isError,
    argsSummary: summarizeToolArguments(tool.args),
    ...(tool.status === 'done'
      ? { outcome: summarizeToolOutcome(tool.entry, tool.toolName) }
      : {}),
    ...(tool.durationMs === undefined ? {} : { durationMs: tool.durationMs }),
  }));
  if (lane.usage !== undefined) {
    state.usage = {
      seen: true,
      costTotal: lane.usage.costTotal,
      inputTokens: lane.usage.inputTokens,
      outputTokens: lane.usage.outputTokens,
    };
  }
}

export function collapsedSummary(state: AgentTreeState): string {
  const calls = previousCalls(state) + state.tools.length;
  const total =
    previousDurationMs(state) +
    state.tools.reduce((sum, t) => sum + (t.durationMs ?? 0), 0);
  const unit = calls === 1 ? 'call' : 'calls';
  return `…${calls} ${unit}, ${total}ms`;
}

function toolLine(call: TreeToolCall): string {
  const parts = [
    toolGlyph(call.done ? 'done' : 'running', call.error),
    call.name,
  ];
  if (call.argsSummary !== undefined && call.argsSummary !== '') {
    parts.push(call.argsSummary);
  }
  if (call.durationMs !== undefined) parts.push(`${call.durationMs}ms`);
  const line = `  ${parts.join(' ')}`;
  return call.outcome === undefined ? line : `${line} · ${call.outcome}`;
}

// Tokens read in thousands once the number stops being glanceable; the
// sub-100 counters stay exact (`42`), everything above scales (`0.3k`,
// `1.2k`, `182.4k`).
export function formatTreeTokens(count: number): string {
  const n = Math.max(0, Math.round(count));
  if (n < 100) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

function rootLine(state: AgentTreeState): string {
  const head = `${rootGlyph(state.rootStatus)} ${state.label}`;
  if (!state.usage.seen) return head;
  const cost = formatStatusCost(state.usage.costTotal);
  const tokens = `${formatTreeTokens(state.usage.inputTokens)}/${formatTreeTokens(
    state.usage.outputTokens,
  )}`;
  return `${head} ${cost} ${tokens}`;
}

// One line covers every completed turn: the live turn below is visibly its
// own group, and the count still names how much history the fold hides.
function earlierTurnsLine(callCount: number, turnCount: number): string {
  const calls = callCount === 1 ? 'call' : 'calls';
  const turns = turnCount === 1 ? 'turn' : 'turns';
  return `  … ${callCount} earlier ${calls} in ${turnCount} ${turns}`;
}

function fitLine(line: string, width: number): string {
  return truncateToWidth(line, Math.max(0, width), '…');
}

// Pure headless render (no VirtualTerminal in Pi 0.85.1): callers render
// these lines directly like renderLayout in layout.test.ts.
export function renderTreeLines(
  state: AgentTreeState,
  width: number,
): string[] {
  const w = Math.max(0, Math.floor(width));
  const lines = [rootLine(state)];
  if (state.collapsed) {
    if (previousCalls(state) + state.tools.length > 0) {
      lines.push(`  ${collapsedSummary(state)}`);
    }
  } else {
    // The row is height-capped (layout TREE_MAX_ROWS): the LATEST calls are
    // the live work, so older ones fold into one count line.
    let budget = TREE_MAX_TOOL_LINES;
    const earlier = previousCalls(state);
    if (earlier > 0) {
      lines.push(earlierTurnsLine(earlier, state.previousTurns.length));
      budget -= 1;
    }
    if (budget > 0) {
      const calls = state.tools;
      const overflow = calls.length - budget;
      if (overflow > 0) {
        const hidden = overflow + 1;
        lines.push(`  … ${hidden} earlier ${hidden === 1 ? 'call' : 'calls'}`);
        for (const call of calls.slice(hidden)) lines.push(toolLine(call));
      } else {
        for (const call of calls) lines.push(toolLine(call));
      }
    }
  }
  return lines.map((line) => styleTreeLine(fitLine(line, w)));
}

// Tool lines shown before older calls fold into a count (one row is the
// root, so root + TREE_MAX_TOOL_LINES fits layout's TREE_MAX_ROWS of 6).
// A previous-turns fold line takes one of these slots, so the live turn
// shows one call fewer (#345).
export const TREE_MAX_TOOL_LINES = 5;

// Colour is applied AFTER truncation, over the plain line, so widths are
// measured on text only. Identity under the default (plain) theme.
function styleTreeLine(line: string): string {
  const theme = tuiTheme();
  if (theme.level === 'none') return line;
  const match = /^(\s*)(✓|✗|●|◌)( .*)$/u.exec(line);
  if (match === null) return theme.muted(line);
  const [, lead = '', glyph = '', rest = ''] = match;
  const styledGlyph =
    glyph === '✓'
      ? theme.success(glyph)
      : glyph === '✗'
        ? theme.error(glyph)
        : glyph === '●'
          ? theme.warm(glyph)
          : theme.muted(glyph);
  const styledRest = rest.replace(/ (\d+ms)$/, ` ${theme.muted('$1')}`);
  return `${lead}${styledGlyph}${lead === '' ? theme.bold(styledRest) : styledRest}`;
}

export type TreeMouseEvent = Parameters<MouseRegionHandler>[0];
export type TreeMouseResult = ReturnType<MouseRegionHandler>;

export interface TreeViewOptions {
  label?: string;
  collapsed?: boolean;
  onFocusEditor?: () => void;
}

export const TOGGLE_KEYS: ReadonlySet<string> = new Set([
  't',
  'T',
  '\r',
  '\n',
  ' ',
]);

// Inner body: renders exact pre-truncated lines (no padding/wrap) so
// headless snapshots assert content, not pixels. Pi's Text pads to the
// full width, which would bury the tree lines in spaces.
class TreeBody implements Component {
  private treeState: AgentTreeState;

  constructor(state: AgentTreeState) {
    this.treeState = state;
  }

  render(width: number): string[] {
    return renderTreeLines(this.treeState, width);
  }

  invalidate(): void {}
}

export class AgentTreeView implements Component {
  private body: TreeBody;
  private region: MouseRegion;
  private treeState: AgentTreeState;
  private focusEditor: () => void;

  constructor(state?: AgentTreeState, options?: TreeViewOptions) {
    this.treeState = state ?? createTreeState(options?.label);
    if (options?.collapsed !== undefined) {
      this.treeState.collapsed = options.collapsed;
    }
    this.focusEditor = options?.onFocusEditor ?? (() => {});
    this.body = new TreeBody(this.treeState);
    this.region = new MouseRegion(this.body, (event) => this.onMouse(event));
  }

  getState(): AgentTreeState {
    return this.treeState;
  }

  // Issue #305: `/new` and `/resume` show another session's work; the tree
  // starts empty (the label is the view's own default). Issue #453: the
  // caller says whether it starts collapsed — solo hides the tree row until
  // Ctrl-T opens it.
  reset(label?: string, collapsed = false): void {
    this.treeState = createTreeState(label);
    this.treeState.collapsed = collapsed;
    this.body = new TreeBody(this.treeState);
    this.region = new MouseRegion(this.body, (event) => this.onMouse(event));
  }

  isCollapsed(): boolean {
    return this.treeState.collapsed;
  }

  toggle(): void {
    toggleTree(this.treeState);
  }

  handleInput(data: string): void {
    if (!TOGGLE_KEYS.has(data)) return;
    this.toggle();
    this.focusEditor();
  }

  handleMouse(event: TreeMouseEvent): TreeMouseResult {
    return this.region.handleMouse(event);
  }

  render(width: number): string[] {
    return this.region.render(width);
  }

  invalidate(): void {
    this.body.invalidate();
    this.region.invalidate();
  }

  private onMouse(event: TreeMouseEvent): TreeMouseResult {
    // Click toggles collapse and returns focus to the editor (§16.7).
    // Wheel/move/drag/release chain through (undefined) so the
    // transcript keeps scrolling under the tree.
    if (event.type !== 'click') return undefined;
    if (event.button !== 'left') return undefined;
    this.toggle();
    this.focusEditor();
    return { handled: true };
  }
}
