// Journal diff core — attributed hunks from entries.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clipChangeContent,
  clipContent,
  DEFAULT_MAX_CONTENT_BYTES,
  diffEntries,
  type FileChange,
  renderDiff,
  renderDiffStat,
  unifiedHunks,
} from './diff.js';
import { FileJournalStore } from './store.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'j-'));
  roots.push(root);
  return root;
}

function seed(): FileJournalStore {
  const store = new FileJournalStore(tmpRoot());
  store.append({
    path: 'a.txt',
    op: 'write',
    before: 'one\ntwo\nthree\n',
    after: 'one\nTWO\nthree\n',
    bytesDelta: 0,
    sessionId: 's1',
    toolCallId: 'call-1',
    timestamp: 100,
  });
  store.append({
    path: 'b.txt',
    op: 'create',
    before: null,
    after: 'new\n',
    bytesDelta: 4,
    sessionId: 's1',
    toolCallId: 'call-2',
    timestamp: 200,
  });
  store.append({
    path: 'c.txt',
    op: 'write',
    before: null,
    beforeHash: 'deadbeef',
    after: 'mystery\n',
    bytesDelta: 8,
    sessionId: 's1',
    toolCallId: null,
    timestamp: 300,
    unattributed: true,
  });
  return store;
}

describe('journal diff core', () => {
  it('lists every change with attribution and reversibility', () => {
    const changes = diffEntries(seed(), {});
    expect(changes.map((c) => c.path)).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(changes[0]).toMatchObject({
      source: 'tool',
      toolCallId: 'call-1',
      reversible: true,
    });
    expect(changes[2]).toMatchObject({
      unattributed: true,
      toolCallId: null,
      reversible: false,
    });
  });

  it('filters by path', () => {
    const store = seed();
    expect(diffEntries(store, { path: 'b.txt' }).map((c) => c.path)).toEqual([
      'b.txt',
    ]);
  });

  it('renders attributed hunks, marking unattributed as such', () => {
    const text = renderDiff(diffEntries(seed(), {}));
    expect(text).toContain('--- a/a.txt');
    expect(text).toContain('+++ b/a.txt');
    expect(text).toContain('-two');
    expect(text).toContain('+TWO');
    expect(text).toContain('toolCall=call-1');
    expect(text).not.toContain('agent=');
    expect(text).toContain('unattributed');
    // The JSON form is lossless: every change survives a serialize/parse
    // round trip unchanged (no Map/Date/undefined-only fields to drop).
    const changes = diffEntries(seed(), {});
    expect(JSON.parse(JSON.stringify(changes))).toEqual(changes);
  });
});

// Every emitted `@@` header must count exactly the lines the
// hunk prints for its side (`-`/context for A, `+`/context for B) — a
// consumer (the TUI view, a future patch applier) reads the counts. The
// counts are accumulated while emitting, never derived from pre-loop
// window arithmetic, so the two can never disagree.
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
    // File headers (--- a/…, +++ b/…) and # comments are not hunk lines.
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
      ['1\n2\n3', '1\n2\n3'], // identical: no hunk at all
      ['', 'x\n'], // create from nothing
      ['x\n', ''], // empty-after
      ['a\nb\nc\nd\ne\nf\ng\nh', 'a\nb\nc\nd\ne\nf\ng\nh\nINSERT'], // at EOF
      ['INSERT\na\nb\nc\nd\ne\nf\n', 'a\nb\nc\nd\ne\nf\n'], // at start
      ['1\n2\n3\n4\n5\n6\n7\n8\n9', '1\n2\n3\nX\n5\n6\n7\n8\n9'], // replace
      ['1\n2\n3\n4\n5', '1\n5'], // delete shortens B
      ['1\n5', '1\n2\n3\n4\n5'], // insert lengthens B
      ['a\nb\nc\nd\ne\nf', 'a\nb\nc\nd\ne'], // delete at EOF
      ['a\nb\nc', 'a\nX\nY\nc'], // replace near the end
    ];
    for (const [before, after] of shapes) {
      for (const context of [0, 1, 3, 10]) {
        expect(
          hunkCountMismatches(unifiedHunks(before, after, context)),
        ).toEqual([]);
      }
    }
  });

  it('renderDiff keeps every header truthful across the existing fixtures', () => {
    const text = renderDiff(diffEntries(seed(), {}));
    expect(hunkCountMismatches(text.split('\n'))).toEqual([]);
  });
});

// The `diff --json` content bound — byte-exact clipping with a
// named marker, `0` meaning unlimited, null sides untouched.
describe('diff --json content clipping', () => {
  it('clips at the byte bound and names it in a marker line', () => {
    const text = 'x'.repeat(100);
    const clipped = clipContent(text, 10);
    expect(clipped.truncated).toBe(true);
    expect(clipped.text).toBe(
      'xxxxxxxxxx\n[kubic: content truncated at 10 bytes]',
    );
  });

  it('0 is unlimited; short content and null sides are untouched', () => {
    const text = 'x'.repeat(100);
    expect(clipContent(text, 0)).toEqual({ text, truncated: false });
    expect(clipContent('short', DEFAULT_MAX_CONTENT_BYTES)).toEqual({
      text: 'short',
      truncated: false,
    });
    expect(clipContent(null, 10)).toEqual({ text: null, truncated: false });
  });

  it('a cut inside a multibyte character stays valid UTF-8', () => {
    const clipped = clipContent('é'.repeat(10), 5);
    expect(clipped.truncated).toBe(true);
    // 4 bytes of é plus half of the next one decode to a replacement char.
    expect(clipped.text).toBe(
      'éé\uFFFD\n[kubic: content truncated at 5 bytes]',
    );
  });

  it('the projection clips both sides and flags the change', () => {
    const change: FileChange = {
      path: 'a.txt',
      op: 'write',
      source: 'tool',
      toolCallId: 'call-1',
      sessionId: 's1',
      timestamp: 100,
      unattributed: false,
      reversible: true,
      before: 'small\n',
      after: 'y'.repeat(50),
      corrupt: false,
      afterOmitted: false,
    };
    const big = clipChangeContent(change, 10);
    expect(big.contentTruncated).toBe(true);
    expect(big.before).toBe('small\n');
    expect(big.after).toBe(
      'yyyyyyyyyy\n[kubic: content truncated at 10 bytes]',
    );
    const small = clipChangeContent(change, DEFAULT_MAX_CONTENT_BYTES);
    expect(small.contentTruncated).toBe(false);
    expect(small.before).toBe('small\n');
    expect(small.after).toBe(change.after);
  });
});

// Blob integrity: corrupt journal content must surface as a
// named flag/marker, never crash the read path.
describe('corrupt journal content', () => {
  function tornDeltaStore(): {
    store: FileJournalStore;
    dir: string;
  } {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir);
    const before = 'b\n'.repeat(40_000);
    const after = 'c\n'.repeat(40_000);
    const recorded = store.append({
      path: 'big.txt',
      op: 'write',
      before,
      after,
      bytesDelta: 0,
      sessionId: 's1',
      toolCallId: 'call-1',
      timestamp: 100,
    });
    expect(recorded.deltaHash).toMatch(/^[0-9a-f]{64}$/);
    // Torn write: the delta blob survives only partially on disk.
    writeFileSync(join(dir, 'blobs', recorded.deltaHash ?? ''), '{torn');
    return { store, dir };
  }

  it('a torn delta blob marks the change corrupt instead of crashing diffEntries', () => {
    // Today this throws an uncaught SyntaxError out of applyDelta.
    const changes = diffEntries(tornDeltaStore().store, {});
    expect(changes).toHaveLength(1);
    expect(changes[0]?.corrupt).toBe(true);
  });

  it('renderDiff prints the corrupt-content marker for a corrupt change', () => {
    const change: FileChange = {
      path: 'big.txt',
      op: 'write',
      source: 'tool',
      toolCallId: 'call-1',
      sessionId: 's1',
      timestamp: 100,
      unattributed: false,
      reversible: true,
      before: 'b\n',
      after: null,
      corrupt: true,
      afterOmitted: false,
    };
    expect(renderDiff([change])).toContain('# [corrupt journal content]');
  });

  it('a healthy entry is not marked corrupt', () => {
    const changes = diffEntries(seed(), {});
    for (const c of changes) expect(c.corrupt).toBe(false);
    expect(renderDiff(changes)).not.toContain('# [corrupt journal content]');
  });

  it('a hash-corrupt before-blob marks the change corrupt', () => {
    const dir = tmpRoot();
    const store = new FileJournalStore(dir);
    const recorded = store.append({
      path: 'a.txt',
      op: 'write',
      before: 'v1\n',
      after: 'v2\n',
      bytesDelta: 0,
      sessionId: 's1',
      toolCallId: 'call-1',
      timestamp: 100,
    });
    writeFileSync(join(dir, 'blobs', recorded.beforeHash ?? ''), 'tampered\n');
    const changes = diffEntries(store, {});
    expect(changes[0]?.corrupt).toBe(true);
  });
});

describe('HEAD-move markers', () => {
  it('never surfaces a marker as a diff hunk', () => {
    const store = seed();
    store.append({
      path: '',
      op: 'marker',
      before: null,
      after: null,
      bytesDelta: 0,
      headFrom: { head: 'a'.repeat(40), branch: 'main', stash: 0 },
      headTo: { head: 'b'.repeat(40), branch: 'x', stash: 0 },
      sessionId: 's1',
      toolCallId: null,
      timestamp: 1700000002000,
      unattributed: true,
    });
    const changes = diffEntries(store, {});
    // Markers carry the empty path and `op: 'marker'` (a `FileOp` can never
    // hold it) — either sighting would be a leaked hunk.
    expect(changes.some((c) => c.path === '')).toBe(false);
    expect(changes.map((c) => c.path).sort()).toEqual([
      'a.txt',
      'b.txt',
      'c.txt',
    ]);
  });
});

describe('diff --stat', () => {
  function change(over: Record<string, unknown>): FileChange {
    return {
      path: 'a.txt',
      op: 'write',
      source: 'tool',
      toolCallId: 't',
      sessionId: 's',
      timestamp: 1,
      unattributed: false,
      reversible: true,
      before: 'one\ntwo\nthree\n',
      after: 'one\nTWO\nthree\nfour\n',
      corrupt: false,
      afterOmitted: false,
      ...over,
    } as FileChange;
  }

  it('prints path, hunk-matching counts, tool and turn', () => {
    const lines = renderDiffStat([
      change({ path: 'src/auth/token.ts', toolName: 'edit', turn: 3 }),
    ]);
    // Exactly the hunk body below: -two -three +TWO +three +four.
    expect(lines).toEqual(['src/auth/token.ts +3 -2 edit, turn 3']);
  });

  it('renders pre-schema entries with the op and no turn', () => {
    const lines = renderDiffStat([
      change({ path: 'old.txt', op: 'create' }),
      change({ path: 'sweep.txt', unattributed: true }),
    ]);
    expect(lines).toEqual([
      'old.txt +3 -2 create',
      'sweep.txt +3 -2 reconciled',
    ]);
  });
});
