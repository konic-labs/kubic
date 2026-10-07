// Follow-end transcript fed by LaneSnapshot coarse cells.
//
// No VirtualTerminal exists in Pi 0.85.1: headless snapshots render the
// ScrollView root directly (Component.render is pure) and assert document
// text plus follow/pinned offsets across batches.
import { afterEach, describe, expect, it } from 'vitest';
import { fakeTerminal } from '../../../test/fake-terminal.js';
import { createUiTheme } from '../../core/src/ui/style.js';
import { DARK_PALETTE } from '../../core/src/ui/tokens.js';
import { buildLayoutRoot } from './layout.js';
import { bootScreen } from './screen.js';
import { createTuiTheme, setTuiTheme } from './theme.js';
import {
  createTranscriptView,
  formatPromptTime,
  QUEUED_LABEL,
  renderReceipt,
  replayTranscript,
  TOOL_OUTPUT_PREVIEW_LINES,
} from './transcript.js';
import {
  resetCapabilitiesCache,
  setCapabilities,
  Text,
  visibleWidth,
} from './tui-boundary.js';

afterEach(() => {
  setTuiTheme(createTuiTheme('none'));
});

const plainUi = createUiTheme(DARK_PALETTE, 'none');

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

describe('transcript snapshot guards (mutation hardening)', () => {
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
describe('transcript op log and snapshot reuse', () => {
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

describe('compaction cells', () => {
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
    // A fg2 rule names it (`── compacted · auto ──`).
    expect(doc).toMatch(/─+ compacted · auto ─+/);
    expect(doc).toContain('summary line 0');
    // Collapsed: the first rows plus the expand hint, like a tool card.
    expect(doc).not.toContain('summary line 11');
    expect(doc).toContain('^X expand');
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

describe('streamed assistant draft', () => {
  it('renders the draft after the committed cells, before the commit', () => {
    const view = createTranscriptView();
    view.applyLaneSnapshot(
      { laneId: 'l' },
      [{ id: 'a0', kind: 'text', markdown: 'committed answer' }],
      1,
    );
    view.setStream('partial');
    const doc = view.render(80);
    const text = doc.join('\n');
    expect(text).toContain('partial');
    expect(doc.findIndex((line) => line.includes('partial'))).toBeGreaterThan(
      doc.findIndex((line) => line.includes('committed answer')),
    );
    // The commit replaces it: the draft is gone, the cell is not doubled.
    view.setStream(undefined);
    view.applyLaneSnapshot(
      { laneId: 'l' },
      [
        { id: 'a0', kind: 'text', markdown: 'committed answer' },
        { id: 'a1', kind: 'text', markdown: 'partial' },
      ],
      2,
    );
    const after = view.render(80).join('\n');
    expect(after).not.toContain('partialpartial');
    expect(after.match(/partial/g)).toHaveLength(1);
  });

  it('sanitizes a streamed delta at ingress', () => {
    const ESC = String.fromCharCode(27);
    const view = createTranscriptView();
    view.setStream(`half${ESC}[2J\rvisible`);
    const doc = view.render(80);
    const text = doc.join('\n');
    expect(text).toContain('visible');
    expect(text).not.toContain(`${ESC}[2J`);
    expect(text).not.toContain('[2J');
    for (const line of doc) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    }
  });

  it('wraps a long draft instead of cutting it', () => {
    const view = createTranscriptView();
    view.setStream('z'.repeat(300));
    const doc = view.render(80);
    expect(doc.join('').split('z').length - 1).toBe(300);
    for (const line of doc) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    }
  });
});

describe('transcript blocks', () => {
  const at = new Date(2026, 9, 6, 14, 1, 52).getTime();

  it('draws the prompt block with its edge and time, prose with its mark', () => {
    const view = createTranscriptView();
    view.applyLaneSnapshot(
      { laneId: 'l' },
      [
        {
          id: 'u',
          kind: 'prompt',
          markdown: '› run npm test and fix the failing test',
          timestamp: at,
        },
        { id: 't', kind: 'text', markdown: "I'll run the test suite first." },
      ],
      1,
    );
    const lines = view.render(80);
    expect(formatPromptTime(at)).toBe('14:01:52');
    const left = ' ▌ run npm test and fix the failing test';
    const right = 'you · 14:01:52 ';
    expect(lines[0]).toBe(
      `${left}${' '.repeat(80 - visibleWidth(left) - visibleWidth(right))}${right}`,
    );
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe("  ◆ I'll run the test suite first.");
  });

  it('wraps a long prompt under the edge and leaves the time off without one', () => {
    const view = createTranscriptView();
    view.applyLaneSnapshot(
      { laneId: 'l' },
      [{ id: 'u', kind: 'prompt', markdown: `› ${'word '.repeat(20)}end` }],
      1,
    );
    const lines = view.render(40);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.startsWith(' ▌ ')).toBe(true);
    expect(lines.join('\n')).not.toContain('you ·');
  });

  it('paints the prompt block on bg2 at colour', () => {
    setTuiTheme(createTuiTheme('truecolor'));
    const view = createTranscriptView();
    view.applyLaneSnapshot(
      { laneId: 'l' },
      [{ id: 'u', kind: 'prompt', markdown: '› hi', timestamp: at }],
      1,
    );
    const line = view.render(60)[0] ?? '';
    expect(visibleWidth(line)).toBe(60);
    expect(line).toContain('\u001b[48;2;');
  });
});

describe('thinking and turn receipts', () => {
  const thought =
    'addItem overwrites qty instead of adding to it. The fix is a +=.';

  it('collapses thinking to its first sentence with the expand key', () => {
    const view = createTranscriptView();
    view.applyLaneSnapshot(
      { laneId: 'l' },
      [{ id: 't', kind: 'thinking', markdown: thought, durationMs: 4100 }],
      1,
    );
    const [line] = view.render(120);
    const left =
      '  ⋯ thought for 4.1s — addItem overwrites qty instead of adding to it.';
    expect(line).toBe(
      `${left}${' '.repeat(120 - visibleWidth(left) - 10)}^X expand `,
    );
    // Narrow: the key goes first, the sentence is cut.
    const [narrow] = view.render(60);
    expect(visibleWidth(narrow ?? '')).toBeLessThanOrEqual(60);
    expect(narrow).not.toContain('^X');
    // Expanded: every word, behind the gutter.
    view.toggleExpanded();
    const open = view.render(60);
    expect(open[0]).toBe('  ⋯ thought for 4.1s');
    expect(
      open
        .slice(1)
        .map((row) => row.slice(4))
        .join(' '),
    ).toContain('The fix is a +=.');
    for (const row of open.slice(1)) expect(row.startsWith('  │ ')).toBe(true);
  });

  it('says "thinking" when the time was not measured', () => {
    const view = createTranscriptView();
    view.applyLaneSnapshot(
      { laneId: 'l' },
      [{ id: 't', kind: 'thinking', markdown: 'Plan first' }],
      1,
    );
    expect(view.render(80)[0]).toContain('⋯ thinking — Plan first');
  });

  it('renders the receipt kinds', () => {
    const base = { elapsedMs: 18_400, tools: 4, costUsd: 0.031, diffKey: '^O' };
    const success = renderReceipt(
      plainUi,
      { outcome: 'completed', ...base, files: 1, added: 1, removed: 1 },
      100,
    );
    const left = '  ✓ turn 18.4s · 4 tools · 1 file +1 −1 · $0.031';
    const right = '^O review diff   /undo revert ';
    expect(success).toBe(
      `${left}${' '.repeat(100 - visibleWidth(left) - visibleWidth(right))}${right}`,
    );
    expect(
      renderReceipt(plainUi, { outcome: 'completed', ...base, files: 0 }, 100),
    ).toBe('  ✓ turn 18.4s · 4 tools · $0.031');
    expect(
      renderReceipt(
        plainUi,
        { outcome: 'failed', ...base, files: 0, detail: 'provider exploded' },
        100,
      ),
    ).toBe('  ✕ turn failed · 18.4s · provider exploded');
    expect(
      renderReceipt(plainUi, { outcome: 'cancelled', ...base, files: 0 }, 100),
    ).toBe('  ○ turn cancelled · 18.4s');
    // Narrow: the right part drops first.
    const narrow = renderReceipt(
      plainUi,
      { outcome: 'completed', ...base, files: 1, added: 1, removed: 1 },
      60,
    );
    expect(narrow).toBe(left);
  });
});

describe('markdown on the tokens', () => {
  const answer = [
    '# Fixed',
    '',
    'Use `existing.qty += qty` in **src/cart.js:10**.',
    '',
    '- one',
    '- two',
    '',
    '```ts',
    'const total = 42;',
    '```',
    '',
    '> quoted',
  ].join('\n');

  const render = (width: number): string[] => {
    const view = createTranscriptView();
    view.applyLaneSnapshot(
      { laneId: 'l' },
      [{ id: 't', kind: 'text', markdown: answer }],
      1,
    );
    return view.render(width);
  };

  it('frames fenced code, bullets lists and pads inline code', () => {
    const doc = render(80).join('\n');
    expect(doc).toContain('  ◆ Fixed');
    expect(doc).toContain('Use  existing.qty += qty  in src/cart.js:10.');
    expect(doc).toContain('    • one');
    expect(doc).toContain('    ┌ ts');
    expect(doc).toContain('    │ const total = 42;');
    expect(doc).toContain('    └');
  });

  it('highlights fenced code at colour', async () => {
    const { loadHighlighter } = await import('./ui/highlight.js');
    await loadHighlighter();
    const theme = createTuiTheme('truecolor');
    setTuiTheme(theme);
    const doc = render(80).join('\n');
    expect(doc).toContain(theme.ui.fg('warn')('42'));
    expect(doc).toContain(
      theme.ui.style({ fg: 'fg0', bg: 'bg2' })(' existing.qty += qty '),
    );
  });
});

describe('a live theme switch', () => {
  it('repaints cached markdown in the new theme at the same depth', async () => {
    const { builtinThemePalette, createThemeFromPalette } = await import(
      './theme.js'
    );
    const transcript = createTranscriptView();
    transcript.applyLaneSnapshot(
      { laneId: 'l' },
      [{ id: 't', kind: 'text', markdown: 'Use `qty` here.' }],
      1,
    );
    const dark = createThemeFromPalette(
      builtinThemePalette('dark'),
      'truecolor',
      'dark',
    );
    const light = createThemeFromPalette(
      builtinThemePalette('light'),
      'truecolor',
      'light',
    );
    setTuiTheme(dark);
    const before = transcript.render(60).join('\n');
    expect(before).toContain(dark.ui.style({ fg: 'fg0', bg: 'bg2' })(' qty '));
    setTuiTheme(light);
    const after = transcript.render(60).join('\n');
    expect(after).toContain(light.ui.style({ fg: 'fg0', bg: 'bg2' })(' qty '));
    expect(after).not.toBe(before);
  });
});

describe('file links in answers', () => {
  afterEach(() => {
    resetCapabilitiesCache();
  });

  const view = () => {
    const transcript = createTranscriptView({
      fileUrl: (path) =>
        path === 'src/cart.js' ? 'file:///work/pg/src/cart.js' : undefined,
    });
    transcript.applyLaneSnapshot(
      { laneId: 'l' },
      [{ id: 't', kind: 'text', markdown: 'See src/cart.js:10 now.' }],
      1,
    );
    return transcript;
  };

  it('links project files where the terminal supports hyperlinks', () => {
    setCapabilities({ images: null, trueColor: false, hyperlinks: true });
    const lines = view().render(80);
    const line = lines.find((row) => row.includes('src/cart.js')) ?? '';
    expect(line).toContain('\u001b]8;;file:///work/pg/src/cart.js');
    // The link is zero width: the row reads exactly like the text.
    expect(visibleWidth(line)).toBe(
      visibleWidth('  ◆ See src/cart.js:10 now.'),
    );
  });

  it('leaves the text alone where it does not', () => {
    setCapabilities({ images: null, trueColor: false, hyperlinks: false });
    const doc = view().render(80).join('\n');
    expect(doc).toContain('See src/cart.js:10 now.');
    expect(doc).not.toContain('file://');
  });
});
