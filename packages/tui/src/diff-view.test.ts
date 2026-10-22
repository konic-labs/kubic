// One journal change as a panel section: the rows (numbered like the
// transcript's tool cards, with gaps for the lines left out) and the section's
// header band. Plain text at depth none reads like the design. Structural
// DiffFileChange mirrors exec FileChange (the exec journal/diff.ts) without
// importing it — tui must never import exec/host/agent implementation
// (dep-lint).
import { createUiTheme } from '@kubic/core/ui/style';
import { DARK_PALETTE } from '@kubic/core/ui/tokens';
import { describe, expect, it } from 'vitest';
import {
  changeRows,
  countRows,
  isBinaryText,
  renderChange,
  renderCounts,
  unifiedHunks,
} from './diff-view.js';
import { visibleWidth } from './tui-boundary.js';

const plain = createUiTheme(DARK_PALETTE, 'none');
const rich = createUiTheme(DARK_PALETTE, 'truecolor');

const between = (left: string, right: string, width: number): string =>
  `${left}${' '.repeat(width - visibleWidth(left) - visibleWidth(right))}${right}`;

const WRITE_EDIT = {
  path: 'a.txt',
  op: 'write' as const,
  toolCallId: 'call-1',
  sessionId: 's1',
  timestamp: 100,
  unattributed: false,
  reversible: true,
  before: 'one\ntwo\nthree\n',
  after: 'one\nTWO\nthree\n',
};

describe('diff hunks', () => {
  it('renders one changed region with context and @@ headers', () => {
    const hunks = unifiedHunks('one\ntwo\nthree\n', 'one\nTWO\nthree\n');
    expect(hunks[0]).toMatch(/^@@ -1,\d+ \+1,\d+ @@$/);
    expect(hunks).toContain('-two');
    expect(hunks).toContain('+TWO');
    expect(hunks).toContain(' one');
  });

  it('renders a +42 −8 hunk with exact +/- prefixes and counts', () => {
    const before = Array.from({ length: 8 }, (_, i) => `old-${i}`).join('\n');
    const after = Array.from({ length: 42 }, (_, i) => `new-${i}`).join('\n');
    const hunks = unifiedHunks(before, after);
    expect(hunks.filter((l) => l.startsWith('-')).length).toBe(8);
    expect(hunks.filter((l) => l.startsWith('+')).length).toBe(42);
  });

  it('returns no hunks for identical content', () => {
    expect(unifiedHunks('same\n', 'same\n')).toEqual([]);
  });
});

// Every emitted @@ header counts exactly the lines the hunk
// prints for its side — the invariant the exec test checks, here applied to
// the mirror. Byte equality with exec is not checked in this package (it
// cannot import exec).
function hunkCountMismatches(
  lines: string[],
): Array<{ header: string; a: number; b: number }> {
  const out: Array<{ header: string; a: number; b: number }> = [];
  let header: RegExpExecArray | null = null;
  let a = 0;
  let b = 0;
  const flush = (): void => {
    if (header === null) return;
    if (Number(header[2]) !== a || Number(header[4]) !== b) {
      out.push({ header: header[0], a, b });
    }
  };
  for (const line of lines) {
    const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(line);
    if (m !== null) {
      flush();
      header = m;
      a = 0;
      b = 0;
      continue;
    }
    if (header === null) continue;
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    if (line.startsWith('#')) continue;
    if (line.startsWith(' ') || line.startsWith('-')) a++;
    if (line.startsWith(' ') || line.startsWith('+')) b++;
  }
  flush();
  return out;
}

describe('truthful hunk header counts', () => {
  it('counts the lines emitted, not the pre-loop window', () => {
    const lines = unifiedHunks('1\n2\n3\n4\n5', '1\n5');
    expect(lines[0]).toBe('@@ -1,5 +1,2 @@');
    expect(hunkCountMismatches(lines)).toEqual([]);
  });

  it('every edit shape keeps counts equal to the emitted lines', () => {
    const shapes: ReadonlyArray<readonly [string, string]> = [
      ['1\n2\n3', '1\n2\n3'],
      ['', 'x\n'],
      ['x\n', ''],
      ['a\nb\nc\nd\ne\nf\ng\nh', 'a\nb\nc\nd\ne\nf\ng\nh\nINSERT'],
      ['INSERT\na\nb\nc\nd\ne\nf\n', 'a\nb\nc\nd\ne\nf\n'],
      ['1\n2\n3\n4\n5\n6\n7\n8\n9', '1\n2\n3\nX\n5\n6\n7\n8\n9'],
      ['1\n2\n3\n4\n5', '1\n5'],
      ['1\n5', '1\n2\n3\n4\n5'],
      ['a\nb\nc\nd\ne\nf', 'a\nb\nc\nd\ne'],
      ['a\nb\nc', 'a\nX\nY\nc'],
    ];
    for (const [before, after] of shapes) {
      for (const context of [0, 1, 3, 10]) {
        expect(
          hunkCountMismatches(unifiedHunks(before, after, context)),
        ).toEqual([]);
      }
    }
  });
});

describe('change rows', () => {
  it('numbers removed rows by the old file and the rest by the new one', () => {
    expect(changeRows(WRITE_EDIT).rows).toEqual([
      { kind: 'context', number: '1', text: 'one' },
      { kind: 'del', number: '2', text: 'two' },
      { kind: 'add', number: '2', text: 'TWO' },
      { kind: 'context', number: '3', text: 'three' },
    ]);
  });

  it('marks the unchanged lines left out above and below with a gap', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
    const before = `${lines.join('\n')}\n`;
    const after = before.replace('l10\n', 'L10\n');
    const { rows } = changeRows({ ...WRITE_EDIT, before, after });
    expect(rows[0]?.kind).toBe('gap');
    expect(rows.at(-1)?.kind).toBe('gap');
    expect(
      rows.filter((row) => row.kind !== 'gap').map((row) => row.number),
    ).toEqual(['7', '8', '9', '10', '10', '11', '12', '13']);
  });

  it('shows a created or deleted file as one kind of row, without a phantom empty line', () => {
    const created = changeRows({
      ...WRITE_EDIT,
      op: 'create',
      before: null,
      after: 'a\nb\n',
    });
    expect(created.rows).toEqual([
      { kind: 'add', number: '1', text: 'a' },
      { kind: 'add', number: '2', text: 'b' },
    ]);
    const deleted = changeRows({
      ...WRITE_EDIT,
      op: 'delete',
      before: 'gone\n',
      after: null,
    });
    expect(deleted.rows).toEqual([{ kind: 'del', number: '1', text: 'gone' }]);
  });

  it('says why there are no rows, and never throws on binary or missing content', () => {
    const note = (
      over: Partial<typeof WRITE_EDIT> | object,
    ): string | undefined => changeRows({ ...WRITE_EDIT, ...over }).note;
    expect(note({ after: 'a\0b' })).toBe('binary content not shown');
    expect(note({ before: 'a\0b' })).toBe('binary content not shown');
    expect(note({ before: null })).toBe(
      'content unavailable (missing before-blob)',
    );
    expect(note({ after: null })).toBe(
      'content unavailable (missing after-blob)',
    );
    expect(note({ op: 'rename', after: WRITE_EDIT.before })).toBe(
      'content unchanged',
    );
    expect(note({ before: 'x', after: 'x\n' })).toBe(
      'only the final newline changed',
    );
  });

  it('counts the added and removed rows', () => {
    expect(countRows(changeRows(WRITE_EDIT).rows)).toEqual({
      added: 1,
      removed: 1,
    });
  });
});

describe('isBinaryText', () => {
  it('detects binary content by NUL byte', () => {
    expect(isBinaryText('ab\0cd')).toBe(true);
    expect(isBinaryText('plain text\n')).toBe(false);
  });

  it('never throws on runtime undefined (returns false)', () => {
    expect(isBinaryText(undefined as unknown as string)).toBe(false);
  });
});

describe('a change section', () => {
  it('heads the rows with the path, the op and the counts', () => {
    expect(renderChange(plain, WRITE_EDIT, 40)).toEqual([
      between(' a.txt  write', '+1 −1 ', 40),
      '1   one',
      '2 − two',
      '2 + TWO',
      '3   three',
    ]);
  });

  it('flags a reconciled or irreversible change, and numbers a file of several', () => {
    const [header] = renderChange(
      plain,
      { ...WRITE_EDIT, unattributed: true, reversible: false },
      80,
      { ordinal: { index: 2, total: 3 } },
    );
    expect(header).toBe(
      between(' a.txt  write unattributed · not reversible', '+1 −1  2/3 ', 80),
    );
    // A single file needs no ordinal.
    expect(
      renderChange(plain, WRITE_EDIT, 40, {
        ordinal: { index: 1, total: 1 },
      })[0],
    ).not.toContain('1/1');
  });

  it('says why a section has no rows under its header', () => {
    expect(
      renderChange(plain, { ...WRITE_EDIT, after: 'a\0b' }, 40).slice(1),
    ).toEqual(['  ~ binary content not shown']);
  });

  it('paints the header band and quiets a zero count', () => {
    const [header] = renderChange(
      rich,
      { ...WRITE_EDIT, before: 'one\n', after: 'one\ntwo\n' },
      40,
    );
    expect(header?.startsWith(rich.open({ bg: 'bg2' }))).toBe(true);
    expect(renderCounts(rich, { added: 2, removed: 0 })).toBe(
      `${rich.fg('add')('+2')} ${rich.fg('fg3')('−0')}`,
    );
  });

  it('fits every line to the width', () => {
    const long = { ...WRITE_EDIT, after: `one\n${'x'.repeat(200)}\nthree\n` };
    for (const line of renderChange(plain, long, 40)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
  });
});
