// Baseline + sweep walk races.
//
// The walk must never turn "I could not look" into "it is gone". Three races
// it must survive:
//   - one entry vanishing between readdirSync and lstat must not throw ENOENT
//     for the whole listing and drop the entire subtree from the baseline/sweep
//     (siblings included).
//   - a hash failure must not count as "vanished" whatever its cause: `chmod 000
//     secret.txt` must not read as a delete of a file that still exists.
//   - a directory listing that fails at sweep time must not drop its subtree from
//     `current`, or reconcile records every file under it as deleted.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureBaseline,
  FileJournalStore,
  reconcile,
  sha256Hex,
  UNREADABLE_HASH,
} from './journal.js';

// Make one path vanish between readdirSync and lstatSync: exactly the race
// the node bridge's own listing must survive.
const hooks = vi.hoisted(() => ({
  vanishOnce: null as null | string,
  vanishDirOnce: null as null | string,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    lstatSync: (path: string, ...rest: unknown[]) => {
      if (hooks.vanishOnce !== null && path.endsWith(hooks.vanishOnce)) {
        hooks.vanishOnce = null;
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      }
      return actual.lstatSync(path, ...(rest as []));
    },
    // The other half of the same race: a directory listed by its parent and
    // gone by the time the recursion lists it.
    readdirSync: (path: string, ...rest: unknown[]) => {
      if (hooks.vanishDirOnce !== null && path.endsWith(hooks.vanishDirOnce)) {
        hooks.vanishDirOnce = null;
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      }
      return actual.readdirSync(path, ...(rest as []));
    },
  };
});

const roots: string[] = [];

afterEach(() => {
  hooks.vanishOnce = null;
  hooks.vanishDirOnce = null;
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tmpRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function ctx(): {
  sessionId: string;
  agentId: string;
  timestamp: number;
} {
  return { sessionId: 's1', agentId: 'root', timestamp: 100 };
}

describe('baseline walk races', () => {
  it('keeps siblings in the baseline when one entry vanishes mid-listing', () => {
    const root = tmpRoot('ws-');
    writeFileSync(join(root, 'a.txt'), 'a\n');
    writeFileSync(join(root, 'vanish.txt'), 'gone\n');
    hooks.vanishOnce = 'vanish.txt';
    const baseline = captureBaseline(root);
    // The vanished entry is simply absent; its sibling is hashed as usual.
    expect(Object.keys(baseline)).toEqual(['a.txt']);
    expect(baseline['a.txt']).toBe(sha256Hex('a\n'));
  });

  it('records a delete for a subtree that vanished before its listing', () => {
    const root = tmpRoot('ws-');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'a\n');
    writeFileSync(join(root, 'top.txt'), 'top\n');
    const baseline = captureBaseline(root);
    expect(Object.keys(baseline).sort()).toEqual(['src/a.ts', 'top.txt']);
    // The directory is listed by its parent and gone by the time the walk
    // recurses into it: ENOENT, not EACCES. That is a real disappearance —
    // carrying the subtree forward would lose the deletes silently, and the
    // next baseline would not know those paths either.
    hooks.vanishDirOnce = 'src';
    const store = new FileJournalStore(tmpRoot('j-'));
    const added = reconcile(store, baseline, root, ctx());
    expect(added).toBe(1);
    expect(store.entries().map((e) => [e.path, e.op])).toEqual([
      ['src/a.ts', 'delete'],
    ]);
  });

  it('does not record a delete for a baseline file that became unreadable', () => {
    const root = tmpRoot('ws-');
    writeFileSync(join(root, 'secret.txt'), 'secret\n');
    writeFileSync(join(root, 'public.txt'), 'public\n');
    const baseline = captureBaseline(root);
    expect(baseline['secret.txt']).toBe(sha256Hex('secret\n'));
    chmodSync(join(root, 'secret.txt'), 0o000);
    try {
      const store = new FileJournalStore(tmpRoot('j-'));
      const added = reconcile(store, baseline, root, ctx());
      // The file is still there; only its content could not be observed.
      expect(added).toBe(0);
      expect(store.entries()).toEqual([]);
    } finally {
      chmodSync(join(root, 'secret.txt'), 0o644);
    }
  });

  it('carries a subtree forward when its listing fails at sweep time', () => {
    const root = tmpRoot('ws-');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'a\n');
    writeFileSync(join(root, 'src', 'b.ts'), 'b\n');
    writeFileSync(join(root, 'top.txt'), 'top\n');
    const baseline = captureBaseline(root);
    expect(Object.keys(baseline).sort()).toEqual([
      'src/a.ts',
      'src/b.ts',
      'top.txt',
    ]);
    chmodSync(join(root, 'src'), 0o000);
    try {
      const store = new FileJournalStore(tmpRoot('j-'));
      const added = reconcile(store, baseline, root, ctx());
      // The subtree's state is unknown, so its previous hashes stand in:
      // no delete, no invented change.
      expect(added).toBe(0);
      expect(store.entries()).toEqual([]);
    } finally {
      chmodSync(join(root, 'src'), 0o755);
    }
  });

  it('still records a delete for a file that really vanished', () => {
    const root = tmpRoot('ws-');
    writeFileSync(join(root, 'gone.txt'), 'gone\n');
    const baseline = captureBaseline(root);
    unlinkSync(join(root, 'gone.txt'));
    const store = new FileJournalStore(tmpRoot('j-'));
    const added = reconcile(store, baseline, root, ctx());
    expect(added).toBe(1);
    expect(store.entries().map((e) => [e.path, e.op])).toEqual([
      ['gone.txt', 'delete'],
    ]);
  });

  it('records an honest create when an unreadable path becomes readable', () => {
    const root = tmpRoot('ws-');
    writeFileSync(join(root, 'later.txt'), 'content\n');
    chmodSync(join(root, 'later.txt'), 0o000);
    let baseline: ReturnType<typeof captureBaseline>;
    try {
      baseline = captureBaseline(root);
    } finally {
      chmodSync(join(root, 'later.txt'), 0o644);
    }
    // At boot the path was seen but not read: the sentinel, never a hash.
    expect(baseline['later.txt']).toBe(UNREADABLE_HASH);
    const store = new FileJournalStore(tmpRoot('j-'));
    const added = reconcile(store, baseline, root, ctx());
    expect(added).toBe(1);
    const entry = store.entries()[0];
    // No invented before-hash (the sentinel never reaches the journal), and
    // the after-side is the content that is actually there.
    expect(entry?.op).toBe('create');
    expect(entry?.beforeHash).toBeNull();
    expect(entry?.afterHash).toBe(sha256Hex('content\n'));
    expect(entry === undefined ? null : store.readAfter(entry)).toBe(
      'content\n',
    );
  });

  it('leaves the file content alone through every race', () => {
    // The races are read-side only: nothing on the baseline path may write, move or
    // delete a workspace file.
    const root = tmpRoot('ws-');
    writeFileSync(join(root, 'keep.txt'), 'keep\n');
    const baseline = captureBaseline(root);
    chmodSync(join(root, 'keep.txt'), 0o000);
    try {
      const store = new FileJournalStore(tmpRoot('j-'));
      reconcile(store, baseline, root, ctx());
    } finally {
      chmodSync(join(root, 'keep.txt'), 0o644);
    }
    expect(readFileSync(join(root, 'keep.txt'), 'utf8')).toBe('keep\n');
  });
});
