// Slice A RED: DiffView single-file journal diff (issue #25; §16.5, §18).
// Text only, no VirtualTerminal in Pi 0.85.1: headless snapshots render
// directly like layout.test.ts. Structural DiffFileChange mirrors exec
// FileChange (journal-diff.ts) without importing it — tui must never
// import exec/host/worker implementation (dep-lint).
import { describe, expect, it } from 'vitest';
import {
  DiffView,
  isBinaryText,
  renderDiffHeader,
  renderDiffLines,
  unifiedHunks,
} from './diff-view.js';

const WRITE_EDIT = {
  path: 'a.txt',
  op: 'write' as const,
  agentId: 'root',
  toolCallId: 'call-1',
  sessionId: 's1',
  timestamp: 100,
  unattributed: false,
  reversible: true,
  before: 'one\ntwo\nthree\n',
  after: 'one\nTWO\nthree\n',
};

describe('diff hunks (issue #25; §42.2 mirror)', () => {
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

// Issue #126: every emitted @@ header counts exactly the lines the hunk
// prints for its side — same invariant as the exec test, checked on the
// mirror so TUI hunks stay byte-equal to `kubic diff` hunks.
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

describe('truthful hunk header counts (issue #126)', () => {
  it('counts the lines emitted, not the pre-loop window (issue example)', () => {
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

describe('diff view header + hunks (issue #25)', () => {
  it('write+edit renders path header, op label, attribution, hunks', () => {
    const header = renderDiffHeader(WRITE_EDIT);
    expect(header).toContain('a.txt');
    expect(header).toContain('write');
    const lines = renderDiffLines(WRITE_EDIT);
    expect(lines).toContain('--- a/a.txt');
    expect(lines).toContain('+++ b/a.txt');
    expect(lines.join('\n')).toContain('agent=root toolCall=call-1');
    expect(lines).toContain('-two');
    expect(lines).toContain('+TWO');
  });

  it('headless DiffView snapshot shows header + hunks within width', () => {
    const view = new DiffView(WRITE_EDIT);
    const lines = view.render(100);
    const doc = lines.join('\n');
    expect(doc).toContain('a.txt');
    expect(doc).toContain('-two');
    expect(doc).toContain('+TWO');
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
  });

  it('truncates long lines and caps max lines with a trailer', () => {
    const long = {
      ...WRITE_EDIT,
      after: `one\n${'x'.repeat(200)}\nthree\n`,
    };
    const lines = renderDiffLines(long, { width: 40, maxLines: 5 });
    expect(lines.length).toBeLessThanOrEqual(6);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
    expect(lines[lines.length - 1]).toMatch(/more lines/);
  });
});

describe('diff placeholders (issue #25)', () => {
  it('detects binary content by NUL byte', () => {
    expect(isBinaryText('ab\0cd')).toBe(true);
    expect(isBinaryText('plain text\n')).toBe(false);
  });

  it('isBinaryText never throws on runtime undefined (returns false)', () => {
    expect(isBinaryText(undefined as unknown as string)).toBe(false);
  });

  it('binary either-side renders a placeholder and never throws', () => {
    const lines = renderDiffLines({ ...WRITE_EDIT, after: 'a\0b' });
    expect(lines.join('\n')).toContain('binary');
    expect(lines.some((l) => l.startsWith('+a'))).toBe(false);
  });

  it('missing blob (unexpected null side) renders a placeholder', () => {
    const lines = renderDiffLines({ ...WRITE_EDIT, before: null });
    expect(lines.join('\n')).toContain('unavailable');
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

describe('diff mutation hardening (issue #68)', () => {
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
