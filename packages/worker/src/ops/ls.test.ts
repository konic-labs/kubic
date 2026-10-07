// `ls` bounds (bounded tool output): entries arrive
// sorted by name, at most the entry cap, with `truncated` + a notice naming
// the total when the cap stopped the listing. FakeExecutionEnv fs only —
// no real filesystem.
import { describe, expect, it } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import { lsOperation } from './ls.js';
import { createInvocation, MemoryMemoStore } from './memos.js';
import type { OpContext, ToolInvocation } from './types.js';

function ctx(): OpContext {
  return {
    env: new FakeExecutionEnv({}),
    sessionId: 's1',
    agentId: 'root',
  };
}

function inv(id: string): ToolInvocation {
  return createInvocation(
    { invocationId: id, operationId: id, turnId: 't-1' },
    new MemoryMemoStore(),
  );
}

describe('ls bounds', () => {
  it('caps a 2000-entry dir at sorted entries with truncated + notice', async () => {
    const context = ctx();
    // Created in reverse so the result must sort, not echo insertion.
    for (let i = 1999; i >= 0; i--) {
      const name = `file-${String(i).padStart(4, '0')}`;
      context.env.fs.writeFile(name, 'x');
    }
    const result = await lsOperation.execute(inv('l1'), {}, context);
    expect(result.entries.length).toBeLessThanOrEqual(500);
    expect(result.entries.length).toBe(500);
    expect(result.truncated).toBe(true);
    expect(result.notice).toContain('2000');
    const names = result.entries.map((entry) => entry.name);
    expect(names[0]).toBe('file-0000');
    expect(names).toEqual([...names].sort());
  });

  it('leaves a small dir alone: sorted, truncated false, no notice', async () => {
    const context = ctx();
    context.env.fs.writeFile('c.txt', 'x');
    context.env.fs.writeFile('a.txt', 'x');
    context.env.fs.writeFile('b.txt', 'x');
    const result = await lsOperation.execute(inv('l2'), {}, context);
    expect(result.entries.map((entry) => entry.name)).toEqual([
      'a.txt',
      'b.txt',
      'c.txt',
    ]);
    expect(result.truncated).toBe(false);
    expect(result.notice).toBeUndefined();
  });
});
