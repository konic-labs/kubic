// Slice B: write/edit interception into the journal (issue #17; §42.1).
// RED: OpContext carries no journal and no toolCallId yet.
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import { FileJournalStore } from '../../../exec/src/journal.js';
import { createInvocation, MemoryMemoStore } from './memos.js';
import { callOperation } from './registry.js';
import type { OpContext, ToolInvocation } from './types.js';

const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function journalDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'j-'));
  scratchDirs.push(dir);
  return dir;
}

function ctx(journal?: FileJournalStore): OpContext {
  const env = new FakeExecutionEnv({});
  env.fs.writeFile('a.txt', 'hello world\n');
  return {
    env,
    sessionId: 's1',
    agentId: 'root',
    toolCallId: 'call-9',
    ...(journal === undefined ? {} : { journal }),
  };
}

function inv(): ToolInvocation {
  return createInvocation(
    { invocationId: 'inv-1', operationId: 'op-1', turnId: 't-1' },
    new MemoryMemoStore(),
  );
}

describe('journal interception (issue #17, slice B)', () => {
  it('records write with op hashes and the lane toolCallId', async () => {
    const journal = new FileJournalStore(journalDir());
    const c = ctx(journal);
    const out = await callOperation(
      'write',
      { path: 'a.txt', content: 'hi\n' },
      inv(),
      c,
    );
    expect(out.ok).toBe(true);
    const entries = journal.entries();
    expect(entries).toHaveLength(1);
    const recorded = entries[0];
    if (recorded === undefined) throw new Error('missing journal entry');
    expect(recorded?.op).toBe('write');
    expect(recorded?.toolCallId).toBe('call-9');
    expect(recorded?.sessionId).toBe('s1');
    if (out.ok) {
      expect(recorded?.beforeHash).toBe(out.result.beforeHash);
      expect(recorded?.afterHash).toBe(out.result.afterHash);
      expect(journal.readAfter(recorded)).toBe('hi\n');
    }
  });

  it('records creates and edits with the right op', async () => {
    const journal = new FileJournalStore(journalDir());
    const c = ctx(journal);
    const created = await callOperation(
      'write',
      { path: 'new.txt', content: 'n\n' },
      inv(),
      c,
    );
    expect(created.ok).toBe(true);
    const edited = await callOperation(
      'edit',
      { path: 'a.txt', oldText: 'world', newText: 'there' },
      inv(),
      c,
    );
    expect(edited.ok).toBe(true);
    const ops = journal.entries().map((e) => e.op);
    expect(ops).toEqual(['create', 'edit']);
  });

  it('writes fine without a journal configured', async () => {
    const c = ctx();
    const out = await callOperation(
      'write',
      { path: 'a.txt', content: 'hi\n' },
      inv(),
      c,
    );
    expect(out.ok).toBe(true);
    expect(c.env.fs.readFile('a.txt')).toBe('hi\n');
  });

  it('fails loud — never silent — when the journal cannot record', async () => {
    const dir = journalDir();
    const journal = new FileJournalStore(dir);
    chmodSync(dir, 0o555);
    try {
      const out = await callOperation(
        'write',
        { path: 'a.txt', content: 'hi\n' },
        inv(),
        ctx(journal),
      );
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error.code).toBe('journal_failed');
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  // Issue #348: an entry too large for the journal is refused by the store,
  // and the tool must surface that as journal_failed with the target file
  // untouched — the journal-first order is what makes the refusal safe.
  it('surfaces an over-bound entry as journal_failed, file untouched', async () => {
    const journal = new FileJournalStore(journalDir(), { maxBytes: 1000 });
    const c = ctx(journal);
    const out = await callOperation(
      'write',
      { path: 'big.txt', content: 'x'.repeat(2000) },
      inv(),
      c,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('journal_failed');
      // The bound is in the message the model sees, not just a generic
      // "journal failed".
      expect(out.error.message).toContain('1000');
    }
    expect(() => c.env.fs.readFile('big.txt')).toThrow();
  });
});

describe('journal tool attribution (issue #335)', () => {
  it("records the intercepting tool's name on the entry", async () => {
    const journal = new FileJournalStore(journalDir());
    const c = ctx(journal);
    const edited = await callOperation(
      'edit',
      { path: 'a.txt', oldText: 'world', newText: 'there' },
      inv(),
      c,
    );
    expect(edited.ok).toBe(true);
    const written = await callOperation(
      'write',
      { path: 'new.txt', content: 'n\n' },
      inv(),
      c,
    );
    expect(written.ok).toBe(true);
    const names = journal.entries().map((e) => e.toolName);
    expect(names).toEqual(['edit', 'write']);
  });
});
