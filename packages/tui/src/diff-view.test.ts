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
