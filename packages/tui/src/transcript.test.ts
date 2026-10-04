// Slice A: follow-end transcript fed by LaneSnapshot coarse cells (§16.1, §80).
//
// No VirtualTerminal exists in Pi 0.85.1: headless snapshots render the
// ScrollView root directly (Component.render is pure) and assert document
// text plus follow/pinned offsets across batches.
import { afterEach, describe, expect, it } from 'vitest';
import { createTuiTheme, setTuiTheme } from './theme.js';
import {
  createTranscriptView,
  QUEUED_LABEL,
  replayTranscript,
  TOOL_OUTPUT_PREVIEW_LINES,
} from './transcript.js';
import { visibleWidth } from './tui-boundary.js';

afterEach(() => {
  setTuiTheme(createTuiTheme('none'));
});

describe('transcript view (issue #23, slice A)', () => {
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

  it('keeps wheel/drag defaults: nearest ScrollView, chained deltas', () => {
    const view = createTranscriptView();
    expect(view.scroll.followEnd).toBe(true);
    expect(view.scroll.primary).toBe(true);
    expect(view.scroll.overscroll).toBe('chain');
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

  it('replays the write log to an identical final document', () => {
    const view = createTranscriptView({ ops: true });
    view.appendDelta({ id: 'a', kind: 'text', append: 'alpha ' });
    view.appendDelta({ id: 'a', kind: 'text', append: 'one' });
    view.appendDelta({ id: 'b', kind: 'tool', append: 'run tests' });
    view.applyLaneSnapshot(
      { laneId: 'lane-1' },
      [
        { id: 'a', kind: 'text', markdown: 'alpha one' },
        { id: 'b', kind: 'tool', markdown: 'run tests' },
        { id: 'c', kind: 'output', markdown: 'ok' },
      ],
      3,
    );
    view.appendDelta({ id: 'c', kind: 'output', append: '!' });
    const replayed = replayTranscript(view.writeLog);
    // Non-vacuous: the live document really holds the snapshot plus the
    // post-snapshot delta, so an empty replay cannot match it.
    const doc = view.render(80).join('\n');
    expect(doc).toContain('alpha one');
    expect(doc).toContain('run tests');
    expect(doc).toContain('ok!');
    expect(replayed.render(80)).toEqual(view.render(80));
  });
});

describe('transcript snapshot guards (issue #68; mutation hardening)', () => {
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

describe('queued follow-ups (issue #334)', () => {
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

  it('sanitizes a queued draft at ingress (#334 review)', () => {
    const view = createTranscriptView();
    // A paste can carry ESC-prefixed sequences and C0 controls; a tab also
    // breaks the width math. The row is content, so it is stripped like the
    // pending echo.
    view.setQueuedPrompts(['\u001b[2Jclear\u0007\tend']);
    const row = view.render(80).find((line) => line.includes('queued:')) ?? '';
    // Issue #299: the WHOLE sequence is gone (stripping only the ESC byte
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

describe('expanded tool output wraps instead of clipping (issue #300)', () => {
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
    // Hanging indent: continuation rows align under the block's 5-column
    // lead (`  ⎿  `).
    expect(lines.some((line) => line.startsWith('     '))).toBe(true);
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
    const previewRows = lines.filter((line) => /^\s*(⎿| {5})/.test(line));
    expect(previewRows.length).toBeLessThanOrEqual(
      TOOL_OUTPUT_PREVIEW_LINES + 1,
    );
    // The collapsed rows are clipped, and the hint says so instead of
    // pretending the text is complete.
    expect(lines.join('\n')).toContain('clipped');
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
describe('steady-state markdown caching (issue #298)', () => {
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
    // ~15 rows per turn, the shape the audit measured (a long session's
    // document is thousands of rows, and every one used to be rebuilt).
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
describe('transcript op log and snapshot reuse (issue #297)', () => {
  const cells = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `c${i}`,
      kind: 'text' as const,
      markdown: `cell ${i}`,
    }));

  it('keeps no op log in production mode, and logs only when asked', () => {
    const view = createTranscriptView();
    const hundred = cells(100);
    for (let i = 0; i < 1000; i += 1) {
      view.applyLaneSnapshot({ laneId: 'l' }, hundred, i + 1);
    }
    // The TUI applies a snapshot on every lane event: a log holding a deep
    // copy of each one retains O(N·E) cells for no production reader.
    expect(view.writeLog).toHaveLength(0);
    // Replay and tests opt in explicitly.
    const logged = createTranscriptView({ ops: true });
    logged.applyLaneSnapshot({ laneId: 'l' }, hundred, 1);
    logged.appendDelta({ id: 'c0', kind: 'text', append: '!' });
    expect(logged.writeLog).toHaveLength(2);
  });

  it('reuses the unchanged cells of a re-applied snapshot', () => {
    const view = createTranscriptView();
    const first = [
      { id: 'a', kind: 'text' as const, markdown: 'one' },
      {
        id: 'b',
        kind: 'tool' as const,
        markdown: 'tool read',
        detail: 'x.ts',
        toolCallId: 'c1',
      },
    ];
    view.applyLaneSnapshot({ laneId: 'l' }, first, 1);
    const before = view.liveCells();
    view.applyLaneSnapshot({ laneId: 'l' }, first, 2);
    const same = view.liveCells();
    expect(same).toHaveLength(2);
    // Identity, not equality: the second apply allocates nothing for cells
    // whose content did not change.
    expect(same[0]).toBe(before[0]);
    expect(same[1]).toBe(before[1]);
    view.applyLaneSnapshot(
      { laneId: 'l' },
      [{ ...first[0], markdown: 'one changed' }, first[1]],
      3,
    );
    const changed = view.liveCells();
    expect(changed[0]).not.toBe(before[0]);
    expect(changed[0]?.markdown).toBe('one changed');
    expect(changed[1]).toBe(before[1]);
  });
});

describe('compaction cells (issue #317)', () => {
  const SUMMARY_LINES = Array.from(
    { length: 12 },
    (_, i) => `summary line ${i}`,
  ).join('\n');

  function view(): ReturnType<typeof createTranscriptView> {
    const created = createTranscriptView();
    created.applyLaneSnapshot(
      { laneId: 'l' },
      [
        {
          id: 'c1:compaction',
          kind: 'compaction',
          markdown: SUMMARY_LINES,
          detail: 'auto',
        },
      ],
      1,
    );
    return created;
  }

  it('shows a compaction marker cell and its summary, collapsed', () => {
    const doc = view().render(100).join('\n');
    expect(doc).toContain('context compacted (auto)');
    expect(doc).toContain('summary line 0');
    // Collapsed: the first rows plus the Ctrl-X hint, like tool output.
    expect(doc).not.toContain('summary line 11');
    expect(doc).toContain('(ctrl+x to expand)');
  });

  it('expands the whole summary with Ctrl-X', () => {
    const created = view();
    created.toggleExpanded();
    const doc = created.render(100).join('\n');
    expect(doc).toContain('summary line 0');
    expect(doc).toContain('summary line 11');
    expect(doc).not.toContain('(ctrl+x to expand)');
  });

  it('keeps every row inside the width', () => {
    const created = view();
    for (const width of [40, 20]) {
      for (const line of created.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});
