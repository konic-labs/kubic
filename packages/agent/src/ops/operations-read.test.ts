// The operation registry and the read-family operations (read, ls) over a
// fake execution env.
import { FakeExecutionEnv } from '@kubic/exec/test-support/fake-env';
import { describe, expect, it, vi } from 'vitest';
import { createInvocation, MemoryMemoStore } from './memos.js';
import { callOperation } from './registry.js';
import type { OpContext, ToolInvocation } from './types.js';

function ctx(): OpContext {
  const env = new FakeExecutionEnv({});
  env.fs.writeFile('a.txt', 'l1\nl2\nl3\n');
  env.fs.writeFile('sub/b.txt', 'x\n');
  return { env, sessionId: 's1', agentId: 'a1' };
}

function inv(id = 'inv-1'): ToolInvocation {
  return createInvocation(
    { invocationId: id, operationId: 'op-1', turnId: 't-1' },
    new MemoryMemoStore(),
  );
}

describe('operation registry', () => {
  it('routes read by name and threads invocation ids', async () => {
    const out = await callOperation('read', { path: 'a.txt' }, inv(), ctx());
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.invocation.invocationId).toBe('inv-1');
      expect(out.result.content).toContain('l1');
    }
  });

  it('makes unknown tools uncallable with a structured error', async () => {
    const out = await callOperation('drop-database', {}, inv(), ctx());
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('unknown_tool');
      expect(out.error.message).toBe('unknown tool: drop-database');
    }
  });

  it('converts invalid args to structured errors, not throws', async () => {
    const out = await callOperation('read', { path: 42 }, inv(), ctx());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('invalid_args');
  });
});

describe('read operation', () => {
  it('reads through the ranged path when the seam offers readFileRange', async () => {
    const c = ctx();
    const ranged = vi.spyOn(c.env.fs, 'readFileRange');
    const out = await callOperation('read', { path: 'a.txt' }, inv(), c);
    expect(out.ok).toBe(true);
    // The fake implements readFileRange, so even a plain read seeks in
    // byte chunks instead of taking the whole-file fallback.
    expect(ranged).toHaveBeenCalled();
  });
  it('reads with offset/limit and reports totals', async () => {
    const out = await callOperation(
      'read',
      { path: 'a.txt', offset: 2, limit: 1 },
      inv(),
      ctx(),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.content).toBe('l2\n');
      expect(out.result.totalLines).toBe(3);
      expect(out.result.truncated).toBe(false);
    }
  });

  it('rejects unknown arg keys (strict sampling)', async () => {
    const out = await callOperation(
      'read',
      { path: 'a.txt', model: 'evil' },
      inv(),
      ctx(),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('invalid_args');
      expect(out.error.message).toMatch(/unknown.*model|model.*unknown/i);
    }
  });

  it('marks truncation when the file exceeds the cap', async () => {
    const c = ctx();
    c.env.fs.writeFile(
      'big.txt',
      Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n'),
    );
    const out = await callOperation('read', { path: 'big.txt' }, inv(), c);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.truncated).toBe(true);
      expect(out.result.totalLines).toBe(3000);
    }
  });

  it('returns a structured error for missing files', async () => {
    const out = await callOperation('read', { path: 'nope.txt' }, inv(), ctx());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('not_found');
  });
});

describe('ls operation', () => {
  it('lists entries with kinds', async () => {
    const out = await callOperation('ls', { path: '.' }, inv(), ctx());
    expect(out.ok).toBe(true);
    if (out.ok) {
      const names = out.result.entries.map((e) => e.name).sort();
      expect(names).toEqual(['a.txt', 'sub']);
      expect(
        out.result.entries.find((e) => e.name === 'sub')?.isDirectory,
      ).toBe(true);
    }
  });

  it('skips entries that vanish between list and stat', async () => {
    const c = ctx();
    Object.assign(c.env.fs, { listDir: () => ['ghost.txt'] });
    const out = await callOperation('ls', { path: '.' }, inv(), c);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.entries).toEqual([]);
  });
});
