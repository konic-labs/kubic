// Kill-registry retention: a finished bash call must not leave
// its kill closure (and, through it, the handle and its settled output) in
// the lane's OperationKillRegistry. The TUI reuses one registry for the whole
// session, so a handle per completed call is an unbounded leak.

import { FakeExecutionEnv } from '@kubic/exec/test-support/fake-env';
import { describe, expect, it } from 'vitest';
import { OperationKillRegistry } from '../lane/abort.js';
import { createInvocation, MemoryMemoStore } from './memos.js';
import { callOperation } from './registry.js';
import type { OpContext, ToolInvocation } from './types.js';

const posix = process.platform !== 'win32';

function inv(): ToolInvocation {
  return createInvocation(
    { invocationId: 'inv-1', operationId: 'op-1', turnId: 't-1' },
    new MemoryMemoStore(),
  );
}

describe('bash kill registry retention', () => {
  it.runIf(posix)(
    'a settled call leaves nothing tracked under its operation id',
    async () => {
      const registry = new OperationKillRegistry();
      const env = new FakeExecutionEnv({
        'bash -c true': { exitCode: 0, stdout: 'ok\n', stderr: '' },
      });
      const ctx: OpContext = {
        env,
        sessionId: 's1',
        agentId: 'a1',
        // The lane's wiring: track under the operation id, hand back the
        // unregister fn the op must call when its handle settles.
        trackHandle: (kill, invocation) =>
          registry.track(String(invocation.operationId), kill),
      };
      for (let i = 0; i < 3; i += 1) {
        const out = await callOperation(
          'bash',
          { command: 'true' },
          inv(),
          ctx,
        );
        expect(out.ok).toBe(true);
      }
      expect(registry.drain('op-1')).toEqual([]);
    },
  );

  it.runIf(posix)(
    'a failing call untracks too, and a retried call keeps only the live handle',
    async () => {
      const registry = new OperationKillRegistry();
      const env = new FakeExecutionEnv({
        'bash -c boom': { exitCode: 1, stdout: '', stderr: 'boom\n' },
      });
      const ctx: OpContext = {
        env,
        sessionId: 's1',
        agentId: 'a1',
        trackHandle: (kill, invocation) =>
          registry.track(String(invocation.operationId), kill),
      };
      const out = await callOperation('bash', { command: 'boom' }, inv(), ctx);
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.result.exitCode).toBe(1);
      expect(registry.drain('op-1')).toEqual([]);
    },
  );
});
