// Slice A RED: AgentTreeView one-node + ToolOutput collapsing (issue #24).
// Solo-only: root + tool children, glyphs ✓/●/◌, keyboard+click toggle,
// truncation. Headless snapshots render directly (no VirtualTerminal in
// Pi 0.85.1) like layout.test.ts.
import { describe, expect, it } from 'vitest';
import {
  applyLaneEvent,
  collapsedSummary,
  createTreeState,
  renderTreeLines,
  rootGlyph,
  toggleTree,
  toolGlyph,
} from './tree.js';

function startTool(
  id: string,
  name: string,
): {
  type: 'tool-start';
  lane: string;
  runId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
} {
  return {
    type: 'tool-start',
    lane: 'solo',
    runId: 'r1',
    turnId: 't1',
    toolCallId: id,
    toolName: name,
    args: {},
  };
}

describe('tree glyphs (issue #24; §49.1)', () => {
  it('maps root status to ◌/●/✓', () => {
    expect(rootGlyph('idle')).toBe('◌');
    expect(rootGlyph('running')).toBe('●');
    expect(rootGlyph('done')).toBe('✓');
  });

  it('maps tool state to ●/✓', () => {
    expect(toolGlyph('running')).toBe('●');
    expect(toolGlyph('done')).toBe('✓');
  });
});

describe('tree lane feed (issue #24; §18)', () => {
  it('shows ● root with live children on start/finish', () => {
    const state = createTreeState();
    expect(renderTreeLines(state, 100)[0]).toBe('◌ solo');
    applyLaneEvent(state, {
      type: 'run-start',
      lane: 's',
      runId: 'r',
      startedAt: 0,
    });
    applyLaneEvent(state, startTool('c1', 'bash'), () => 0);
    const lines = renderTreeLines(state, 100);
    expect(lines[0]).toBe('● solo');
    expect(lines[1]).toBe('  ● bash');
    applyLaneEvent(
      state,
      {
        type: 'tool-end',
        lane: 's',
        runId: 'r',
        turnId: 't',
        toolCallId: 'c1',
        toolName: 'bash',
        isError: false,
        terminate: false,
      },
      () => 142,
    );
    expect(renderTreeLines(state, 100)[1]).toBe('  ✓ bash 142ms');
  });

  it('surfaces a tool finish even without a prior start', () => {
    const state = createTreeState();
    applyLaneEvent(state, {
      type: 'tool-end',
      lane: 's',
      runId: 'r',
      turnId: 't',
      toolCallId: 'c9',
      toolName: 'bash',
      isError: true,
      terminate: false,
    });
    expect(renderTreeLines(state, 100)).toContain('  ✓ bash error');
  });
});

describe('tree collapse (issue #24; §80)', () => {
  it('collapses to a summary vs expanded per-call lines', () => {
    const state = createTreeState();
    const clock = { now: 0 };
    applyLaneEvent(state, {
      type: 'run-start',
      lane: 's',
      runId: 'r',
      startedAt: 0,
    });
    for (const [id, at] of [
      ['c1', 40],
      ['c2', 60],
      ['c3', 42],
    ] as const) {
      clock.now = 0;
      applyLaneEvent(state, startTool(id, 'bash'), () => clock.now);
      clock.now = at;
      applyLaneEvent(
        state,
        {
          type: 'tool-end',
          lane: 's',
          runId: 'r',
          turnId: 't',
          toolCallId: id,
          toolName: 'bash',
          isError: false,
          terminate: false,
        },
        () => clock.now,
      );
    }
    expect(collapsedSummary(state)).toBe('…3 calls, 142ms');
    toggleTree(state);
    const collapsed = renderTreeLines(state, 100);
    expect(collapsed).toEqual(['● solo', '  …3 calls, 142ms']);
    toggleTree(state);
    const expanded = renderTreeLines(state, 100);
    expect(expanded).toEqual([
      '● solo',
      '  ✓ bash 40ms',
      '  ✓ bash 60ms',
      '  ✓ bash 42ms',
    ]);
  });
});
