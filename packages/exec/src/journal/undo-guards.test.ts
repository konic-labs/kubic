// Undo containment and the walk's link handling.
//
// Undo of an agent-created file is a forced `rm`, and its containment was
// exercised only indirectly, from the agent package. The guards that make it
// safe — `guardTarget` before the remove, the create-only predicate, the
// symlink refusal — had no exec-package test of their own, and neither did the
// baseline walk's symlink skip or `probeFileState`'s shape handling. A
// regression in any of them could delete a file outside the workspace (or
// through a symlinked directory) with nothing to catch it.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureBaseline } from './baseline.js';
import { sha256Hex } from './hash.js';
import type { RestoreResult } from './restore.js';
import {
  isUndoableCreate,
  probeFileState,
  removeCreatedEntry,
  restoreEntry,
} from './restore.js';
import { FileJournalStore } from './store.js';
import type { JournalEntry, JournalEntryInput } from './types.js';

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

function entry(overrides: Partial<JournalEntryInput> = {}): JournalEntryInput {
  return {
    path: 'new.txt',
    op: 'create',
    before: null,
    after: 'made\n',
    bytesDelta: 5,
    sessionId: 's1',
    toolCallId: 'call-1',
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

function seed(input: JournalEntryInput): {
  store: FileJournalStore;
  entry: JournalEntry;
} {
  const store = new FileJournalStore(tmpRoot('j-'), { durable: false });
  return { store, entry: store.append(input) };
}

// `RestoreResult` is a union: narrow to the refusal branch once, so the
// reason can be asserted without a non-null assertion at every site.
function refusal(result: RestoreResult): string {
  if (result.restored) throw new Error('expected a refusal, got a restore');
  return result.reason;
}

describe('removeCreatedEntry containment', () => {
  it('refuses a parent-relative escape and the outside file survives', () => {
    const root = tmpRoot('ws-');
    const outside = tmpRoot('outside-');
    writeFileSync(join(outside, 'outside.txt'), 'keep me\n');
    const { entry: created } = seed(
      entry({ path: '../outside/outside.txt', after: 'keep me\n' }),
    );
    const result = removeCreatedEntry(created, root);
    expect(refusal(result)).toMatch(/escapes the workspace root/);
    expect(readFileSync(join(outside, 'outside.txt'), 'utf8')).toBe(
      'keep me\n',
    );
  });

  it('refuses an absolute path and the outside file survives', () => {
    const root = tmpRoot('ws-');
    const outside = tmpRoot('outside-');
    const target = join(outside, 'absolute.txt');
    writeFileSync(target, 'keep me\n');
    const { entry: created } = seed(
      entry({ path: target, after: 'keep me\n' }),
    );
    const result = removeCreatedEntry(created, root);
    expect(refusal(result)).toMatch(/escapes the workspace root/);
    expect(existsSync(target)).toBe(true);
  });

  it('refuses a path under a symlinked directory and the outside file survives', () => {
    const root = tmpRoot('ws-');
    const outside = tmpRoot('outside-');
    writeFileSync(join(outside, 'linked.txt'), 'keep me\n');
    symlinkSync(outside, join(root, 'linked'));
    const { entry: created } = seed(
      entry({ path: 'linked/linked.txt', after: 'keep me\n' }),
    );
    const result = removeCreatedEntry(created, root);
    expect(refusal(result)).toMatch(/crosses a symlink/);
    expect(readFileSync(join(outside, 'linked.txt'), 'utf8')).toBe('keep me\n');
  });

  it('refuses a non-create entry and the file survives', () => {
    const root = tmpRoot('ws-');
    writeFileSync(join(root, 'edited.txt'), 'edited\n');
    // (a) a write entry with a before-side is an edit, not a create
    const edited = seed(
      entry({
        path: 'edited.txt',
        op: 'write',
        before: 'old\n',
        after: 'edited\n',
      }),
    );
    // (b) a create-shaped entry with a hash-only before is not a create either
    const hashOnly = seed(
      entry({
        path: 'edited.txt',
        op: 'create',
        beforeHash: sha256Hex('old\n'),
      }),
    );
    // (c) an unattributed entry (the sweep could not tell who wrote it)
    const unattributed = seed(
      entry({ path: 'edited.txt', unattributed: true }),
    );
    for (const { entry: candidate } of [edited, hashOnly, unattributed]) {
      const result = removeCreatedEntry(candidate, root);
      expect(refusal(result)).toMatch(/not an agent-created file entry/);
      expect(readFileSync(join(root, 'edited.txt'), 'utf8')).toBe('edited\n');
    }
  });

  it('removes a genuine create and nothing else', () => {
    const root = tmpRoot('ws-');
    writeFileSync(join(root, 'new.txt'), 'made\n');
    writeFileSync(join(root, 'sibling.txt'), 'sibling\n');
    const { entry: created } = seed(entry());
    expect(removeCreatedEntry(created, root).restored).toBe(true);
    expect(existsSync(join(root, 'new.txt'))).toBe(false);
    expect(readFileSync(join(root, 'sibling.txt'), 'utf8')).toBe('sibling\n');
  });
});

describe('isUndoableCreate', () => {
  it('accepts only an attributed create with a null before and a real after', () => {
    const shapes: Array<Partial<JournalEntryInput>> = [
      { op: 'create', beforeHash: null, after: 'x\n' },
      { op: 'create', beforeHash: sha256Hex('x\n'), after: 'x\n' },
      { op: 'create', before: 'x\n', after: 'x\n' },
      { op: 'create', after: null, afterHash: null },
      { op: 'create', after: 'x\n', unattributed: true },
      { op: 'write', after: 'x\n' },
      { op: 'delete', before: 'x\n', after: null },
    ];
    const verdicts = shapes.map((overrides) => {
      const { entry: made } = seed(entry(overrides));
      return isUndoableCreate(made);
    });
    expect(verdicts).toEqual([true, false, false, false, false, false, false]);
  });
});

describe('baseline symlink handling', () => {
  it('ignores a symlink to a file and a symlink to a directory outside root', () => {
    const root = tmpRoot('ws-');
    const outside = tmpRoot('outside-');
    writeFileSync(join(root, 'real.txt'), 'real\n');
    writeFileSync(join(outside, 'secret.txt'), 'secret\n');
    mkdirSync(join(outside, 'dir'));
    writeFileSync(join(outside, 'dir', 'nested.txt'), 'nested\n');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
    symlinkSync(join(outside, 'dir'), join(root, 'linkdir'));
    const baseline = captureBaseline(root);
    // Neither link nor anything behind it is walked: a link is not a file
    // Kubic can hash, and following it would journal content outside the root.
    expect(Object.keys(baseline)).toEqual(['real.txt']);
    expect(baseline['real.txt']).toBe(sha256Hex('real\n'));
  });
});

describe('probeFileState shapes', () => {
  it('follows a symlink for its content hash, and stays inside on restore', () => {
    const root = tmpRoot('ws-');
    const outside = tmpRoot('outside-');
    writeFileSync(join(outside, 'secret.txt'), 'secret\n');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
    // Documented posture: the probe reads CONTENT (a verdict input), it is
    // not the containment guard. The walk never hashes a symlink, so the only
    // paths that reach the probe are ones the journal already recorded, and a
    // restore writes to the link's own path (replacing the link with a
    // regular file) rather than through it — `restoreEntry` keeps the target
    // mode for a regular file only, and the rename replaces the link itself.
    expect(probeFileState(root, 'link.txt')).toEqual({
      missing: false,
      hash: sha256Hex('secret\n'),
    });
  });

  it('reports a directory as present with no hash', () => {
    const root = tmpRoot('ws-');
    mkdirSync(join(root, 'sub'));
    expect(probeFileState(root, 'sub')).toEqual({ missing: false, hash: null });
  });

  it('reports an unreadable file as present with no hash', () => {
    const root = tmpRoot('ws-');
    writeFileSync(join(root, 'secret.txt'), 'secret\n');
    chmodSync(join(root, 'secret.txt'), 0o000);
    try {
      expect(probeFileState(root, 'secret.txt')).toEqual({
        missing: false,
        hash: null,
      });
    } finally {
      chmodSync(join(root, 'secret.txt'), 0o644);
    }
  });

  it('reports a missing path as missing', () => {
    const root = tmpRoot('ws-');
    expect(probeFileState(root, 'nope.txt')).toEqual({
      missing: true,
      hash: null,
    });
  });
});

describe('restore through a symlinked parent', () => {
  it('refuses a journaled edit reached through a symlink, with the reason', () => {
    const root = tmpRoot('ws-');
    const outside = tmpRoot('outside-');
    writeFileSync(join(outside, 'real.txt'), 'outside\n');
    symlinkSync(outside, join(root, 'linked'));
    const { store, entry: journaled } = seed(
      entry({
        path: 'linked/real.txt',
        op: 'write',
        before: 'outside\n',
        after: 'journaled\n',
      }),
    );
    const result = restoreEntry(store, journaled, root);
    expect(refusal(result)).toMatch(/crosses a symlink/);
    // The outside file is untouched: no write through the link.
    expect(readFileSync(join(outside, 'real.txt'), 'utf8')).toBe('outside\n');
  });
});
