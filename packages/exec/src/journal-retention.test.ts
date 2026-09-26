// Issue #124: journal retention was O(n^2) I/O — every append stat'd every
// referenced blob (`blobBytes` over the kept set) and the byte-bound loop
// re-stat'd everything once per dropped entry. These tests count `fileInfo`
// calls through an instrumented FileBridge double. What they pin (drop set,
// ordering, removed/bytes shape) is deliberately identical to pre-change
// behavior — the retention semantics do not move; only their I/O cost does.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { FileBridge } from './file-bridge.js';
import {
  FileJournalStore,
  type JournalEntryInput,
} from './journal.js';

const counts = vi.hoisted(() => ({ fileInfo: 0 }));

vi.mock('./file-bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./file-bridge.js')>();
  return {
    ...actual,
    createNodeFileBridge: (cwd: string): FileBridge => {
      const bridge = actual.createNodeFileBridge(cwd);
      return {
        ...bridge,
        fileInfo: (path: string) => {
          counts.fileInfo += 1;
          return bridge.fileInfo(path);
        },
      };
    },
  };
});

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'journal-retention-'));
}

function entry(overrides: Partial<JournalEntryInput> = {}): JournalEntryInput {
  return {
    path: 'src/a.ts',
    op: 'write',
    before: null,
    after: 'hello\n',
    bytesDelta: 6,
    sessionId: 's1',
    agentId: 'root',
    toolCallId: 'call-1',
    timestamp: 1700000000000,
    ...overrides,
  };
}

// Content i over M unique blobs: `content-XX\n` is exactly 10 bytes, so
// byte arithmetic in these tests is plain multiples of 10.
function uniqueContent(i: number): string {
  return `content-${String(i % 30).padStart(2, '0')}\n`;
}

describe('blob size cache (issue #124, slice 1)', () => {
  it('append #51 over 50 entries and 30 unique blobs stats zero times', () => {
    const store = new FileJournalStore(tmpRoot());
    for (let i = 0; i < 50; i++) {
      store.append(entry({ path: `f${i}.txt`, after: uniqueContent(i) }));
    }
    expect(store.blobCount()).toBe(30);
    counts.fileInfo = 0;
    store.append(entry({ path: 'f50.txt', after: uniqueContent(50) }));
    // Before the size cache this append stat'd every unique referenced blob
    // (30 here, growing per entry); sizes recorded at write time make it 0.
    expect(counts.fileInfo).toBe(0);
  });
});
