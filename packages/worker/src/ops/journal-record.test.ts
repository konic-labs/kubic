// Slice B: write/edit interception into the journal (issue #17; §42.1).
// RED: OpContext carries no journal and no toolCallId yet.
import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileJournalStore } from '../../../exec/src/journal.js';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import { createInvocation, MemoryMemoStore } from './memos.js';
import { callOperation } from './registry.js';
import type { OpContext, ToolInvocation } from './types.js';

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
    const journal = new FileJournalStore(mkdtempSync(join(tmpdir(), 'j-')));
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
    expect(recorded?.op).toBe('write');
    expect(recorded?.toolCallId).toBe('call-9');
    expect(recorded?.sessionId).toBe('s1');
    if (out.ok) {
      expect(recorded?.beforeHash).toBe(out.result.beforeHash);
      expect(recorded?.afterHash).toBe(out.result.afterHash);
      expect(journal.readAfter(recorded!)).toBe('hi\n');
    }
  });

  it('records creates and edits with the right op', async () => {
    const journal = new FileJournalStore(mkdtempSync(join(tmpdir(), 'j-')));
    const c = ctx(journal);
    await callOperation('write', { path: 'new.txt', content: 'n\n' }, inv(), c);
    await callOperation(
      'edit',
      { path: 'a.txt', oldText: 'world', newText: 'there' },
      inv(),
      c,
    );
    const ops = journal.entries().map((e) => e.op);
    expect(ops).toEqual(['create', 'edit']);
  });

  it('writes fine without a journal configured', async () => {
    const out = await callOperation(
      'write',
      { path: 'a.txt', content: 'hi\n' },
      inv(),
      ctx(),
    );
    expect(out.ok).toBe(true);
  });

  it('fails loud — never silent — when the journal cannot record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'j-'));
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
});
