import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessSnapshot } from '@kubic/exec/env';
import { FakeExecutionEnv, NodeExecutionEnv } from '@kubic/exec/env';
import { MemoryCheckpointStore } from '@kubic/exec/test-support/env-fakes';
import { afterAll, describe, expect, it } from 'vitest';
import { createInvocation, MemoryMemoStore } from './memos.js';
import { callOperation } from './registry.js';
import type { JsonValue, OpContext, ToolInvocation } from './types.js';

function fakeCtx(env: FakeExecutionEnv, extra?: Partial<OpContext>): OpContext {
  return { env, sessionId: 's1', agentId: 'a1', ...extra };
}

const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function nodeCtx(extra?: Partial<OpContext>): OpContext {
  const cwd = mkdtempSync(join(tmpdir(), 'ops-bash-'));
  scratchDirs.push(cwd);
  return {
    env: new NodeExecutionEnv(cwd),
    sessionId: 's1',
    agentId: 'a1',
    ...extra,
  };
}

function inv(id: string, store: MemoryMemoStore): ToolInvocation {
  return createInvocation(
    { invocationId: id, operationId: 'op-1', turnId: 't-1' },
    store,
  );
}

describe('bash operation', () => {
  it('runs echo and threads provenance', async () => {
    const out = await callOperation(
      'bash',
      { command: 'echo hi' },
      inv('inv-b1', new MemoryMemoStore()),
      nodeCtx(),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.exitCode).toBe(0);
      expect(out.result.stdout).toBe('hi\n');
      expect(out.result.aborted).toBe(false);
      expect(out.result.provenance.toolCallId).toBe('inv-b1');
      expect(out.result.provenance.sessionId).toBe('s1');
    }
  });

  it('streams via onUpdate', async () => {
    const seen: ProcessSnapshot[] = [];
    const out = await callOperation(
      'bash',
      { command: 'echo streamed' },
      inv('inv-b2', new MemoryMemoStore()),
      nodeCtx({ onUpdate: (snap) => seen.push(snap) }),
    );
    expect(out.ok).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[seen.length - 1]?.stdout).toContain('streamed');
  });

  it('aborts on signal with a partial snapshot', async () => {
    // Abort as soon as the child's first output is observed: deterministic
    // (no fixed sleep) and proves the partial stdout survives the kill.
    const ctl = new AbortController();
    const out = await callOperation(
      'bash',
      {
        command: `${process.execPath} -e "process.stdout.write('partial');setTimeout(()=>{},30000)"`,
      },
      inv('inv-b3', new MemoryMemoStore()),
      nodeCtx({
        signal: ctl.signal,
        onUpdate: (snap) => {
          if (snap.stdout.includes('partial')) ctl.abort();
        },
      }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.aborted).toBe(true);
      expect(out.result.timedOut).toBe(false);
      expect(out.result.exitCode).toBeNull();
      expect(out.result.stdout).toBe('partial');
    }
  }, 10000);

  it('times out with timedOut set', async () => {
    const out = await callOperation(
      'bash',
      {
        command: `${process.execPath} -e "setTimeout(()=>{},30000)"`,
        timeout: 0.05,
      },
      inv('inv-b4', new MemoryMemoStore()),
      nodeCtx(),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.aborted).toBe(true);
      expect(out.result.timedOut).toBe(true);
      expect(out.result.exitCode).toBeNull();
    }
  }, 10000);

  it('records checkpoints under the invocation id', async () => {
    const store = new MemoryCheckpointStore();
    const out = await callOperation(
      'bash',
      { command: 'echo ckpt' },
      inv('inv-b5', new MemoryMemoStore()),
      nodeCtx({ checkpointStore: store }),
    );
    expect(out.ok).toBe(true);
    expect(store.latest('inv-b5')?.stdout).toBe('ckpt\n');
  });

  it('rejects invalid timeout as a structured error', async () => {
    const out = await callOperation(
      'bash',
      { command: 'echo hi', timeout: -1 },
      inv('inv-b6', new MemoryMemoStore()),
      nodeCtx(),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('invalid_args');
  });
});

describe('replay acceptance', () => {
  it('safe ops share the invocation id without side effects', async () => {
    const store = new MemoryMemoStore();
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('a.txt', 'stable\n');
    const c = fakeCtx(env);
    const before = env.fs.listDir('.').sort();
    const first = await callOperation(
      'read',
      { path: 'a.txt' },
      inv('inv-r', store),
      c,
    );
    const second = await callOperation(
      'read',
      { path: 'a.txt' },
      inv('inv-r', store),
      c,
    );
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.result.content).toBe(second.result.content);
      expect(second.invocation.invocationId).toBe('inv-r');
    }
    expect(env.fs.listDir('.').sort()).toEqual(before);
    expect(env.fs.readFile('a.txt')).toBe('stable\n');
  });

  it('never ops never re-invoke under the same invocation id', async () => {
    const store = new MemoryMemoStore();
    const c = fakeCtx(new FakeExecutionEnv({}));
    const first = await callOperation(
      'write',
      { path: 'w.txt', content: 'first\n' },
      inv('inv-w', store),
      c,
    );
    expect(first.ok).toBe(true);
    const second = await callOperation(
      'write',
      { path: 'w.txt', content: 'second\n' },
      inv('inv-w', store),
      c,
    );
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.result).toEqual(first.result);
    }
    expect(c.env.fs.readFile('w.txt')).toBe('first\n');
  });

  // A counting invocation over the in-process store: the registry memo
  // gate is the only memo a caller without its own replay gate has.
  function counting(
    id: string,
    store: MemoryMemoStore,
    counts: { gets: number; sets: number },
  ): ToolInvocation {
    const base = createInvocation(
      { invocationId: id, operationId: 'op-nr', turnId: 't-nr' },
      store,
    );
    return {
      ...base,
      getMemo: async (name: string) => {
        counts.gets += 1;
        return base.getMemo(name);
      },
      setMemo: async (name: string, value: JsonValue | undefined) => {
        counts.sets += 1;
        return base.setMemo(name, value);
      },
    };
  }

  it('a failed never-replay op is not memoized, and a later call re-executes', async () => {
    const env = new FakeExecutionEnv({});
    env.fs.writeFile('x.txt', 'aaa\n');
    const counts = { gets: 0, sets: 0 };
    const invocation = counting('inv-nrf', new MemoryMemoStore(), counts);
    const miss = { path: 'x.txt', oldText: 'zzz-no-match', newText: 'b' };
    const first = await callOperation('edit', miss, invocation, fakeCtx(env));
    expect(first.ok).toBe(false);
    const second = await callOperation('edit', miss, invocation, fakeCtx(env));
    expect(second.ok).toBe(false);
    // The failure stored nothing, so the later call checked the memo
    // again, missed again, and re-executed instead of replaying a fault.
    expect(counts.sets).toBe(0);
    expect(counts.gets).toBe(2);
  });

  it('a memoized never-replay answer returns without re-executing', async () => {
    // The memo key is the registry's (`op-result-<name>`); seeding it is
    // what a pre-crash attempt's success would have stored.
    const store = new MemoryMemoStore();
    await store.set('inv-nrh', 'op-result-edit', { path: 'x.txt' });
    const counts = { gets: 0, sets: 0 };
    const invocation = counting('inv-nrh', store, counts);
    // x.txt does not exist: a re-execution would fail, the memo answers.
    const out = await callOperation(
      'edit',
      { path: 'x.txt', oldText: 'a', newText: 'b' },
      invocation,
      fakeCtx(new FakeExecutionEnv({})),
    );
    expect(out.ok).toBe(true);
    expect(counts.gets).toBe(1);
    expect(counts.sets).toBe(0);
  });

  it('memoOnce returns the existing value without a setMemo write', async () => {
    const store = new MemoryMemoStore();
    const base = createInvocation(
      { invocationId: 'inv-nrm', operationId: 'op-nr', turnId: 't-nr' },
      store,
    );
    let sets = 0;
    const invocation: ToolInvocation = {
      ...base,
      setMemo: async (name: string, value: JsonValue | undefined) => {
        sets += 1;
        return base.setMemo(name, value);
      },
    };
    expect(await invocation.memoOnce('k', 'first')).toBe('first');
    // First-writer-wins: the existing value comes back, no write happens.
    expect(await invocation.memoOnce('k', 'second')).toBe('first');
    expect(sets).toBe(0);
  });

  it('never-replay memo keys are pi-durable-legal (no colons)', async () => {
    // pi-agent-core's validateMemoName rejected ':' (and the key became a
    // pi-durable memo name too) — a colon key would fail every never-replay
    // op on a real lane, where the faux ids already proved that.
    const seen: string[] = [];
    const strict: ToolInvocation = {
      invocationId: 'inv-s',
      operationId: 'op-s',
      turnId: 't-s',
      // This literal drives the registry's own memo gate, so it keeps the
      // memo (a lane call sets keepEffectMemo: false and never reads one).
      keepEffectMemo: true,
      getMemo: (name: string): Promise<JsonValue | undefined> => {
        seen.push(name);
        if (name.includes(':')) throw new Error('illegal memo name');
        return Promise.resolve(undefined);
      },
      setMemo: (name: string): Promise<void> => {
        seen.push(name);
        if (name.includes(':')) throw new Error('illegal memo name');
        return Promise.resolve(undefined);
      },
      memoOnce: (name: string, candidate: JsonValue): Promise<JsonValue> => {
        void name;
        return Promise.resolve(candidate);
      },
    };
    const c = fakeCtx(new FakeExecutionEnv({}));
    const out = await callOperation(
      'write',
      { path: 'w.txt', content: 'x\n' },
      strict,
      c,
    );
    expect(out.ok).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((name) => !name.includes(':'))).toBe(true);
  });
});

describe('bash handle tracking', () => {
  it('hands its process kill to trackHandle', async () => {
    const tracked: Array<() => void> = [];
    const out = await callOperation(
      'bash',
      { command: 'echo tracked' },
      inv('inv-t1', new MemoryMemoStore()),
      nodeCtx({
        trackHandle: (kill) => {
          tracked.push(kill);
        },
      }),
    );
    expect(out.ok).toBe(true);
    expect(tracked.length).toBe(1);
  });
});
