// The journal panel's document: one row per change, then each file's
// section, plus the path filter, which mirrors `kubic diff --path` (host
// journal-cli.ts over exec diffEntries): exact match on path. Plain text at
// depth none reads like the design.
import { createUiTheme } from '@kubic/core/ui/style';
import { DARK_PALETTE } from '@kubic/core/ui/tokens';
import { describe, expect, it } from 'vitest';
import { type DiffFileChange, renderChange } from './diff-view.js';
import {
  filterJournalChanges,
  renderJournalLines,
  totalCounts,
} from './journal-view.js';
import { visibleWidth } from './tui-boundary.js';

const plain = createUiTheme(DARK_PALETTE, 'none');

const between = (left: string, right: string, width: number): string =>
  `${left}${' '.repeat(width - visibleWidth(left) - visibleWidth(right))}${right}`;

// The local wall-clock minute the rows print.
function clock(timestamp: number): string {
  const at = new Date(timestamp);
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${two(at.getHours())}:${two(at.getMinutes())}`;
}

function changes(): DiffFileChange[] {
  return [
    {
      path: 'a.txt',
      op: 'write',
      toolCallId: 'call-1',
      sessionId: 's1',
      timestamp: 100,
      unattributed: false,
      reversible: true,
      before: 'one\ntwo\nthree\n',
      after: 'one\nTWO\nthree\n',
    },
    {
      path: 'b.txt',
      op: 'create',
      toolCallId: 'call-2',
      sessionId: 's1',
      timestamp: 200,
      unattributed: false,
      reversible: false,
      before: null,
      after: 'new\n',
    },
    {
      path: 'c.txt',
      op: 'write',
      toolCallId: null,
      sessionId: 's1',
      timestamp: 300,
      unattributed: true,
      reversible: false,
      before: null,
      after: 'mystery\n',
    },
  ];
}

describe('journal filters (mirrors `kubic diff`)', () => {
  it('narrows by path exactly like --path', () => {
    expect(
      filterJournalChanges(changes(), { path: 'b.txt' }).map((c) => c.path),
    ).toEqual(['b.txt']);
  });

  it('empty filter keeps every file; unknown values match nothing', () => {
    expect(filterJournalChanges(changes(), {}).length).toBe(3);
    expect(filterJournalChanges(changes(), { path: 'nope' })).toEqual([]);
  });
});

describe('journal document', () => {
  it('lists every change as one row, then each file in its own section', () => {
    const lines = renderJournalLines(plain, changes(), 60);
    expect(lines.slice(0, 3)).toEqual([
      between(' write   a.txt', `+1 −1  ${clock(100)} `, 60),
      between(' create  b.txt', `+1 −0  ${clock(200)} `, 60),
      between(' write   c.txt  unattributed', `+0 −0  ${clock(300)} `, 60),
    ]);
    const sections = changes().flatMap((change) => [
      '',
      ...renderChange(plain, change, 60),
    ]);
    expect(lines.slice(3)).toEqual(sections);
  });

  it('right-aligns the counts column', () => {
    const [wide, narrow] = changes();
    if (wide === undefined || narrow === undefined) throw new Error('fixture');
    const many = {
      ...wide,
      before: 'a\n',
      after: Array.from({ length: 12 }, (_, i) => `n${i}`).join('\n'),
    };
    const lines = renderJournalLines(plain, [many, narrow], 60);
    expect(lines[0]).toContain(`+12 −1  ${clock(100)}`);
    expect(lines[1]).toContain(`  +1 −0  ${clock(200)}`);
  });

  it('keeps the placeholder notes in the sections and never throws', () => {
    const lines = renderJournalLines(plain, changes(), 60);
    expect(lines).toContain('  ~ content unavailable (missing before-blob)');
  });

  it('says `no changes` for an empty journal', () => {
    expect(renderJournalLines(plain, [], 60)).toEqual(['no changes']);
  });

  it('sums the lines of every change for the title', () => {
    expect(totalCounts(changes())).toEqual({ added: 2, removed: 1 });
  });
});
