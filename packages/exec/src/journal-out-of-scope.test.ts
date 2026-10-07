// Out-of-scope path semantics (workspace out-of-scope paths,
// baseline/sweep).
//
// The mechanism existed but matched entries with exact string equality:
// an entry naming a directory only ever worked because the walk prunes a
// directory it matches, so the *matcher's* contract was never stated or
// pinned — and a path that reaches the sweep from anywhere but that one walk
// (a caller-supplied baseline, a baseline captured before the entry was
// declared) was journaled anyway. `isOutOfScope` is the shared rule both
// walks and the sweep's after-content loop now apply: an entry excludes the
// path itself and everything under it, path-boundary aware.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeFileBridge, type FileBridge } from './file-bridge.js';
import {
  captureBaseline,
  FileJournalStore,
  isOutOfScope,
  reconcile,
} from './journal.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tmpRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function workspace(): string {
  const root = tmpRoot('ws-oos-');
  writeFileSync(join(root, 'keep.txt'), 'keep\n');
  writeFileSync(join(root, 'change.txt'), 'before\n');
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist', 'a.js'), 'built\n');
  mkdirSync(join(root, 'dist', 'sub'));
  writeFileSync(join(root, 'dist', 'sub', 'b.js'), 'built\n');
  // A sibling that shares the entry's prefix but not its path boundary.
  writeFileSync(join(root, 'dist-x'), 'sibling\n');
  return root;
}

function journalStore(): FileJournalStore {
  return new FileJournalStore(tmpRoot('j-oos-'));
}

// Records every content read the walk/sweep performs, so "not journaled" can
// be checked as "never read" too — the sweep runs on the exit path, where a
// read of an excluded artifact is the cost this mechanism exists to avoid.
function recordingBridge(reads: string[]): FileBridge {
  const inner = createNodeFileBridge('/');
  return {
    ...inner,
    readTextFile: (path: string): string => {
      reads.push(path);
      return inner.readTextFile(path);
    },
    readBinaryFile: (path: string): Uint8Array => {
      reads.push(path);
      return inner.readBinaryFile(path);
    },
    readFileRange: (path: string, start: number, end: number): Uint8Array => {
      reads.push(path);
      return (
        inner.readFileRange?.(path, start, end) ?? inner.readBinaryFile(path)
      );
    },
  };
}

describe('out-of-scope matching', () => {
  it('matches the path itself and everything under it, path-boundary aware', () => {
    expect(isOutOfScope('dist', ['dist'])).toBe(true);
    expect(isOutOfScope('dist/a.js', ['dist'])).toBe(true);
    expect(isOutOfScope('dist/sub/b.js', ['dist'])).toBe(true);
    // Path-boundary aware: a sibling sharing the prefix is not under `dist`.
    expect(isOutOfScope('dist-x', ['dist'])).toBe(false);
    expect(isOutOfScope('distx/a.js', ['dist'])).toBe(false);
    // An exact-file entry keeps excluding exactly that file.
    expect(isOutOfScope('change.txt', ['change.txt'])).toBe(true);
    expect(isOutOfScope('change.txt.bak', ['change.txt'])).toBe(false);
    expect(isOutOfScope('keep.txt', ['dist'])).toBe(false);
    expect(isOutOfScope('anything', [])).toBe(false);
    // A nested directory entry excludes its own subtree only.
    expect(isOutOfScope('build/out', ['build/out'])).toBe(true);
    expect(isOutOfScope('build/out/x.js', ['build/out'])).toBe(true);
    expect(isOutOfScope('build/other.js', ['build/out'])).toBe(false);
  });

  it('excludes a directory entry and its children from the baseline', () => {
    const root = workspace();
    const baseline = captureBaseline(root, { outOfScope: ['dist'] });
    expect(Object.keys(baseline).sort()).toEqual([
      'change.txt',
      'dist-x',
      'keep.txt',
    ]);
    // The excluded directory itself is never baselined (it holds no content)
    // and its subtree is never hashed — the entry means "self + children".
    expect(baseline.dist).toBeUndefined();
    expect(baseline['dist/a.js']).toBeUndefined();
    expect(baseline['dist/sub/b.js']).toBeUndefined();
    // The prefix-sharing sibling is in scope, boundary included.
    expect(baseline['dist-x']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps exact-file behaviour: a file named like the entry is excluded', () => {
    const root = tmpRoot('ws-oos-file-');
    writeFileSync(join(root, 'dist'), 'a file, not a directory\n');
    writeFileSync(join(root, 'dist-x'), 'sibling\n');
    writeFileSync(join(root, 'keep.txt'), 'keep\n');
    const baseline = captureBaseline(root, { outOfScope: ['dist'] });
    expect(Object.keys(baseline).sort()).toEqual(['dist-x', 'keep.txt']);
  });

  it('does not read or journal a swept change under an out-of-scope directory', () => {
    const root = workspace();
    const journal = journalStore();
    const reads: string[] = [];
    const bridge = recordingBridge(reads);
    const baseline = captureBaseline(root, { outOfScope: ['dist'], bridge });
    expect(Object.keys(baseline).sort()).toEqual([
      'change.txt',
      'dist-x',
      'keep.txt',
    ]);

    // An external writer (a build, a formatter) moves files under dist/ and
    // in scope; only the in-scope change is a journal event.
    writeFileSync(join(root, 'dist', 'a.js'), 'rebuilt\n');
    writeFileSync(join(root, 'dist', 'sub', 'b.js'), 'rebuilt\n');
    writeFileSync(join(root, 'change.txt'), 'after\n');
    reads.length = 0;
    const added = reconcile(
      journal,
      baseline,
      root,
      { sessionId: 's1', agentId: 'root', timestamp: 1 },
      { outOfScope: ['dist'], bridge },
    );
    expect(added).toBe(1);
    expect(journal.entries().map((e) => e.path)).toEqual(['change.txt']);
    // The recorder is live (the in-scope change was read)...
    expect(reads.some((path) => path.endsWith('/change.txt'))).toBe(true);
    // ...but nothing under dist/ was: the sweep's after-content read is
    // bounded by scope, not only by size.
    expect(reads.some((path) => path.includes('/dist/'))).toBe(false);
  });

  it('does not journal an out-of-scope path that reached the baseline', () => {
    // The baseline predates the entry: captured with no out-of-scope paths
    // (an operator declaring `dist` after the run started, or a caller
    // sweeping against a stored baseline). The sweep must stay silent about
    // every path the entry excludes — in the delete direction too, where the
    // baseline is the only side that can name it.
    const root = workspace();
    const journal = journalStore();
    const baseline = captureBaseline(root);
    expect(baseline['dist/a.js']).toMatch(/^[0-9a-f]{64}$/);

    expect(baseline['dist/sub/b.js']).toMatch(/^[0-9a-f]{64}$/);

    writeFileSync(join(root, 'dist', 'a.js'), 'rebuilt\n');
    // The delete direction: only the baseline can name this path now.
    rmSync(join(root, 'dist', 'sub', 'b.js'));
    const added = reconcile(
      journal,
      baseline,
      root,
      { sessionId: 's1', agentId: 'root', timestamp: 1 },
      { outOfScope: ['dist'] },
    );
    expect(added).toBe(0);
    expect(journal.entries()).toEqual([]);
  });
});
