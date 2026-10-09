// The sweep compares each path
// against its EXPECTED state — the last entry journaled during THIS run, or
// the boot baseline when there is none — never against the whole journal
// history. A same-run revert, a resumed session's change back to an older
// hash, and a repeat delete must all be journaled.
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { type BridgeFileInfo, createNodeFileBridge } from '../file-bridge.js';
import { captureBaseline } from './baseline.js';
import { sha256Hex } from './hash.js';
import { beginReconciliation } from './reconcile.js';
import type { FileJournalStore as Store } from './store.js';
import { FileJournalStore } from './store.js';
import { reconcile } from './sweep.js';

const NOW = 1_700_000_000_000;

function begin(store: Store, root: string, runId: string) {
  return beginReconciliation({
    store,
    root,
    runId,
    sessionId: 'sess-1',
    now: () => NOW,
  });
}

function toolWrite(
  store: Store,
  path: string,
  before: string | null,
  after: string | null,
  timestamp = NOW,
): void {
  store.append({
    path,
    op: after === null ? 'delete' : before === null ? 'create' : 'write',
    before,
    after,
    bytesDelta: 0,
    sessionId: 'sess-1',
    toolCallId: 'tc-1',
    timestamp,
  });
}

describe('reconcile expected state', () => {
  it('journals a same-run out-of-band revert to the baseline content', () => {
    const root = tempDir('ws-reconcile-a-');
    const store = new FileJournalStore(tempDir('j-reconcile-a-'));
    writeFileSync(join(root, 'a.txt'), 'H0\n');
    const run = begin(store, root, 'run-1');
    // A tool writes H0 → H1 …
    writeFileSync(join(root, 'a.txt'), 'H1\n');
    toolWrite(store, 'a.txt', 'H0\n', 'H1\n');
    // … then `git checkout a.txt` restores H0 behind interception.
    writeFileSync(join(root, 'a.txt'), 'H0\n');
    expect(run.sweep()).toBe(1);
    const entry = store.entries().at(-1);
    expect(entry?.unattributed).toBe(true);
    expect(entry?.op).toBe('write');
    expect(entry?.beforeHash).toBe(sha256Hex('H1\n'));
    expect(entry?.afterHash).toBe(sha256Hex('H0\n'));
    // Idempotent afterwards.
    expect(run.sweep()).toBe(0);
  });

  it('journals a resumed-session change back to a prior run’s after-hash', () => {
    const root = tempDir('ws-reconcile-b-');
    const store = new FileJournalStore(tempDir('j-reconcile-b-'));
    writeFileSync(join(root, 'a.txt'), 'H0\n');
    // Run 1: a tool writes H.
    const run1 = begin(store, root, 'run-1');
    writeFileSync(join(root, 'a.txt'), 'H\n');
    toolWrite(store, 'a.txt', 'H0\n', 'H\n');
    expect(run1.sweep()).toBe(0);
    // Between runs the user edits to H2.
    writeFileSync(join(root, 'a.txt'), 'H2\n');
    // Run 2 (same session journal): bash sets it back to H.
    const run2 = begin(store, root, 'run-2');
    writeFileSync(join(root, 'a.txt'), 'H\n');
    expect(run2.sweep()).toBe(1);
    const entry = store.entries().at(-1);
    expect(entry?.unattributed).toBe(true);
    expect(entry?.beforeHash).toBe(sha256Hex('H2\n'));
    expect(entry?.afterHash).toBe(sha256Hex('H\n'));
  });

  it('journals a run-2 delete of a file deleted in run 1 and recreated in between', () => {
    const root = tempDir('ws-reconcile-c-');
    const store = new FileJournalStore(tempDir('j-reconcile-c-'));
    writeFileSync(join(root, 'a.txt'), 'v1\n');
    const run1 = begin(store, root, 'run-1');
    rmSync(join(root, 'a.txt'));
    expect(run1.sweep()).toBe(1);
    expect(store.entries().at(-1)?.op).toBe('delete');
    // Recreated between runs.
    writeFileSync(join(root, 'a.txt'), 'v2\n');
    const run2 = begin(store, root, 'run-2');
    rmSync(join(root, 'a.txt'));
    expect(run2.sweep()).toBe(1);
    const entry = store.entries().at(-1);
    expect(entry?.op).toBe('delete');
    expect(entry?.beforeHash).toBe(sha256Hex('v2\n'));
    expect(entry?.afterHash).toBe(null);
  });

  it('journals the out-of-band delete of a file a tool created this run', () => {
    const root = tempDir('ws-reconcile-d-');
    const store = new FileJournalStore(tempDir('j-reconcile-d-'));
    const run = begin(store, root, 'run-1');
    writeFileSync(join(root, 'made.txt'), 'new\n');
    toolWrite(store, 'made.txt', null, 'new\n');
    rmSync(join(root, 'made.txt'));
    expect(run.sweep()).toBe(1);
    const entry = store.entries().at(-1);
    expect(entry?.op).toBe('delete');
    expect(entry?.beforeHash).toBe(sha256Hex('new\n'));
  });

  it('journals the out-of-band recreation of a file a tool deleted this run', () => {
    const root = tempDir('ws-reconcile-e-');
    const store = new FileJournalStore(tempDir('j-reconcile-e-'));
    writeFileSync(join(root, 'a.txt'), 'v1\n');
    const run = begin(store, root, 'run-1');
    rmSync(join(root, 'a.txt'));
    toolWrite(store, 'a.txt', 'v1\n', null);
    writeFileSync(join(root, 'a.txt'), 'v1\n');
    expect(run.sweep()).toBe(1);
    const entry = store.entries().at(-1);
    expect(entry?.op).toBe('create');
    expect(entry?.beforeHash).toBe(null);
    expect(entry?.afterHash).toBe(sha256Hex('v1\n'));
  });

  it('records nothing for a path whose last same-run entry matches the tree', () => {
    const root = tempDir('ws-reconcile-f-');
    const store = new FileJournalStore(tempDir('j-reconcile-f-'));
    writeFileSync(join(root, 'a.txt'), 'H0\n');
    const run = begin(store, root, 'run-1');
    writeFileSync(join(root, 'a.txt'), 'H1\n');
    toolWrite(store, 'a.txt', 'H0\n', 'H1\n');
    expect(run.sweep()).toBe(0);
  });

  it('still scopes to this run when retention dropped older entries', () => {
    const root = tempDir('ws-reconcile-g-');
    const dir = tempDir('j-reconcile-g-');
    const store = new FileJournalStore(dir);
    writeFileSync(join(root, 'a.txt'), 'H0\n');
    // Prior history in the journal (an older run's write to H1).
    toolWrite(store, 'a.txt', 'H0\n', 'H1\n', NOW - 10_000);
    toolWrite(store, 'b.txt', null, 'x\n');
    const run = begin(store, root, 'run-2');
    // Retention drops the head entry mid-run: the boot marker (b.txt)
    // shifts from index 1 to 0.
    store.enforceRetention({ maxAgeMs: 5_000, now: NOW });
    expect(store.entries()).toHaveLength(1);
    toolWrite(store, 'c.txt', null, 'y\n');
    writeFileSync(join(root, 'c.txt'), 'y\n');
    // c.txt matches its same-run entry and a.txt its baseline: nothing new.
    expect(run.sweep()).toBe(0);
  });
  it('keys absolute and ./-prefixed tool paths by their root-relative path', () => {
    // write/edit journal args.path verbatim, so an absolute
    // in-workspace path or a './' prefix must not become a phantom delete
    // candidate nor miss the expected state for its relative path.
    const root = tempDir('ws-reconcile-h-');
    const store = new FileJournalStore(tempDir('j-reconcile-h-'));
    writeFileSync(join(root, 'a.txt'), 'H0\n');
    const run = begin(store, root, 'run-1');
    writeFileSync(join(root, 'a.txt'), 'H1\n');
    toolWrite(store, join(root, 'a.txt'), 'H0\n', 'H1\n');
    writeFileSync(join(root, 'b.txt'), 'new\n');
    toolWrite(store, './b.txt', null, 'new\n');
    // An entry outside the workspace is never a sweep candidate.
    toolWrite(store, join(tempDir('out-reconcile-h-'), 'x.txt'), null, 'x\n');
    expect(run.sweep()).toBe(0);
  });

  it('records no delete for a tool-written path the walk skips but that still exists', () => {
    // Regression: sinceStart paths became delete candidates, but the
    // sweep walk never sees gitignored / `.git/` / `.kubic/` files, so they
    // read as absent from `current` — a FALSE unattributed delete for a
    // file that is right there on disk.
    const root = tempDir('ws-reconcile-i-');
    const store = new FileJournalStore(tempDir('j-reconcile-i-'));
    writeFileSync(join(root, '.gitignore'), 'dist/\n*.log\n');
    writeFileSync(join(root, 'keep.txt'), 'k\n');
    const run = begin(store, root, 'run-1');
    mkdirSync(join(root, 'dist'));
    mkdirSync(join(root, '.kubic'));
    const skipped: Array<[string, string]> = [
      ['dist/out.js', 'built\n'],
      ['debug.log', 'noise\n'],
      ['.kubic/state.json', '{}\n'],
    ];
    for (const [path, content] of skipped) {
      writeFileSync(join(root, path), content);
      toolWrite(store, path, null, content);
    }
    const before = store.entries().length;
    expect(run.sweep()).toBe(0);
    expect(store.entries()).toHaveLength(before);
  });

  it('still journals the delete of a skipped tool-written path once it is really gone', () => {
    const root = tempDir('ws-reconcile-j-');
    const store = new FileJournalStore(tempDir('j-reconcile-j-'));
    writeFileSync(join(root, '.gitignore'), 'dist/\n');
    const run = begin(store, root, 'run-1');
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'out.js'), 'built\n');
    toolWrite(store, 'dist/out.js', null, 'built\n');
    rmSync(join(root, 'dist', 'out.js'));
    expect(run.sweep()).toBe(1);
    const entry = store.entries().at(-1);
    expect(entry?.path).toBe('dist/out.js');
    expect(entry?.op).toBe('delete');
    expect(entry?.unattributed).toBe(true);
    expect(entry?.beforeHash).toBe(sha256Hex('built\n'));
    expect(entry?.afterHash).toBe(null);
  });

  it('journals the delete of a skipped tool-written path whose parent directory became a file (ENOTDIR)', () => {
    // lstat reports ENOTDIR — not ENOENT — when a path component is a regular
    // file. The path cannot exist, so this is a proven delete, not "cannot tell".
    const root = tempDir('ws-reconcile-n-');
    const store = new FileJournalStore(tempDir('j-reconcile-n-'));
    writeFileSync(join(root, '.gitignore'), 'dist/\n');
    const run = begin(store, root, 'run-1');
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'out.js'), 'built\n');
    toolWrite(store, 'dist/out.js', null, 'built\n');
    rmSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist'), 'now a file\n');
    // `dist/` (a directory rule) does not ignore the new FILE `dist`, so the
    // walk journals its create next to the proven delete.
    expect(run.sweep()).toBe(2);
    expect(
      store
        .entries()
        .slice(-2)
        .map((entry) => `${entry.op}:${entry.path}`)
        .sort(),
    ).toEqual(['create:dist', 'delete:dist/out.js']);
  });

  it('keeps the old rule for baseline paths: a regular file replaced by a link the walk skips is a delete', () => {
    // The still-exists guard is for paths ONLY a tool journaled; a boot
    // baseline key that the sweep walk does not see is journaled.
    const root = tempDir('ws-reconcile-l-');
    const store = new FileJournalStore(tempDir('j-reconcile-l-'));
    writeFileSync(join(root, 'a.txt'), 'v1\n');
    writeFileSync(join(root, 'keep.txt'), 'k\n');
    const run = begin(store, root, 'run-1');
    rmSync(join(root, 'a.txt'));
    symlinkSync('keep.txt', join(root, 'a.txt'));
    expect(run.sweep()).toBe(1);
    const entry = store.entries().at(-1);
    expect(entry?.path).toBe('a.txt');
    expect(entry?.op).toBe('delete');
    expect(entry?.beforeHash).toBe(sha256Hex('v1\n'));
  });

  it('records no delete for a tool-written path whose existence probe cannot answer', () => {
    // EACCES on a parent (not ENOENT) means "cannot tell": never record a
    // delete the sweep cannot prove.
    const root = tempDir('ws-reconcile-k-');
    const store = new FileJournalStore(tempDir('j-reconcile-k-'));
    writeFileSync(join(root, '.gitignore'), 'dist/\n');
    const inner = createNodeFileBridge('/');
    const bridge = {
      ...inner,
      exists: (path: string): boolean => {
        if (path === join(root, 'dist', 'out.js')) {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        }
        return inner.exists(path);
      },
    };
    const baseline = captureBaseline(root, { bridge });
    toolWrite(store, 'dist/out.js', null, 'built\n');
    const ctx = { sessionId: 'sess-1', agentId: 'root', timestamp: NOW };
    expect(reconcile(store, baseline, root, ctx, { bridge })).toBe(0);
    // The same journal with a probe that answers "gone" records the delete.
    const gone = { ...inner, exists: () => false };
    expect(reconcile(store, baseline, root, ctx, { bridge: gone })).toBe(1);
    expect(store.entries().at(-1)?.op).toBe('delete');
  });

  it('journals the delete of a tool-written file replaced by a directory', () => {
    const root = tempDir('ws-reconcile-o-');
    const store = new FileJournalStore(tempDir('j-reconcile-o-'));
    const run = begin(store, root, 'run-1');
    writeFileSync(join(root, 'x'), 'built\n');
    toolWrite(store, 'x', null, 'built\n');
    rmSync(join(root, 'x'));
    mkdirSync(join(root, 'x'));
    // An empty directory is no walk entry: the only event is x's delete.
    expect(run.sweep()).toBe(1);
    const entry = store.entries().at(-1);
    expect(entry?.path).toBe('x');
    expect(entry?.op).toBe('delete');
    expect(entry?.unattributed).toBe(true);
    expect(entry?.beforeHash).toBe(sha256Hex('built\n'));
  });

  it('journals the delete of a tool-written file replaced by a symlink', () => {
    const root = tempDir('ws-reconcile-p-');
    const store = new FileJournalStore(tempDir('j-reconcile-p-'));
    writeFileSync(join(root, 'keep.txt'), 'k\n');
    const run = begin(store, root, 'run-1');
    writeFileSync(join(root, 'y.txt'), 'built\n');
    toolWrite(store, 'y.txt', null, 'built\n');
    rmSync(join(root, 'y.txt'));
    symlinkSync('keep.txt', join(root, 'y.txt'));
    // The walk skips the link, so y.txt reads as absent from `current`.
    expect(run.sweep()).toBe(1);
    const entry = store.entries().at(-1);
    expect(entry?.path).toBe('y.txt');
    expect(entry?.op).toBe('delete');
    expect(entry?.beforeHash).toBe(sha256Hex('built\n'));
  });

  describe('the still-a-regular-file probe for a skipped tool-written path', () => {
    // dist/ is ignored, so the walk never sees dist/out.js whatever it is.
    function setup(fileInfo: (path: string) => BridgeFileInfo) {
      const root = tempDir('ws-reconcile-q-');
      const store = new FileJournalStore(tempDir('j-reconcile-q-'));
      writeFileSync(join(root, '.gitignore'), 'dist/\n');
      mkdirSync(join(root, 'dist'));
      writeFileSync(join(root, 'dist', 'out.js'), 'built\n');
      const inner = createNodeFileBridge('/');
      const target = join(root, 'dist', 'out.js');
      const bridge = {
        ...inner,
        fileInfo: (path: string): BridgeFileInfo =>
          path === target ? fileInfo(path) : inner.fileInfo(path),
      };
      const baseline = captureBaseline(root, { bridge });
      toolWrite(store, 'dist/out.js', null, 'built\n');
      const ctx = { sessionId: 'sess-1', agentId: 'root', timestamp: NOW };
      return () => reconcile(store, baseline, root, ctx, { bridge });
    }
    const info = (over: Partial<BridgeFileInfo>): BridgeFileInfo => ({
      name: 'out.js',
      path: '',
      isDirectory: false,
      isSymbolicLink: false,
      isFile: true,
      mode: 0o644,
      size: 6,
      mtimeMs: 0,
      ...over,
    });
    const failing = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };

    it('treats a classified regular file as present', () => {
      expect(setup(() => info({}))()).toBe(0);
    });

    it('treats an unclassified entry (isFile undefined) as a regular file', () => {
      expect(setup(() => info({ isFile: undefined }))()).toBe(0);
    });

    it.each([
      ['a directory', { isDirectory: true, isFile: false }],
      ['a symlink', { isSymbolicLink: true, isFile: false }],
      ['a FIFO/socket/device (isFile false)', { isFile: false }],
    ])(
      'reports %s as no longer the regular file: the delete is journaled',
      (_name, over) => {
        expect(setup(() => info(over))()).toBe(1);
      },
    );

    it.each(['ENOENT', 'ENOTDIR'])(
      'treats %s from the probe as gone',
      (code) => {
        expect(setup(failing(code))()).toBe(1);
      },
    );

    it('cannot tell on any other probe failure: present, no delete', () => {
      expect(setup(failing('EACCES'))()).toBe(0);
    });
  });
});
