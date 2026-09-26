// Issue #121, op layer: bash results that reach the model are capped per
// stream (BASH_RESULT_MAX_CHARS) with a self-describing header and a
// `truncated` flag — a grep over a giant file must not dump megabytes
// into the model's context window. Real NodeExecutionEnv + real sh child.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeExecutionEnv } from '../../../exec/src/env.js';
import { BASH_RESULT_MAX_CHARS } from './bash.js';
import { createInvocation, MemoryMemoStore } from './memos.js';
import { callOperation } from './registry.js';
import type { OpContext } from './types.js';

function realCtx(): OpContext {
  return {
    sessionId: 's1',
    agentId: 'root',
    env: new NodeExecutionEnv(mkdtempSync(join(tmpdir(), 'bash-cap-'))),
  };
}

function inv() {
  return createInvocation(
    { invocationId: 'inv-1', operationId: 'op-1', turnId: 'turn-1' },
    new MemoryMemoStore(),
  );
}

describe('bash result caps (issue #121)', () => {
  it('clips oversized stdout, keeps the tail, and reports truncated: true', async () => {
    const total = BASH_RESULT_MAX_CHARS + 40_000;
    const out = await callOperation(
      'bash',
      {
        command: `node -e "process.stdout.write('x'.repeat(${total})); process.stdout.write('TAIL')"`,
        timeout: 30,
      },
      inv(),
      realCtx(),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.truncated).toBe(true);
    expect(out.result.stdout.length).toBeLessThanOrEqual(
      BASH_RESULT_MAX_CHARS + 120,
    );
    // total + 'TAIL' (4 chars) over the cap: the header names the exact drop.
    expect(out.result.stdout).toMatch(
      new RegExp(
        `^\\[kubic: ${total + 4 - BASH_RESULT_MAX_CHARS} leading chars dropped\\]`,
      ),
    );
    expect(out.result.stdout.endsWith('TAIL')).toBe(true);
    expect(out.result.exitCode).toBe(0);
  });

  it('clips stderr independently of stdout', async () => {
    const total = BASH_RESULT_MAX_CHARS + 10_000;
    const out = await callOperation(
      'bash',
      {
        command: `node -e "process.stderr.write('e'.repeat(${total}))"`,
        timeout: 30,
      },
      inv(),
      realCtx(),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.truncated).toBe(true);
    expect(out.result.stderr.length).toBeLessThanOrEqual(
      BASH_RESULT_MAX_CHARS + 120,
    );
    expect(out.result.stderr).toMatch(
      /^\[kubic: 10000 leading chars dropped\]/,
    );
  });

  it('leaves small results byte-identical with truncated: false', async () => {
    const out = await callOperation(
      'bash',
      { command: 'printf tiny' },
      inv(),
      realCtx(),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result).toEqual({
      command: 'printf tiny',
      exitCode: 0,
      stdout: 'tiny',
      stderr: '',
      truncated: false,
      aborted: false,
      timedOut: false,
      provenance: out.result.provenance,
    });
  });
});
