// Single-file journal diff rendering.
// Text only, no VirtualTerminal in Pi 0.85.1: headless snapshots render
// directly like layout.test.ts. Structural DiffFileChange mirrors exec
// FileChange (the exec journal/diff.ts) without importing it — tui must never
// import exec/host/agent implementation (dep-lint).
import { describe, expect, it } from 'vitest';
import {
  isBinaryText,
  renderDiffHeader,
  renderDiffLines,
  unifiedHunks,
} from './diff-view.js';

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

describe('diff view header + hunks', () => {
  it('write+edit renders path header, op label, tool-call marker, hunks', () => {
    expect(renderDiffLines(WRITE_EDIT)).toEqual([
      'a.txt — write',
      '--- a/a.txt',
      '+++ b/a.txt',
      '# toolCall=call-1',
      '@@ -1,4 +1,4 @@',
      ' one',
      '-two',
      '+TWO',
      ' three',
      ' ',
    ]);
  });

  it('truncates long lines and caps max lines with a trailer', () => {
    const long = {
      ...WRITE_EDIT,
      after: `one\n${'x'.repeat(200)}\nthree\n`,
    };
    // maxLines keeps the long line inside the window, so both the width
    // clamp (ellipsis at 40) and the trailer are exercised.
    const lines = renderDiffLines(long, { width: 40, maxLines: 8 });
    expect(lines).toEqual([
      'a.txt — write',
      '--- a/a.txt',
      '+++ b/a.txt',
      '# toolCall=call-1',
      '@@ -1,4 +1,4 @@',
      ' one',
      '-two',
      `+${'x'.repeat(38)}…`,
      '… (2 more lines)',
    ]);
  });
});

describe('diff placeholders', () => {
  it('detects binary content by NUL byte', () => {
    expect(isBinaryText('ab\0cd')).toBe(true);
    expect(isBinaryText('plain text\n')).toBe(false);
  });

  it('isBinaryText never throws on runtime undefined (returns false)', () => {
    expect(isBinaryText(undefined as unknown as string)).toBe(false);
  });

  it('binary either-side renders a placeholder and never throws', () => {
    for (const side of [{ after: 'a\0b' }, { before: 'a\0b' }]) {
      const lines = renderDiffLines({ ...WRITE_EDIT, ...side });
      expect(lines.slice(4)).toEqual(['~ binary content not shown: a.txt']);
    }
  });

  it('missing blob (unexpected null side) renders a placeholder', () => {
    const lines = renderDiffLines({ ...WRITE_EDIT, before: null });
    expect(lines.slice(4)).toEqual([
      '~ content unavailable: a.txt (missing before-blob)',
    ]);
  });

  it('create/delete null sides render hunks, not placeholders', () => {
    const created = renderDiffLines({
      ...WRITE_EDIT,
      op: 'create',
      before: null,
      after: 'new\n',
      reversible: false,
    });
    expect(created).toContain('+new');
    const deleted = renderDiffLines({
      ...WRITE_EDIT,
      op: 'delete',
      after: null,
      before: 'gone\n',
      reversible: true,
    });
    expect(deleted).toContain('-gone');
  });
});

describe('diff view exact rendering', () => {
  it('badges the header for unattributed reconciliation entries', () => {
    expect(renderDiffHeader({ ...WRITE_EDIT, unattributed: true })).toBe(
      'a.txt — write [unattributed]',
    );
    expect(renderDiffHeader(WRITE_EDIT)).toBe('a.txt — write');
  });

  it('missing after-blob on a non-delete renders an after placeholder', () => {
    const lines = renderDiffLines({ ...WRITE_EDIT, after: null });
    expect(lines.join('\n')).toContain(
      '~ content unavailable: a.txt (missing after-blob)',
    );
    expect(lines.some((l) => l.startsWith('-') && l !== '--- a/a.txt')).toBe(
      false,
    );
  });

  it('maxLines equal to the line count keeps every line with no trailer', () => {
    const full = renderDiffLines(WRITE_EDIT);
    expect(full.length).toBeGreaterThan(0);
    const capped = renderDiffLines(WRITE_EDIT, { maxLines: full.length });
    expect(capped).toEqual(full);
    expect(capped[capped.length - 1]).not.toMatch(/more lines/);
  });

  it('rename renders hunks with the op label in the header', () => {
    const lines = renderDiffLines({ ...WRITE_EDIT, op: 'rename' });
    expect(lines[0]).toContain('rename');
    expect(lines).toContain('-two');
    expect(lines).toContain('+TWO');
  });

  it('clamps every line to width with no maxLines cap', () => {
    const long = {
      ...WRITE_EDIT,
      after: `one\n${'x'.repeat(200)}\nthree\n`,
    };
    const lines = renderDiffLines(long, { width: 40 });
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
  });
});
