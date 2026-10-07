// AgentTreeView one-node + ToolOutput collapsing.
// Solo-only: root + tool children, glyphs ✓/●/◌, keyboard+click toggle,
// truncation. Headless snapshots render directly (no VirtualTerminal in
// Pi 0.85.1) like layout.test.ts.
import { describe, expect, it } from 'vitest';
import {
  AgentTreeView,
  applyTreeSnapshot,
  collapsedSummary,
  createTreeState,
  renderTreeLines,
  rootGlyph,
  type TreeLaneSnapshot,
  type TreeToolSnapshot,
  toggleTree,
  toolGlyph,
} from './tree.js';
import { visibleWidth } from './tui-boundary.js';

const ESC = String.fromCharCode(27);

// The production lane input: the host projector folds the events
// and hands the tree the lane's own state — these are the shapes it passes.
function tool(
  id: string,
  name: string,
  extra: Partial<TreeToolSnapshot> = {},
): TreeToolSnapshot {
  return {
    toolCallId: id,
    toolName: name,
    status: 'running',
    isError: false,
    ...extra,
  };
}

function lane(
  status: TreeLaneSnapshot['status'],
  tools: ReadonlyArray<TreeToolSnapshot>,
  usage?: { costTotal: number; inputTokens: number; outputTokens: number },
): TreeLaneSnapshot {
  return { status, tools, ...(usage === undefined ? {} : { usage }) };
}

describe('tree glyphs', () => {
  it('maps root status to ◌/●/✓', () => {
    expect(rootGlyph('idle')).toBe('◌');
    expect(rootGlyph('running')).toBe('●');
    expect(rootGlyph('done')).toBe('✓');
  });

  it('maps tool state to ●/✓', () => {
    expect(toolGlyph('running')).toBe('●');
    expect(toolGlyph('done')).toBe('✓');
  });

  it('maps an errored finish to ✗', () => {
    expect(toolGlyph('done', true)).toBe('✗');
    expect(toolGlyph('running', true)).toBe('●');
  });
});

describe('tree lane feed', () => {
  it('shows ● root with live children on start/finish', () => {
    const state = createTreeState();
    expect(renderTreeLines(state, 100)[0]).toBe('◌ solo');
    applyTreeSnapshot(state, lane('running', [tool('c1', 'bash')]));
    const lines = renderTreeLines(state, 100);
    expect(lines[0]).toBe('● solo');
    expect(lines[1]).toBe('  ● bash');
    applyTreeSnapshot(
      state,
      lane('running', [
        tool('c1', 'bash', { status: 'done', durationMs: 142 }),
      ]),
    );
    expect(renderTreeLines(state, 100)[1]).toBe('  ✓ bash 142ms');
  });

  it('surfaces a tool finish even without a prior running row', () => {
    // The snapshot carries the lane's whole tool list, so a finish the tree
    // never saw start (a late join) still renders.
    const state = createTreeState();
    applyTreeSnapshot(
      state,
      lane('idle', [tool('c9', 'bash', { status: 'done', isError: true })]),
    );
    expect(renderTreeLines(state, 100)).toContain('  ✗ bash');
  });
});

describe('tree collapse', () => {
  it('collapses to a summary vs expanded per-call lines', () => {
    const state = createTreeState();
    applyTreeSnapshot(
      state,
      lane('running', [
        tool('c1', 'bash', { status: 'done', durationMs: 40 }),
        tool('c2', 'bash', { status: 'done', durationMs: 60 }),
        tool('c3', 'bash', { status: 'done', durationMs: 42 }),
      ]),
    );
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

describe('tree toggle input', () => {
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

describe('tree snapshots (headless, no VirtualTerminal)', () => {
  function populated(): AgentTreeView {
    const state = createTreeState();
    applyTreeSnapshot(
      state,
      lane('running', [
        tool('c1', 'bash', { status: 'done', durationMs: 142 }),
        tool('c2', 'bash'),
      ]),
    );
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

describe('tree tool detail', () => {
  it('renders a running bash call with its command, truncated to width', () => {
    const state = createTreeState();
    applyTreeSnapshot(
      state,
      lane('running', [
        tool('c1', 'bash', { args: { command: 'pnpm test auth' } }),
      ]),
    );
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
    applyTreeSnapshot(
      state,
      lane('running', [tool('c1', 'read', { args: { path: 'src/tree.ts' } })]),
    );
    expect(renderTreeLines(state, 100)[1]).toBe('  ● read src/tree.ts');
    // A read result that happens to look like shell output must not become an
    // outcome: `17 passed` inside a file is not a test report.
    applyTreeSnapshot(
      state,
      lane('running', [
        tool('c1', 'read', {
          status: 'done',
          args: { path: 'src/tree.ts' },
          entry: toolResult('[bash exit 1 (bash)]\n17 passed'),
          durationMs: 12,
        }),
      ]),
    );
    expect(renderTreeLines(state, 100)[1]).toBe('  ✓ read src/tree.ts 12ms');
  });

  it('shows a non-zero exit code on a finished bash call', () => {
    const state = createTreeState();
    applyTreeSnapshot(
      state,
      lane('running', [
        tool('c1', 'bash', {
          status: 'done',
          isError: true,
          args: { command: 'pnpm test auth' },
          entry: toolResult('[bash exit 1 (bash)]\n--- stdout ---\nboom'),
          durationMs: 12,
        }),
      ]),
    );
    expect(renderTreeLines(state, 100)[1]).toBe(
      '  ✗ bash pnpm test auth 12ms · exit 1',
    );
  });

  it('shows a detected test summary as the outcome', () => {
    const state = createTreeState();
    applyTreeSnapshot(
      state,
      lane('running', [
        tool('c1', 'bash', {
          status: 'done',
          args: { command: 'pnpm test auth' },
          entry: toolResult(
            '[bash exit 0 (bash)]\n--- stdout ---\nTests  17 passed (17)',
          ),
          durationMs: 142,
        }),
      ]),
    );
    expect(renderTreeLines(state, 100)[1]).toBe(
      '  ✓ bash pnpm test auth 142ms · 17 passed',
    );
  });

  it('marks a failed call ✗ and never ✓', () => {
    const state = createTreeState();
    applyTreeSnapshot(
      state,
      lane('running', [tool('c9', 'bash', { status: 'done', isError: true })]),
    );
    const lines = renderTreeLines(state, 100);
    expect(lines[1]).toBe('  ✗ bash');
    expect(lines.join('\n')).not.toContain('✓');
  });

  it('shows $cost and in/out tokens on the root row after usage', () => {
    // The tree renders the totals the state carries (the projector
    // sums the ledger and the usage rows; the tree never folds a raw row).
    const state = createTreeState();
    applyTreeSnapshot(state, lane('running', []));
    expect(renderTreeLines(state, 100)[0]).toBe('● solo');
    applyTreeSnapshot(
      state,
      lane('running', [], {
        costTotal: 0,
        inputTokens: 1200,
        outputTokens: 300,
      }),
    );
    expect(renderTreeLines(state, 100)[0]).toBe('● solo $0.00 1.2k/0.3k');
    applyTreeSnapshot(
      state,
      lane('running', [], {
        costTotal: 0.02,
        inputTokens: 2000,
        outputTokens: 1000,
      }),
    );
    expect(renderTreeLines(state, 100)[0]).toBe('● solo $0.02 2.0k/1.0k');
  });

  it('starts a new group on the second run-start', () => {
    const state = createTreeState();
    applyTreeSnapshot(
      state,
      lane('running', [
        tool('c1', 'bash', { status: 'done', durationMs: 142 }),
      ]),
    );
    applyTreeSnapshot(
      state,
      lane('done', [tool('c1', 'bash', { status: 'done', durationMs: 142 })]),
    );
    // Turn 2: the run starts again and the projector has cleared the list, so
    // only the new turn's call is live.
    applyTreeSnapshot(state, lane('running', [tool('c2', 'read')]));
    expect(state.tools.map((call) => call.id)).toEqual(['c2']);
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
    applyTreeSnapshot(
      state,
      lane('running', [tool('c1', 'bash', { status: 'done', durationMs: 40 })]),
    );
    applyTreeSnapshot(
      state,
      lane('done', [tool('c1', 'bash', { status: 'done', durationMs: 40 })]),
    );
    applyTreeSnapshot(state, lane('running', [tool('c2', 'read')]));
    toggleTree(state);
    expect(renderTreeLines(state, 100)[1]).toBe('  …2 calls, 40ms');
  });

  it('truncates CJK args to exactly the column width', () => {
    const state = createTreeState();
    applyTreeSnapshot(
      state,
      lane('running', [
        tool('c1', 'bash', {
          args: { command: '测试命令测试命令测试命令测试命令' },
        }),
      ]),
    );
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
    applyTreeSnapshot(
      state,
      lane('running', [
        tool('c1', 'bash', {
          args: { command: `echo ${ESC}[2J${ESC}[31mboom` },
        }),
      ]),
    );
    const rendered = renderTreeLines(state, 100).join('\n');
    expect(rendered).toContain('echo boom');
    expect(rendered).not.toContain(`${ESC}[2J`);
    expect(rendered).not.toContain(`${ESC}[31m`);
    expect(rendered).not.toContain('[2J');
    expect(rendered).not.toContain('[31m');
    // A carriage return is an OVERWRITE, not a separator: the
    // terminal shows what came after it, and so does the tree.
    applyTreeSnapshot(
      state,
      lane('running', [
        tool('c1', 'bash', {
          args: { command: 'echo boom' },
        }),
        tool('c2', 'bash', {
          args: { command: 'progress 10%\rprogress 100%' },
        }),
      ]),
    );
    const withReturn = renderTreeLines(state, 100).join('\n');
    expect(withReturn).toContain('progress 100%');
    expect(withReturn).not.toContain('10%');
    expect(withReturn).not.toContain('\r');
  });
});

describe('tree mutation hardening', () => {
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

  it('honors constructor label/collapsed options and the snapshot durations', () => {
    const state = createTreeState();
    applyTreeSnapshot(
      state,
      lane('running', [
        tool('c1', 'bash', { status: 'done', durationMs: 500 }),
      ]),
    );
    const view = new AgentTreeView(state, { collapsed: true });
    expect(view.isCollapsed()).toBe(true);
    // One tool: singular 'call' — the duration is the projector's measurement,
    // carried in the snapshot.
    expect(view.render(100)).toEqual(['● solo', '  …1 call, 500ms']);
    expect(view.getState().tools[0]?.durationMs).toBe(500);
    // The label option names the root when the view builds its own state.
    expect(
      new AgentTreeView(undefined, { label: 'lane-7' }).render(100),
    ).toEqual(['◌ lane-7']);
  });
});
