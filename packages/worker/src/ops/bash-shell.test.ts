// Issue #123: the tool is named bash and the prompts say bash — the op
// must run bash when the system has it, degrade once to sh when it does
// not, and say which shell actually ran (BashResult.shell). Detection and
// execution both go through ctx.env.shell so FakeExecutionEnv scripts the
// answer — no child_process in ops.
import { describe, expect, it } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import type { FakeScript } from '../../../exec/src/env.js';
import { createInvocation, MemoryMemoStore } from './memos.js';
import { callOperation } from './registry.js';
import type { OpContext } from './types.js';

function fakeCtx(
  env: FakeExecutionEnv,
  extra?: Partial<OpContext>,
): OpContext {
  return { env, sessionId: 's1', agentId: 'a1', ...extra };
}

function inv(id: string) {
  return createInvocation(
    { invocationId: id, operationId: 'op-1', turnId: 't-1' },
    new MemoryMemoStore(),
  );
}

const BASH_MISSING: FakeScript = {
  exitCode: 127,
  stdout: '',
  stderr: 'bash: not found',
};

describe('bash shell resolution (issue #123)', () => {
  it('falls back to sh when bash settles 127 "bash: not found"', async () => {
    const env = new FakeExecutionEnv({
      'bash -c echo hi': BASH_MISSING,
      'sh -c echo hi': { exitCode: 0, stdout: 'hi\n', stderr: '' },
    });
    const out = await callOperation(
      'bash',
      { command: 'echo hi' },
      inv('inv-sh1'),
      fakeCtx(env),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.exitCode).toBe(0);
    expect(out.result.stdout).toBe('hi\n');
    expect(out.result.shell).toBe('sh');
  });
});
