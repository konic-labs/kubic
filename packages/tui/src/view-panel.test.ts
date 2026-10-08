// The diff panel's "follow the run" selection. While no
// tool call is pinned the panel shows the run's most recent change, and a
// change made with `bash` is journaled only by the sweep — as an
// UNATTRIBUTED row (toolCallId null) — so the selection must reach those rows
// too or Ctrl-O says `no changes` for a change the user just watched happen.
import { describe, expect, it } from 'vitest';
import {
  DiffPanel,
  type JournalChangeLike,
  JournalPanel,
  PANEL_EMPTY_LINE,
} from './view-panel.js';

function row(
  path: string,
  toolCallId: string | null,
  timestamp: number,
): JournalChangeLike {
  return {
    path,
    op: 'write',
    toolCallId,
    sessionId: 's1',
    timestamp,
    unattributed: toolCallId === null,
    reversible: toolCallId !== null,
    before: toolCallId === null ? null : 'old\n',
    after: 'new\n',
  };
}

const paths = (panel: DiffPanel): string[] =>
  panel.visibleRows().map((r) => r.path);

describe('journal rows at ingress', () => {
  it('copies only the fields the panels name, and cleans every string', () => {
    const ESC = '\u001b';
    const stored = {
      ...row(`evil${ESC}[2Jname.ts`, `tc${ESC}[31m`, 1),
      // A stored attribution the panels never read: it must not survive.
      agentId: `root${ESC}[2J`,
    } as JournalChangeLike;
    // The panel is the ingress: its rows are the sanitised copies.
    const [clean] = new JournalPanel([stored]).visibleRows();
    if (clean === undefined) throw new Error('the panel dropped the row');
    expect(clean).not.toHaveProperty('agentId');
    expect(Object.keys(clean).sort()).toEqual([
      'after',
      'before',
      'op',
      'path',
      'reversible',
      'sessionId',
      'timestamp',
      'toolCallId',
      'unattributed',
    ]);
    expect(clean.path).not.toContain(ESC);
    expect(clean.toolCallId).not.toContain(ESC);
    expect(clean.before).toBe('old\n');
    expect(clean.after).toBe('new\n');
  });
});

describe('DiffPanel following the run', () => {
  it('shows the call the run last touched when it wrote something', () => {
    const panel = new DiffPanel([
      row('a.txt', 'c1', 10),
      row('b.txt', 'c2', 20),
    ]);
    panel.followToolCall('c1');
    expect(paths(panel)).toEqual(['a.txt']);
  });

  it('a followed call that wrote nothing falls to the most recent attributed call', () => {
    const panel = new DiffPanel([
      row('a.txt', 'c1', 10),
      row('b.txt', 'c2', 20),
    ]);
    panel.followToolCall('c-read');
    expect(paths(panel)).toEqual(['b.txt']);
  });

  it('a bash change (unattributed sweep rows) newer than every attributed row is what a no-row call falls to', () => {
    const panel = new DiffPanel([
      row('a.txt', 'c1', 10),
      row('made-by-bash.txt', null, 20),
      row('also-by-bash.txt', null, 20),
    ]);
    panel.followToolCall('c-bash');
    expect(paths(panel)).toEqual(['made-by-bash.txt', 'also-by-bash.txt']);
  });

  it('only the latest sweep is shown, not an older sweep of the same session', () => {
    const panel = new DiffPanel([
      row('old-sweep.txt', null, 20),
      row('new-sweep.txt', null, 30),
    ]);
    panel.followToolCall('c-bash');
    expect(paths(panel)).toEqual(['new-sweep.txt']);
  });

  it('an attributed call newer than the last sweep wins over it', () => {
    const panel = new DiffPanel([
      row('swept.txt', null, 20),
      row('written.txt', 'c2', 30),
    ]);
    panel.followToolCall('c-read');
    expect(paths(panel)).toEqual(['written.txt']);
  });

  it('on a timestamp tie the later journal row decides, as before', () => {
    const panel = new DiffPanel([
      row('written.txt', 'c2', 30),
      row('swept.txt', null, 30),
    ]);
    panel.followToolCall('c-read');
    expect(paths(panel)).toEqual(['swept.txt']);
  });

  it('an explicit pin is honoured exactly: no rows for the pinned call is `no changes`, never a fallback', () => {
    const panel = new DiffPanel([
      row('a.txt', 'c1', 10),
      row('swept.txt', null, 20),
    ]);
    panel.setToolCall('c-other');
    expect(paths(panel)).toEqual([]);
    expect(panel.render(80)).toEqual([PANEL_EMPTY_LINE]);
  });

  it('with no journal rows at all the panel is `no changes`', () => {
    const panel = new DiffPanel([]);
    panel.followToolCall('c1');
    expect(paths(panel)).toEqual([]);
    expect(panel.render(80)).toEqual([PANEL_EMPTY_LINE]);
  });

  it('with no call followed or pinned every row is shown', () => {
    const rows = [row('a.txt', 'c1', 10), row('swept.txt', null, 20)];
    expect(paths(new DiffPanel(rows))).toEqual(['a.txt', 'swept.txt']);
  });
});
