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
} from './transcript.js';

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
    const view = createTranscriptView();
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
    // The ESC and BEL bytes are gone; the sequence's printable parameters
    // stay as literal text (the shipped sanitizer strips controls, it does
    // not interpret them).
    expect(row).toContain('queued: [2Jclear');
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
