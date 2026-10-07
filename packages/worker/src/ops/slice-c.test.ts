import { describe, expect, it } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import { createInvocation, MemoryMemoStore } from './memos.js';
import { callOperation } from './registry.js';
import type { OpContext, ToolInvocation } from './types.js';

function ctx(): OpContext {
  const env = new FakeExecutionEnv({});
  env.fs.writeFile('a.txt', 'hello world\n');
  env.fs.writeFile('twice.txt', 'x ax bx\n');
  return { env, sessionId: 's1', agentId: 'a1' };
}

function inv(id = 'inv-1'): ToolInvocation {
  return createInvocation(
    { invocationId: id, operationId: 'op-1', turnId: 't-1' },
    new MemoryMemoStore(),
  );
}

describe('write operation', () => {
  it('creates a file with afterHash and bytesDelta', async () => {
    const out = await callOperation(
      'write',
      { path: 'new.txt', content: 'hi\n' },
      inv(),
      ctx(),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.beforeHash).toBeNull();
      expect(out.result.afterHash).toMatch(/^[0-9a-f]{64}$/);
      expect(out.result.bytesDelta).toBe(3);
    }
  });

  it('overwrites atomically with before/after hashes', async () => {
    const c = ctx();
    const before = await callOperation('read', { path: 'a.txt' }, inv(), c);
    expect(before.ok).toBe(true);
    const out = await callOperation(
      'write',
      { path: 'a.txt', content: 'changed\n' },
      inv(),
      c,
    );
    expect(out.ok).toBe(true);
    if (out.ok && before.ok) {
      expect(out.result.beforeHash).not.toBeNull();
      expect(out.result.beforeHash).not.toBe(out.result.afterHash);
      expect(out.result.bytesDelta).toBe(
        'changed\n'.length - 'hello world\n'.length,
      );
      expect(c.env.fs.readFile('a.txt')).toBe('changed\n');
    }
  });

  it('leaves no tmp file behind', async () => {
    const c = ctx();
    const out = await callOperation(
      'write',
      { path: 'a.txt', content: 'v2\n' },
      inv(),
      c,
    );
    expect(out.ok).toBe(true);
    const ls = await callOperation('ls', { path: '.' }, inv(), c);
    expect(ls.ok).toBe(true);
    if (ls.ok) {
      // Exactly the fixture files: no tmp sibling of any name survives.
      expect(ls.result.entries.map((e) => e.name).sort()).toEqual([
        'a.txt',
        'twice.txt',
      ]);
    }
  });

  it('measures bytesDelta in UTF-8 bytes, not UTF-16 units', async () => {
    const out = await callOperation(
      'write',
      { path: 'uni.txt', content: 'héllo\n' },
      inv(),
      ctx(),
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.bytesDelta).toBe(7);
  });

  it('rejects unknown arg keys', async () => {
    const out = await callOperation(
      'write',
      { path: 'a.txt', content: 'x', mode: '777' },
      inv(),
      ctx(),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('invalid_args');
  });
});

describe('edit operation', () => {
  it('replaces exactly once with hashes', async () => {
    const c = ctx();
    const out = await callOperation(
      'edit',
      { path: 'a.txt', oldText: 'world', newText: 'there' },
      inv(),
      c,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.replacements).toBe(1);
      expect(out.result.beforeHash).not.toBe(out.result.afterHash);
      expect(c.env.fs.readFile('a.txt')).toBe('hello there\n');
    }
  });

  it('refuses ambiguous matches unless expected', async () => {
    const out = await callOperation(
      'edit',
      { path: 'twice.txt', oldText: 'x', newText: 'y' },
      inv(),
      ctx(),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('ambiguous_match');
  });

  it('honours an explicit expectCount', async () => {
    const c = ctx();
    const out = await callOperation(
      'edit',
      { path: 'twice.txt', oldText: 'x', newText: 'y', expectCount: 3 },
      inv(),
      c,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.replacements).toBe(3);
      expect(c.env.fs.readFile('twice.txt')).toBe('y ay by\n');
    }
  });

  it('reports no match as a structured error', async () => {
    const out = await callOperation(
      'edit',
      { path: 'a.txt', oldText: 'zzz', newText: 'y' },
      inv(),
      ctx(),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('no_match');
  });
});
