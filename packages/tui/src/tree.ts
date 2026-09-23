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
      const at = now();
      const existing = state.tools.find((t) => t.id === event.toolCallId);
      if (existing === undefined) {
        state.tools.push({
          id: event.toolCallId,
          name: event.toolName,
          done: false,
          error: false,
          durationMs: undefined,
          startedAt: at,
        });
      } else {
        existing.name = event.toolName;
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
      const at = now();
      const existing = state.tools.find((t) => t.id === event.toolCallId);
      if (existing === undefined) {
        state.tools.push({
          id: event.toolCallId,
          name: event.toolName,
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
            : at - existing.startedAt;
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
    for (const call of state.tools) lines.push(toolLine(call));
  }
  return lines.map((line) => truncateLine(line, w));
}
