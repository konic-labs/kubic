// AgentTreeView: always-visible one-node tree (issue #24).
// §18 tree always visible one node with live tool calls; §80 one-node +
// collapsing; §16.5 AgentTreeView; §16.7 click expand/collapse, wheel
// chains; §49.1 glyphs ✓/●/◌. Solo-only: root + tool children — no
// worktree/worker columns (layout unchanged for later).
//
// The lane feed accepts the worker's KubicLaneEvent shape structurally
// (packages/worker/src/lane/events.ts) WITHOUT importing it: the tui
// package must never import host/worker implementation (dep-lint), so
// only the fields the tree reads are typed here. `usage`/`fault` events
// are ignored.

import { sanitizeLaneText } from './lane-cells.js';
import { tuiTheme } from './theme.js';
import type { Component, MouseRegionHandler } from './tui-boundary.js';
import { MouseRegion } from './tui-boundary.js';

export type RunStatus = 'idle' | 'running' | 'done';
export type ToolCallState = 'running' | 'done';

export function rootGlyph(status: RunStatus): string {
  if (status === 'running') return '●';
  if (status === 'done') return '✓';
  return '◌';
}

export function toolGlyph(state: ToolCallState): string {
  return state === 'running' ? '●' : '✓';
}

export interface TreeToolCall {
  id: string;
  name: string;
  done: boolean;
  error: boolean;
  durationMs?: number;
  startedAt?: number;
}

export interface AgentTreeState {
  label: string;
  rootStatus: RunStatus;
  tools: TreeToolCall[];
  collapsed: boolean;
}

export function createTreeState(label = 'solo'): AgentTreeState {
  return { label, rootStatus: 'idle', tools: [], collapsed: false };
}

export function toggleTree(state: AgentTreeState): void {
  state.collapsed = !state.collapsed;
}

// Structural lane input: handled members mirror KubicLaneEvent
// (run-start/run-end/tool-start/tool-end); anything else is ignored.
// The index signature keeps fresh literals with lane/runId/etc
// assignable without importing the worker package.
export interface LaneEventLike {
  readonly type: string;
  readonly status?: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly isError?: boolean;
  readonly [key: string]: unknown;
}

export function applyLaneEvent(
  state: AgentTreeState,
  event: LaneEventLike,
  now: () => number = Date.now,
): void {
  switch (event.type) {
    case 'run-start': {
      state.rootStatus = 'running';
      return;
    }
    case 'run-end': {
      state.rootStatus = 'done';
      return;
    }
    case 'tool-start': {
      if (typeof event.toolCallId !== 'string') return;
      if (typeof event.toolName !== 'string') return;
      // Issue #88, third-pass review finding: the name is model-supplied
      // (pi-agent-core copies it straight off the assistant's tool call), so
      // it carries the same control sequences as any other lane content and
      // must not reach the frame raw. Sanitized HERE, at the tree's ingress,
      // so every render path downstream is covered by one choke point.
      const toolName = sanitizeLaneText(event.toolName);
      const at = now();
      const existing = state.tools.find((t) => t.id === event.toolCallId);
      if (existing === undefined) {
        state.tools.push({
          id: event.toolCallId,
          name: toolName,
          done: false,
          error: false,
          durationMs: undefined,
          startedAt: at,
        });
      } else {
        existing.name = toolName;
        existing.done = false;
        existing.error = false;
        existing.durationMs = undefined;
        existing.startedAt = at;
      }
      return;
    }
    case 'tool-end': {
      if (typeof event.toolCallId !== 'string') return;
      if (typeof event.toolName !== 'string') return;
      const toolName = sanitizeLaneText(event.toolName);
      const at = now();
      const existing = state.tools.find((t) => t.id === event.toolCallId);
      if (existing === undefined) {
        state.tools.push({
          id: event.toolCallId,
          name: toolName,
          done: true,
          error: event.isError === true,
          durationMs: undefined,
          startedAt: undefined,
        });
      } else {
        existing.done = true;
        existing.error = event.isError === true;
        existing.durationMs =
          existing.startedAt === undefined
            ? undefined
            : Math.max(0, at - existing.startedAt);
      }
      return;
    }
    default: {
      return;
    }
  }
}

export function collapsedSummary(state: AgentTreeState): string {
  const total = state.tools.reduce((sum, t) => sum + (t.durationMs ?? 0), 0);
  const unit = state.tools.length === 1 ? 'call' : 'calls';
  return `…${state.tools.length} ${unit}, ${total}ms`;
}

function toolLine(call: TreeToolCall): string {
  const parts = [toolGlyph(call.done ? 'done' : 'running'), call.name];
  if (call.error) parts.push('error');
  if (call.durationMs !== undefined) parts.push(`${call.durationMs}ms`);
  return `  ${parts.join(' ')}`;
}

function truncateLine(line: string, width: number): string {
  if (line.length <= width) return line;
  if (width <= 0) return '';
  return `${line.slice(0, width - 1)}…`;
}

// Pure headless render (no VirtualTerminal in Pi 0.85.1): callers render
// these lines directly like renderLayout in layout.test.ts.
export function renderTreeLines(
  state: AgentTreeState,
  width: number,
): string[] {
  const w = Math.max(0, Math.floor(width));
  const lines = [`${rootGlyph(state.rootStatus)} ${state.label}`];
  if (state.collapsed) {
    if (state.tools.length > 0) lines.push(`  ${collapsedSummary(state)}`);
  } else {
    // The row is height-capped (layout TREE_MAX_ROWS): the LATEST calls are
    // the live work, so older ones fold into one count line.
    const calls = state.tools;
    const overflow = calls.length - TREE_MAX_TOOL_LINES;
    if (overflow > 0) {
      const hidden = overflow + 1;
      lines.push(`  … ${hidden} earlier ${hidden === 1 ? 'call' : 'calls'}`);
      for (const call of calls.slice(hidden)) lines.push(toolLine(call));
    } else {
      for (const call of calls) lines.push(toolLine(call));
    }
  }
  return lines.map((line) => styleTreeLine(truncateLine(line, w)));
}

// Tool lines shown before older calls fold into a count (one row is the
// root, so root + TREE_MAX_TOOL_LINES fits layout's TREE_MAX_ROWS of 6).
export const TREE_MAX_TOOL_LINES = 5;

// Colour is applied AFTER truncation, over the plain line, so widths are
// measured on text only. Identity under the default (plain) theme.
function styleTreeLine(line: string): string {
  const theme = tuiTheme();
  if (theme.level === 'none') return line;
  const match = /^(\s*)(✓|●|◌)( .*)$/u.exec(line);
  if (match === null) return theme.muted(line);
  const [, lead = '', glyph = '', rest = ''] = match;
  const styledGlyph =
    glyph === '✓'
      ? theme.success(glyph)
      : glyph === '●'
        ? theme.warm(glyph)
        : theme.muted(glyph);
  const styledRest = rest
    .replace(/ error\b/, ` ${theme.error('error')}`)
    .replace(/ (\d+ms)$/, ` ${theme.muted('$1')}`);
  return `${lead}${styledGlyph}${lead === '' ? theme.bold(styledRest) : styledRest}`;
}

export type TreeMouseEvent = Parameters<MouseRegionHandler>[0];
export type TreeMouseResult = ReturnType<MouseRegionHandler>;

export interface TreeViewOptions {
  label?: string;
  collapsed?: boolean;
  onFocusEditor?: () => void;
  clock?: () => number;
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
  private clock: () => number;

  constructor(state?: AgentTreeState, options?: TreeViewOptions) {
    this.treeState = state ?? createTreeState(options?.label);
    if (options?.collapsed !== undefined) {
      this.treeState.collapsed = options.collapsed;
    }
    this.focusEditor = options?.onFocusEditor ?? (() => {});
    this.clock = options?.clock ?? Date.now;
    this.body = new TreeBody(this.treeState);
    this.region = new MouseRegion(this.body, (event) => this.onMouse(event));
  }

  getState(): AgentTreeState {
    return this.treeState;
  }

  isCollapsed(): boolean {
    return this.treeState.collapsed;
  }

  toggle(): void {
    toggleTree(this.treeState);
  }

  update(event: LaneEventLike): void {
    applyLaneEvent(this.treeState, event, this.clock);
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
