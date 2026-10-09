// Follow-end transcript fed by LaneSnapshot coarse cells.
//
// No VirtualTerminal exists in Pi 0.85.1: headless snapshots render the
// ScrollView root directly (Component.render is pure) and assert document
// text plus follow/pinned offsets across batches.

import { afterEach, describe, expect, it } from 'vitest';
import { fakeTerminal } from '../../../test/fake-terminal.js';
import { buildLayoutRoot } from './layout.js';
import { bootScreen } from './screen.js';
import { createTuiTheme, setTuiTheme } from './theme.js';
import { createTranscriptView } from './transcript.js';
import { TOOL_OUTPUT_PREVIEW_LINES } from './transcript-entry.js';
import { QUEUED_LABEL } from './transcript-text.js';
import { Text, visibleWidth } from './tui-boundary.js';

afterEach(() => {
  setTuiTheme(createTuiTheme('none'));
});

describe('transcript view', () => {
  it('appends a text delta and shows it in a headless snapshot', () => {
    const view = createTranscriptView();
    view.appendDelta({ id: 'e1', kind: 'text', append: 'hello world' });
    expect(view.render(80).join('\n')).toContain('hello world');
  });

  it('renders 200 deltas incrementally, one markdown rebuild per entry', () => {
    const view = createTranscriptView();
    for (let i = 0; i < 100; i++) {
      view.appendDelta({ id: `e${i}`, kind: 'text', append: `line ${i}` });
    }
    const half = view.render(80).length;
    for (let i = 100; i < 200; i++) {
      view.appendDelta({ id: `e${i}`, kind: 'text', append: `line ${i}` });
    }
    // One rebuild per entry, never a full clear: rows grow monotonically.
    expect(view.rebuilds).toBe(200);
    expect(view.render(80).length).toBeGreaterThan(half);
    const doc = view.render(80).join('\n');
    expect(doc).toContain('line 0');
    expect(doc).toContain('line 199');
  });

  it('follows the tail when pinned, holds on scroll-up, re-pins on End', () => {
    const view = createTranscriptView();
    for (let i = 0; i < 10; i++) {
      view.appendDelta({ id: `e${i}`, kind: 'text', append: `line ${i}` });
    }
    view.updateLayout(view.render(80).length, 5);
    expect(view.isPinned).toBe(true);
    const tail = view.scrollTop;
    for (let i = 10; i < 20; i++) {
      view.appendDelta({ id: `e${i}`, kind: 'text', append: `line ${i}` });
    }
    view.updateLayout(view.render(80).length, 5);
    expect(view.scrollTop).toBeGreaterThan(tail);
    view.scrollUp(100);
    expect(view.isPinned).toBe(false);
    const held = view.scrollTop;
    for (let i = 20; i < 70; i++) {
      view.appendDelta({ id: `e${i}`, kind: 'text', append: `line ${i}` });
    }
    view.updateLayout(view.render(80).length, 5);
    expect(view.scrollTop).toBe(held);
    view.rePin();
    expect(view.isPinned).toBe(true);
    expect(view.scrollTop).toBeGreaterThan(held);
  });

  it('streams chunks into one entry with one rebuild per chunk', () => {
    const view = createTranscriptView();
    view.appendDelta({ id: 's', kind: 'text', append: 'hel' });
    view.appendDelta({ id: 's', kind: 'text', append: 'lo' });
    expect(view.render(80).join('\n')).toContain('hello');
    expect(view.rebuilds).toBe(2);
  });

  it('subscribes LaneSnapshot coarse cells interleaved and visible in one frame', () => {
    const view = createTranscriptView();
    const before = view.rebuilds;
    view.applyLaneSnapshot(
      { laneId: 'lane-1' },
      [
        { id: 't1', kind: 'text', markdown: 'hello' },
        { id: 'tool-1', kind: 'tool', markdown: 'read foo.ts' },
        { id: 'o1', kind: 'output', markdown: '42 lines' },
      ],
      1,
    );
    // Snapshot→visible synchronously: exactly one rebuild, no extra frame.
    expect(view.rebuilds).toBe(before + 1);
    const doc = view.render(80).join('\n');
    const order = ['hello', 'read foo.ts', '42 lines'].map((m) =>
      doc.indexOf(m),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('scrolls with the mouse wheel and re-pins at the end', () => {
    // Driven through a real alt-screen and SGR wheel input, not by reading
    // the ScrollView's constructor options back: the wheel over the
    // transcript moves it one line per event and leaves follow-end, and
    // wheeling back down to the bottom resumes following.
    const view = createTranscriptView();
    view.applyLaneSnapshot(
      { laneId: 'lane-1' },
      Array.from({ length: 60 }, (_, i) => ({
        id: `t${i}`,
        kind: 'text' as const,
        markdown: `line ${i}`,
      })),
      1,
    );
    const terminal = fakeTerminal(80, 24);
    const screen = bootScreen(
      terminal,
      buildLayoutRoot({
        tree: new Text('tree', 0, 0),
        transcript: view.component,
        status: new Text('status', 0, 0),
        editor: new Text('editor', 0, 0),
      }),
    );
    try {
      screen.render();
      const lines = (): string[] => screen.tui.getScreenLines();
      expect(lines().join('\n')).toContain('line 59');
      expect(view.isPinned).toBe(true);
      const row = lines().findIndex((line) => line.includes('line 59')) + 1;
      const wheel = (button: 64 | 65): void =>
        terminal.inject(`\u001b[<${button};5;${row}M`);
      const bottom = view.scrollTop;
      for (let i = 0; i < 3; i += 1) wheel(64);
      screen.render();
      expect(view.isPinned).toBe(false);
      expect(view.scrollTop).toBe(bottom - 3);
      expect(lines().join('\n')).not.toContain('line 59');
      for (let i = 0; i < 3; i += 1) wheel(65);
      screen.render();
      expect(view.scrollTop).toBe(bottom);
      expect(view.isPinned).toBe(true);
      expect(lines().join('\n')).toContain('line 59');
    } finally {
      screen.stop(() => {});
    }
  });

  it('ignores stale resnapshots so a re-watch replays gap-free', () => {
    const view = createTranscriptView();
    view.applyLaneSnapshot(
      { laneId: 'lane-1' },
      [{ id: 't1', kind: 'text', markdown: 'hello' }],
      2,
    );
    const rebuilds = view.rebuilds;
    const doc = view.render(80).join('\n');
    view.applyLaneSnapshot(
      { laneId: 'lane-1' },
      [{ id: 't1', kind: 'text', markdown: 'stale' }],
      1,
    );
    expect(view.rebuilds).toBe(rebuilds);
    expect(view.render(80).join('\n')).toBe(doc);
  });

  it('streams three scripted batches to the final text with pinned offsets', () => {
    const view = createTranscriptView();
    const batches: Array<Array<{ id: string; text: string }>> = [
      [{ id: 'b0', text: 'batch zero' }],
      [{ id: 'b1', text: 'batch one' }],
      [{ id: 'b2', text: 'batch two' }],
    ];
    const tails: Array<number> = [];
    for (const batch of batches) {
      for (const entry of batch) {
        view.appendDelta({ id: entry.id, kind: 'text', append: entry.text });
      }
      view.updateLayout(view.render(80).length, 5);
      tails.push(view.scrollTop);
    }
    const doc = view.render(80).join('\n');
    expect(doc).toContain('batch zero');
    expect(doc).toContain('batch one');
    expect(doc).toContain('batch two');
    expect(view.isPinned).toBe(true);
    expect([...tails].sort((a, b) => a - b)).toEqual(tails);
  });
});

describe('transcript snapshot guards', () => {
  it('ignores a same-revision resnapshot on the same lane', () => {
    const view = createTranscriptView();
    view.applyLaneSnapshot(
      { laneId: 'lane-1' },
      [{ id: 't1', kind: 'text', markdown: 'hello' }],
      2,
    );
    const rebuilds = view.rebuilds;
    const doc = view.render(80).join('\n');
    view.applyLaneSnapshot(
      { laneId: 'lane-1' },
      [{ id: 't1', kind: 'text', markdown: 'same-rev replacement' }],
      2,
    );
    expect(view.rebuilds).toBe(rebuilds);
    expect(view.render(80).join('\n')).toBe(doc);
  });

  it('applies a lane switch even at an older revision', () => {
    const view = createTranscriptView();
    view.applyLaneSnapshot(
      { laneId: 'lane-1' },
      [{ id: 't1', kind: 'text', markdown: 'lane one text' }],
      5,
    );
    view.applyLaneSnapshot(
      { laneId: 'lane-2' },
      [{ id: 't2', kind: 'text', markdown: 'lane two text' }],
      1,
    );
    const doc = view.render(80).join('\n');
    expect(doc).toContain('lane two text');
    expect(doc).not.toContain('lane one text');
  });

  it('a snapshot replaces deltas that arrived before it', () => {
    const view = createTranscriptView();
    view.appendDelta({ id: 'old', kind: 'text', append: 'stale delta' });
    expect(view.render(80).join('\n')).toContain('stale delta');
    const rebuilds = view.rebuilds;
    view.applyLaneSnapshot(
      { laneId: 'lane-1' },
      [{ id: 'fresh', kind: 'text', markdown: 'snapshot text' }],
      1,
    );
    expect(view.rebuilds).toBe(rebuilds + 1);
    const doc = view.render(80).join('\n');
    expect(doc).toContain('snapshot text');
    expect(doc).not.toContain('stale delta');
  });
});

describe('queued follow-ups', () => {
  it('renders each queued prompt under the transcript, first line only', () => {
    const view = createTranscriptView();
    view.appendDelta({ id: 'a1', kind: 'text', append: 'assistant spoke' });
    view.setQueuedPrompts(['fix the flaky test\nand the docs', 'second']);
    const rows = view.render(80);
    const doc = rows.join('\n');
    expect(doc).toContain(`${QUEUED_LABEL} fix the flaky test`);
    expect(doc).toContain(`${QUEUED_LABEL} second`);
    // A multi-line draft is summarised: the committed entry shows it whole.
    expect(doc).not.toContain('and the docs');
    expect(rows.findIndex((row) => row.includes(QUEUED_LABEL))).toBeGreaterThan(
      rows.findIndex((row) => row.includes('assistant spoke')),
    );
  });

  it('sanitizes a queued draft at ingress', () => {
    const view = createTranscriptView();
    // A paste can carry ESC-prefixed sequences and C0 controls; a tab also
    // breaks the width math. The row is content, so it is stripped like the
    // pending echo.
    view.setQueuedPrompts(['\u001b[2Jclear\u0007\tend']);
    const row = view.render(80).find((line) => line.includes('queued:')) ?? '';
    // The WHOLE sequence is gone (stripping only the ESC byte
    // left `[2J` as visible parameter noise), and the BEL with it.
    expect(row).toContain('queued: clear');
    expect(row).not.toContain('\u001b');
    expect(row).not.toContain('\u0007');
    // The tab is expanded to a column stop, not passed through.
    expect(row).not.toContain('\t');
    expect(row).toMatch(/clear +end/);
  });

  it('renders the queued rows dim', () => {
    setTuiTheme(createTuiTheme('truecolor'));
    const view = createTranscriptView();
    view.setQueuedPrompts(['later']);
    const row = view.render(80).find((line) => line.includes('later')) ?? '';
    // SGR 2 is the dim style the operator-facing contract names.
    expect(row).toContain('\u001b[2m');
  });

  it('replaces the rows on every call: the inbox list is a snapshot', () => {
    const view = createTranscriptView();
    view.setQueuedPrompts(['first', 'second']);
    expect(view.render(80).join('\n')).toContain('queued: second');
    view.setQueuedPrompts([]);
    expect(view.render(80).join('\n')).not.toContain(QUEUED_LABEL);
  });
});

describe('expanded tool output wraps instead of clipping', () => {
  function outputView(
    text: string,
    detail?: string,
  ): ReturnType<typeof createTranscriptView> {
    const view = createTranscriptView();
    view.applyLaneSnapshot(
      { laneId: 'lane-1' },
      [
        {
          id: 'tool-1',
          kind: 'tool',
          markdown: 'tool bash',
          toolCallId: 'c1',
          ...(detail === undefined ? {} : { detail }),
        },
        { id: 'o1', kind: 'output', markdown: text, toolCallId: 'c1' },
      ],
      1,
    );
    return view;
  }

  it('renders a 300-char output line in full when expanded', () => {
    const text = `E${'x'.repeat(298)}Z`;
    const view = outputView(text);
    view.toggleExpanded();
    const lines = view.render(80);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    }
    const doc = lines.join('\n');
    // Every character survives the wrap: the first and last of the line are
    // there, and no `…` cut the tail.
    expect(doc.split('x').length - 1).toBe(298);
    expect(doc).toContain('E');
    expect(doc).toContain('Z');
    expect(doc).not.toContain('…');
    // Continuation rows stay behind the card's gutter (`  │ `).
    expect(
      lines.filter((line) => line.startsWith('  │ ')).length,
    ).toBeGreaterThan(1);
  });

  it('keeps the collapsed preview inside its row budget and says when clipped', () => {
    const text = Array.from(
      { length: 20 },
      (_, i) => `line ${i} ${'y'.repeat(200)}`,
    ).join('\n');
    const view = outputView(text);
    const lines = view.render(80);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    }
    // The preview shows at most TOOL_OUTPUT_PREVIEW_LINES output rows plus
    // its hint row.
    const previewRows = lines.filter((line) => line.startsWith('  │ '));
    expect(previewRows.length).toBeLessThanOrEqual(
      TOOL_OUTPUT_PREVIEW_LINES + 1,
    );
    // The collapsed rows are clipped, and the hint says so instead of
    // pretending the text is complete.
    expect(lines.join('\n')).toContain('wide lines cut');
  });

  it('wraps the tool-call detail line when expanded', () => {
    const detail = `path/${'d'.repeat(200)}.ts`;
    const view = outputView('ok', detail);
    view.toggleExpanded();
    const lines = view.render(80);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    }
    expect(lines.join('\n').split('d').length - 1).toBe(200);
  });
});

describe('steady-state markdown caching', () => {
  it('parses each cell at most once across identical frames', () => {
    const view = createTranscriptView();
    view.applyLaneSnapshot(
      { laneId: 'l' },
      [
        { id: 'a1', kind: 'text', markdown: 'first answer' },
        { id: 'a2', kind: 'text', markdown: 'second **answer**' },
      ],
      1,
    );
    view.render(80);
    const parses = view.markdownParses();
    expect(parses).toBeLessThanOrEqual(2);
    view.render(80);
    view.render(80);
    // pi-tui's setText invalidates unconditionally: a steady frame must not
    // touch it, or every assistant cell re-parses every 100 ms spinner tick.
    expect(view.markdownParses()).toBe(parses);
  });

  it('re-parses only the cell whose text changed', () => {
    const view = createTranscriptView();
    view.applyLaneSnapshot(
      { laneId: 'l' },
      [
        { id: 'a1', kind: 'text', markdown: 'one' },
        { id: 'a2', kind: 'text', markdown: 'two' },
      ],
      1,
    );
    view.render(80);
    const parses = view.markdownParses();
    view.applyLaneSnapshot(
      { laneId: 'l' },
      [
        { id: 'a1', kind: 'text', markdown: 'one changed' },
        { id: 'a2', kind: 'text', markdown: 'two' },
      ],
      2,
    );
    view.render(80);
    expect(view.markdownParses()).toBe(parses + 1);
  });

  it('prunes the markdown cache when a snapshot drops cells', () => {
    const view = createTranscriptView();
    view.applyLaneSnapshot(
      { laneId: 'l' },
      [
        { id: 'a1', kind: 'text', markdown: 'one' },
        { id: 'a2', kind: 'text', markdown: 'two' },
        { id: 't1', kind: 'tool', markdown: 'tool read', toolCallId: 'c1' },
        { id: 'o1', kind: 'output', markdown: 'out', toolCallId: 'c1' },
      ],
      1,
    );
    view.render(80);
    expect(view.markdownCacheSize()).toBe(2);
    view.applyLaneSnapshot(
      { laneId: 'l' },
      [{ id: 'a2', kind: 'text', markdown: 'two' }],
      2,
    );
    view.render(80);
    expect(view.markdownCacheSize()).toBe(1);
  });

  it('renders a 400-turn steady-state frame under 10 ms', () => {
    const view = createTranscriptView();
    const cells: Array<{
      id: string;
      kind: 'prompt' | 'text';
      markdown: string;
    }> = [];
    // ~15 rows per turn, the shape a long session produces (its
    // document is thousands of rows, and a steady frame rebuilds none of them).
    const body = Array.from(
      { length: 10 },
      (_, i) => `- point ${i} with **bold** and \`code\``,
    ).join('\n');
    for (let i = 0; i < 400; i += 1) {
      cells.push({
        id: `p${i}`,
        kind: 'prompt',
        markdown: `\u203a prompt ${i}`,
      });
      cells.push({
        id: `a${i}`,
        kind: 'text',
        markdown: `answer ${i}\n\n${body}`,
      });
    }
    view.applyLaneSnapshot({ laneId: 'l' }, cells, 1);
    view.render(120); // first render parses every cell
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 5; i += 1) {
      const started = performance.now();
      view.render(120);
      best = Math.min(best, performance.now() - started);
    }
    // Best of five: the machine is shared with other agents, and the point is
    // the steady-state cost, not one scheduler hiccup.
    expect(best).toBeLessThan(10);
  });
});
