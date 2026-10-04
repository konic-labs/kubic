// Slice A: AgentTreeView one-node + ToolOutput collapsing (issue #24).
// Solo-only: root + tool children, glyphs ✓/●/◌, keyboard+click toggle,
// truncation. Headless snapshots render directly (no VirtualTerminal in
// Pi 0.85.1) like layout.test.ts.
import { describe, expect, it } from 'vitest';
import {
  AgentTreeView,
  applyLaneEvent,
  collapsedSummary,
  createTreeState,
  renderTreeLines,
  rootGlyph,
  toggleTree,
  toolGlyph,
} from './tree.js';
import { visibleWidth } from './tui-boundary.js';

const ESC = String.fromCharCode(27);

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

  it('maps an errored finish to ✗ (issue #345)', () => {
    expect(toolGlyph('done', true)).toBe('✗');
    expect(toolGlyph('running', true)).toBe('●');
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
    expect(renderTreeLines(state, 100)).toContain('  ✗ bash');
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

describe('tree toggle input (issue #24; §16.7)', () => {
  it('toggles on key and returns focus to the editor', () => {
    const state = createTreeState();
    let editorFocus = 0;
    const view = new AgentTreeView(state, {
      onFocusEditor: () => editorFocus++,
    });
    expect(view.isCollapsed()).toBe(false);
    view.handleInput('t');
    expect(view.isCollapsed()).toBe(true);
    expect(editorFocus).toBe(1);
    view.handleInput('\r');
    expect(view.isCollapsed()).toBe(false);
    expect(editorFocus).toBe(2);
  });

  it('toggles on click, chains wheel to the transcript', () => {
    const state = createTreeState();
    let editorFocus = 0;
    const view = new AgentTreeView(state, {
      onFocusEditor: () => editorFocus++,
    });
    const clicked = view.handleMouse({
      type: 'click',
      button: 'left',
      x: 0,
      y: 0,
      screenX: 0,
      screenY: 0,
      width: 100,
      height: 2,
      shift: false,
      alt: false,
      ctrl: false,
    });
    expect(clicked?.handled).toBe(true);
    expect(view.isCollapsed()).toBe(true);
    expect(editorFocus).toBe(1);
    const wheeled = view.handleMouse({
      type: 'wheel',
      button: 'none',
      x: 0,
      y: 0,
      screenX: 0,
      screenY: 0,
      width: 100,
      height: 2,
      shift: false,
      alt: false,
      ctrl: false,
      wheelDelta: -1,
    });
    expect(wheeled).toBeUndefined();
    expect(view.isCollapsed()).toBe(true);
  });
});

describe('tree snapshots (issue #24; headless, no VirtualTerminal)', () => {
  function populated(): AgentTreeView {
    const state = createTreeState();
    const clock = { now: 0 };
    applyLaneEvent(state, {
      type: 'run-start',
      lane: 's',
      runId: 'r',
      startedAt: 0,
    });
    clock.now = 0;
    applyLaneEvent(state, startTool('c1', 'bash'), () => clock.now);
    clock.now = 142;
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
      () => clock.now,
    );
    applyLaneEvent(state, startTool('c2', 'bash'));
    return new AgentTreeView(state);
  }

  it('snapshots the expanded tree', () => {
    expect(populated().render(100)).toEqual([
      '● solo',
      '  ✓ bash 142ms',
      '  ● bash',
    ]);
  });

  it('snapshots the collapsed tree', () => {
    const view = populated();
    view.toggle();
    expect(view.render(100)).toEqual(['● solo', '  …2 calls, 142ms']);
  });

  it('truncates every line at narrow widths (minSize 6)', () => {
    const view = populated();
    for (const width of [30, 12, 6]) {
      for (const line of view.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
    expect(populated().render(6)[0]).toContain('●');
  });
});

function usageEvent(
  input: number,
  output: number,
  total: number,
): {
  type: 'usage';
  row: unknown;
  entry: unknown;
} {
  return {
    type: 'usage',
    row: {
      model: 'faux/faux',
      provider: 'faux',
      usage: {
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: input + output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
      },
    },
    entry: {},
  };
}

function toolResult(text: string, isError = false): Record<string, unknown> {
  return {
    id: 1,
    conversationId: 1,
    kind: 'pi.tool-result',
    model: [
      {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'bash',
        isError,
        content: [{ type: 'text', text }],
      },
    ],
  };
}

describe('tree tool detail (issue #345; §18, §49.1)', () => {
  it('renders a running bash call with its command, truncated to width', () => {
    const state = createTreeState();
    applyLaneEvent(state, { type: 'run-start' });
    applyLaneEvent(state, {
      type: 'tool-start',
      toolCallId: 'c1',
      toolName: 'bash',
      args: { command: 'pnpm test auth' },
    });
    expect(renderTreeLines(state, 100)).toEqual([
      '● solo',
      '  ● bash pnpm test auth',
    ]);
    const narrow = renderTreeLines(state, 20)[1] ?? '';
    expect(visibleWidth(narrow)).toBe(20);
    expect(narrow).toContain('bash pnpm');
  });

  it('shows the path for read/edit args, and no shell outcome for them', () => {
    const state = createTreeState();
    applyLaneEvent(state, { type: 'run-start' });
    applyLaneEvent(
      state,
      {
        type: 'tool-start',
        toolCallId: 'c1',
        toolName: 'read',
        args: { path: 'src/tree.ts' },
      },
      () => 0,
    );
    expect(renderTreeLines(state, 100)[1]).toBe('  ● read src/tree.ts');
    // A read result that happens to look like shell output must not become an
    // outcome: `17 passed` inside a file is not a test report (review #345).
    applyLaneEvent(
      state,
      {
        type: 'tool-end',
        toolCallId: 'c1',
        toolName: 'read',
        isError: false,
        entry: toolResult('[bash exit 1 (bash)]\n17 passed'),
      },
      () => 12,
    );
    expect(renderTreeLines(state, 100)[1]).toBe('  ✓ read src/tree.ts 12ms');
  });

  it('shows a non-zero exit code on a finished bash call', () => {
    const state = createTreeState();
    applyLaneEvent(state, { type: 'run-start' });
    applyLaneEvent(
      state,
      {
        type: 'tool-start',
        toolCallId: 'c1',
        toolName: 'bash',
        args: { command: 'pnpm test auth' },
      },
      () => 0,
    );
    applyLaneEvent(
      state,
      {
        type: 'tool-end',
        toolCallId: 'c1',
        toolName: 'bash',
        isError: true,
        entry: toolResult('[bash exit 1 (bash)]\n--- stdout ---\nboom'),
      },
      () => 12,
    );
    expect(renderTreeLines(state, 100)[1]).toBe(
      '  ✗ bash pnpm test auth 12ms · exit 1',
    );
  });

  it('shows a detected test summary as the outcome', () => {
    const state = createTreeState();
    applyLaneEvent(state, { type: 'run-start' });
    applyLaneEvent(
      state,
      {
        type: 'tool-start',
        toolCallId: 'c1',
        toolName: 'bash',
        args: { command: 'pnpm test auth' },
      },
      () => 0,
    );
    applyLaneEvent(
      state,
      {
        type: 'tool-end',
        toolCallId: 'c1',
        toolName: 'bash',
        isError: false,
        entry: toolResult(
          '[bash exit 0 (bash)]\n--- stdout ---\nTests  17 passed (17)',
        ),
      },
      () => 142,
    );
    expect(renderTreeLines(state, 100)[1]).toBe(
      '  ✓ bash pnpm test auth 142ms · 17 passed',
    );
  });

  it('marks a failed call ✗ and never ✓', () => {
    const state = createTreeState();
    applyLaneEvent(state, { type: 'run-start' });
    applyLaneEvent(state, {
      type: 'tool-end',
      toolCallId: 'c9',
      toolName: 'bash',
      isError: true,
    });
    const lines = renderTreeLines(state, 100);
    expect(lines[1]).toBe('  ✗ bash');
    expect(lines.join('\n')).not.toContain('✓');
  });

  it('shows $cost and in/out tokens on the root row after usage', () => {
    const state = createTreeState();
    applyLaneEvent(state, { type: 'run-start' });
    expect(renderTreeLines(state, 100)[0]).toBe('● solo');
    applyLaneEvent(state, usageEvent(1200, 300, 0));
    expect(renderTreeLines(state, 100)[0]).toBe('● solo $0.00 1.2k/0.3k');
    applyLaneEvent(state, usageEvent(800, 700, 0.02));
    expect(renderTreeLines(state, 100)[0]).toBe('● solo $0.02 2.0k/1.0k');
  });

  it('leaves the root row alone for a malformed usage row', () => {
    const state = createTreeState();
    applyLaneEvent(state, { type: 'usage', row: { usage: {} }, entry: {} });
    applyLaneEvent(state, { type: 'usage', row: 'nope', entry: {} });
    expect(renderTreeLines(state, 100)[0]).toBe('◌ solo');
  });

  it('seeds the root row from the attach snapshot usage ledger', () => {
    const state = createTreeState();
    applyLaneEvent(state, {
      type: 'snapshot',
      entries: [],
      tools: [],
      usage: {
        models: {
          'faux/one': {
            input: 1000,
            output: 200,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 1200,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0.02,
            },
          },
        },
        tools: {
          bash: {
            input: 500,
            output: 100,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 600,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0.01,
            },
          },
        },
      },
    });
    expect(renderTreeLines(state, 100)[0]).toBe('◌ solo $0.03 1.5k/0.3k');
    // REPLACE semantics: a later snapshot sets the totals, it never adds.
    applyLaneEvent(state, {
      type: 'snapshot',
      entries: [],
      tools: [],
      usage: {
        models: {
          'faux/one': {
            input: 100,
            output: 50,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 150,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0.05,
            },
          },
        },
      },
    });
    expect(renderTreeLines(state, 100)[0]).toBe('◌ solo $0.05 0.1k/50');
  });

  it('ignores a malformed snapshot usage ledger', () => {
    const state = createTreeState();
    applyLaneEvent(state, { type: 'snapshot', usage: { models: { a: null } } });
    expect(renderTreeLines(state, 100)[0]).toBe('◌ solo');
  });

  it('starts a new group on the second run-start', () => {
    const state = createTreeState();
    applyLaneEvent(state, { type: 'run-start' });
    applyLaneEvent(state, startTool('c1', 'bash'), () => 0);
    applyLaneEvent(
      state,
      {
        type: 'tool-end',
        toolCallId: 'c1',
        toolName: 'bash',
        isError: false,
      },
      () => 142,
    );
    applyLaneEvent(state, { type: 'run-start' });
    applyLaneEvent(state, startTool('c2', 'read'));
    expect(state.tools.map((tool) => tool.id)).toEqual(['c2']);
    // Completed turns are kept as rollups, never as calls: the state stays
    // bounded by the turn count, not the session's tool count.
    expect(state.previousTurns).toEqual([{ calls: 1, durationMs: 142 }]);
    expect(renderTreeLines(state, 100)).toEqual([
      '● solo',
      '  … 1 earlier call in 1 turn',
      '  ● read',
    ]);
  });

  it('folds every turn into the collapsed summary', () => {
    const state = createTreeState();
    applyLaneEvent(state, { type: 'run-start' });
    applyLaneEvent(state, startTool('c1', 'bash'), () => 0);
    applyLaneEvent(
      state,
      {
        type: 'tool-end',
        toolCallId: 'c1',
        toolName: 'bash',
        isError: false,
      },
      () => 40,
    );
    applyLaneEvent(state, { type: 'run-start' });
    applyLaneEvent(state, startTool('c2', 'read'), () => 0);
    toggleTree(state);
    expect(renderTreeLines(state, 100)[1]).toBe('  …2 calls, 40ms');
  });

  it('truncates CJK args to exactly the column width', () => {
    const state = createTreeState();
    applyLaneEvent(state, { type: 'run-start' });
    applyLaneEvent(state, {
      type: 'tool-start',
      toolCallId: 'c1',
      toolName: 'bash',
      args: { command: '测试命令测试命令测试命令测试命令' },
    });
    for (const width of [40, 17, 10]) {
      const line = renderTreeLines(state, width)[1] ?? '';
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    // A cut that lands on a glyph boundary fills the row exactly: the old
    // String.length math counted a CJK glyph as one column and overflowed.
    const exact = renderTreeLines(state, 14)[1] ?? '';
    expect(visibleWidth(exact)).toBe(14);
    expect(exact).toContain('…');
  });

  it('never lets control characters in args reach the lines', () => {
    const state = createTreeState();
    applyLaneEvent(state, { type: 'run-start' });
    applyLaneEvent(state, {
      type: 'tool-start',
      toolCallId: 'c1',
      toolName: 'bash',
      args: { command: `echo ${ESC}[2J${ESC}[31mboom` },
    });
    const rendered = renderTreeLines(state, 100).join('\n');
    expect(rendered).toContain('echo boom');
    expect(rendered).not.toContain(`${ESC}[2J`);
    expect(rendered).not.toContain(`${ESC}[31m`);
    expect(rendered).not.toContain('[2J');
    expect(rendered).not.toContain('[31m');
    // A carriage return is an OVERWRITE, not a separator (issue #299): the
    // terminal shows what came after it, and so does the tree.
    applyLaneEvent(state, {
      type: 'tool-start',
      toolCallId: 'c2',
      toolName: 'bash',
      args: { command: 'progress 10%\rprogress 100%' },
    });
    const withReturn = renderTreeLines(state, 100).join('\n');
    expect(withReturn).toContain('progress 100%');
    expect(withReturn).not.toContain('10%');
    expect(withReturn).not.toContain('\r');
  });
});

describe('tree mutation hardening (issue #68)', () => {
  it('ignores non-toggle keys without toggling or refocusing', () => {
    const state = createTreeState();
    let editorFocus = 0;
    const view = new AgentTreeView(state, {
      onFocusEditor: () => editorFocus++,
    });
    view.handleInput('x');
    expect(view.isCollapsed()).toBe(false);
    expect(editorFocus).toBe(0);
    view.handleInput('t');
    expect(view.isCollapsed()).toBe(true);
    view.handleInput('q');
    expect(view.isCollapsed()).toBe(true);
    expect(editorFocus).toBe(1);
  });

  it('keeps an exact-width line untruncated (no ellipsis at length === width)', () => {
    const state = createTreeState();
    // '◌ solo' is exactly 6 visible columns.
    expect(renderTreeLines(state, 6)).toEqual(['◌ solo']);
    expect(renderTreeLines(state, 6)[0]).not.toContain('…');
  });

  it('honors constructor label/collapsed options and the injected clock', () => {
    const state = createTreeState();
    applyLaneEvent(state, {
      type: 'run-start',
      lane: 's',
      runId: 'r',
      startedAt: 0,
    });
    applyLaneEvent(state, startTool('c1', 'bash'), () => 1000);
    const view = new AgentTreeView(state, {
      collapsed: true,
      clock: () => 1500,
    });
    expect(view.isCollapsed()).toBe(true);
    view.update({
      type: 'tool-end',
      lane: 's',
      runId: 'r',
      turnId: 't',
      toolCallId: 'c1',
      toolName: 'bash',
      isError: false,
      terminate: false,
    });
    // One tool: singular 'call' via the injected clock (1500 - 1000).
    expect(view.render(100)).toEqual(['● solo', '  …1 call, 500ms']);
    expect(view.getState().tools[0]?.durationMs).toBe(500);
    // The label option names the root when the view builds its own state.
    expect(
      new AgentTreeView(undefined, { label: 'lane-7' }).render(100),
    ).toEqual(['◌ lane-7']);
  });

  it('restarts a retooled call instead of duplicating it', () => {
    const state = createTreeState();
    applyLaneEvent(state, startTool('c1', 'bash'), () => 0);
    applyLaneEvent(state, startTool('c1', 'bash'), () => 50);
    expect(state.tools.length).toBe(1);
    expect(state.tools[0]?.done).toBe(false);
    expect(renderTreeLines(state, 100)).toEqual(['◌ solo', '  ● bash']);
  });
});
