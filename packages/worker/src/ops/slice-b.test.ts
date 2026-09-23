import { describe, expect, it } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import { createInvocation, MemoryMemoStore } from './memos.js';
import { callOperation, OPERATIONS } from './registry.js';
import type { OpContext, ToolInvocation } from './types.js';

function ctx(): OpContext {
  const env = new FakeExecutionEnv({});
  env.fs.writeFile('a.txt', 'hello world\nsecond line\n');
  env.fs.writeFile('sub/b.txt', 'hello again\nnothing\n');
  env.fs.writeFile('sub/deep/c.txt', 'unrelated\n');
  return { env, sessionId: 's1', agentId: 'a1' };
}

function inv(id = 'inv-1'): ToolInvocation {
  return createInvocation(
    { invocationId: id, operationId: 'op-1', turnId: 't-1' },
    new MemoryMemoStore(),
  );
}

describe('operation registry growth (issue #13, slice B)', () => {
  it('exposes exactly the expected operations', () => {
    expect(Object.keys(OPERATIONS).sort()).toEqual([
      'bash',
      'edit',
      'find',
      'grep',
      'ls',
      'read',
      'write',
    ]);
  });
});

describe('find operation (issue #13, slice B)', () => {
  it('walks recursively and filters by name substring', async () => {
    const out = await callOperation(
      'find',
      { root: '.', nameContains: 'b.' },
      inv(),
      ctx(),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.paths).toEqual(['sub/b.txt']);
      expect(out.result.truncated).toBe(false);
    }
  });

  it('filters by entry type', async () => {
    const out = await callOperation(
      'find',
      { root: '.', type: 'dir' },
      inv(),
      ctx(),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.paths).toEqual(['sub', 'sub/deep']);
    }
  });

  it('truncates at maxResults', async () => {
    const out = await callOperation(
      'find',
      { root: '.', maxResults: 2 },
      inv(),
      ctx(),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.paths.length).toBe(2);
      expect(out.result.truncated).toBe(true);
    }
  });

  it('rejects unknown arg keys', async () => {
    const out = await callOperation(
      'find',
      { root: '.', glob: '*.txt' },
      inv(),
      ctx(),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('invalid_args');
  });
});

describe('grep operation (issue #13, slice B)', () => {
  it('matches lines with numbers across files', async () => {
    const out = await callOperation(
      'grep',
      { pattern: 'hello', root: '.' },
      inv(),
      ctx(),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.matches).toEqual([
        { path: 'a.txt', line: 1, text: 'hello world' },
        { path: 'sub/b.txt', line: 1, text: 'hello again' },
      ]);
      expect(out.result.truncated).toBe(false);
    }
  });

  it('rejects invalid regex as a structured error', async () => {
    const out = await callOperation('grep', { pattern: '([' }, inv(), ctx());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('invalid_args');
  });

  it('caps matches with a truncation marker', async () => {
    const out = await callOperation(
      'grep',
      { pattern: 'line|hello|nothing|unrelated', root: '.', maxMatches: 2 },
      inv(),
      ctx(),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.matches.length).toBe(2);
      expect(out.result.truncated).toBe(true);
    }
  });
});
