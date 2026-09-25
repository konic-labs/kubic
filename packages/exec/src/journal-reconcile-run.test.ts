// Slice: run-scoped reconciliation lifecycle (issue #87; §42.1 mechanism 2,
// §42.5). The mechanism (captureBaseline/reconcile) landed in #17 but every
// caller was a test; this module is the wrapper the composition root calls:
// capture ONCE at lane boot, persist the hashes beside the session journal,
// sweep ONCE at run end.
// RED: packages/exec/src/journal-reconcile.ts does not exist yet.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileJournalStore, loadBaseline, sha256Hex } from './journal.js';
import { beginReconciliation } from './journal-reconcile.js';

const NOW = 1_700_000_000_000;

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'ws-reconcile-'));
  writeFileSync(join(root, 'keep.txt'), 'v1\n');
  writeFileSync(join(root, 'gone.txt'), 'bye\n');
  writeFileSync(join(root, 'ignored.log'), 'noise\n');
  writeFileSync(join(root, '.gitignore'), '*.log\n');
  return root;
}

function journalStore(): FileJournalStore {
  return new FileJournalStore(mkdtempSync(join(tmpdir(), 'j-reconcile-')));
}

describe('run-scoped reconciliation lifecycle (issue #87)', () => {
  it('captures the baseline at boot and persists it beside the session journal', () => {
    const root = workspace();
    const store = journalStore();
    const run = beginReconciliation({
      store,
      root,
      runId: 'sess-1',
      sessionId: 'sess-1',
      agentId: 'root',
      now: () => NOW,
    });
    expect(run.baselinePath).toBe(
      join(dirname(store.indexPath), 'baseline-sess-1.json'),
    );
    expect(existsSync(run.baselinePath)).toBe(true);
    expect(Object.keys(run.baseline).sort()).toEqual([
      '.gitignore',
      'gone.txt',
      'keep.txt',
    ]);
    // The persisted copy is the same map a later reader loads: the boot
    // capture is durable, not just in-memory.
    expect(loadBaseline(dirname(store.indexPath), 'sess-1')).toEqual(
      run.baseline,
    );
    expect(run.baseline['keep.txt']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sweeps after the last turn, recording unattributed entries with hashes only', () => {
    const root = workspace();
    const store = journalStore();
    const run = beginReconciliation({
      store,
      root,
      runId: 'sess-1',
      sessionId: 'sess-1',
      agentId: 'root',
      now: () => NOW,
    });
    // Whatever bypasses interception: an external writer, not a Kubic op.
    writeFileSync(join(root, 'keep.txt'), 'v2-external\n');
    writeFileSync(join(root, 'new.txt'), 'born\n');
    const gone = join(root, 'gone.txt');
    writeFileSync(gone, '');
    expect(run.sweep()).toBe(3);
    const entries = store.entries();
    expect(entries.every((e) => e.unattributed === true)).toBe(true);
    expect(entries.every((e) => e.toolCallId === null)).toBe(true);
    expect(entries.every((e) => e.sessionId === 'sess-1')).toBe(true);
    expect(entries.every((e) => e.timestamp === NOW)).toBe(true);
    const changed = entries.find((e) => e.path === 'keep.txt');
    if (changed === undefined) throw new Error('missing keep.txt entry');
    expect(changed.beforeHash).toBe(sha256Hex('v1\n'));
    // Out of scope by design: before-content is unknowable for these, so
    // the entry carries the hash and no retrievable pre-image.
    expect(store.readBefore(changed)).toBe(null);
    expect(store.readAfter(changed)).toBe('v2-external\n');
    const created = entries.find((e) => e.path === 'new.txt');
    expect(created?.op).toBe('create');
    expect(created?.beforeHash).toBe(null);
  });

  it('costs one metadata walk and zero blobs when nothing changed', () => {
    const root = workspace();
    const store = journalStore();
    const run = beginReconciliation({
      store,
      root,
      runId: 'sess-1',
      sessionId: 'sess-1',
      agentId: 'root',
      now: () => NOW,
    });
    // The capture stored hashes only: no before-blob, no after-blob.
    expect(store.blobCount()).toBe(0);
    expect(existsSync(join(dirname(store.indexPath), 'blobs'))).toBe(false);
    expect(run.sweep()).toBe(0);
    expect(store.entries()).toEqual([]);
  });

  it('excludes gitignored, out-of-scope and .kubic paths from both walks', () => {
    const root = workspace();
    mkdirSync(join(root, 'vendor'));
    writeFileSync(join(root, 'vendor', 'out.js'), 'gen\n');
    mkdirSync(join(root, '.kubic'));
    writeFileSync(join(root, '.kubic', 'state.json'), 'runtime\n');
    const store = journalStore();
    const run = beginReconciliation({
      store,
      root,
      runId: 'sess-1',
      sessionId: 'sess-1',
      agentId: 'root',
      outOfScope: ['vendor'],
      now: () => NOW,
    });
    expect(Object.keys(run.baseline).sort()).toEqual([
      '.gitignore',
      'gone.txt',
      'keep.txt',
    ]);
    for (const rel of [
      'keep.txt',
      'ignored.log',
      ['vendor', 'out.js'],
      ['.kubic', 'state.json'],
    ]) {
      writeFileSync(
        join(root, ...(Array.isArray(rel) ? rel : [rel])),
        'mutated\n',
      );
    }
    expect(run.sweep()).toBe(1);
    expect(store.entries().map((e) => e.path)).toEqual(['keep.txt']);
  });

  it('refuses a path-unsafe run id before writing any baseline file', () => {
    const root = workspace();
    const store = journalStore();
    const dir = dirname(store.indexPath);
    expect(() =>
      beginReconciliation({
        store,
        root,
        runId: '../evil',
        sessionId: 'sess-1',
        agentId: 'root',
        now: () => NOW,
      }),
    ).toThrow(/invalid run id/);
    expect(readdirSync(dir)).toEqual([]);
    expect(existsSync(join(dir, '..', 'evil.json'))).toBe(false);
  });

  it('adds nothing on a second sweep of an unchanged tree', () => {
    const root = workspace();
    const store = journalStore();
    const run = beginReconciliation({
      store,
      root,
      runId: 'sess-1',
      sessionId: 'sess-1',
      agentId: 'root',
      now: () => NOW,
    });
    writeFileSync(join(root, 'keep.txt'), 'v2\n');
    expect(run.sweep()).toBe(1);
    expect(run.sweep()).toBe(0);
    expect(store.entries()).toHaveLength(1);
  });
});
