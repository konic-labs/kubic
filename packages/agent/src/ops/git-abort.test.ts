// Git abort + timeout against a REAL hanging child: a commit
// hook that sleeps, killed mid-flight through the lane kill registry (the
// headless-run drain path) or the op's AbortSignal, or by the runGit
// timeout. Hermetic git sandbox per test; the sandbox owns
// every scratch dir, the group kill owns the child — no sleeps, no leaks.
//
// RunGit never touched trackHandle/signal/timeout, so the drain
// killed nothing and the op hung until the hook's sleep elapsed.

import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeExecutionEnv } from '../../../exec/src/env.js';
import {
  createGitSandbox,
  disposeAllGitSandboxes,
} from '../../../exec/src/test-support/git-sandbox.js';
import { OperationKillRegistry } from '../lane/abort.js';
import { runGit } from './git.js';
import { createInvocation, MemoryMemoStore } from './memos.js';
import { callOperation } from './registry.js';
import type { OpContext, ToolInvocation } from './types.js';

afterEach(() => {
  disposeAllGitSandboxes();
});

function inv(id: string): ToolInvocation {
  return createInvocation(
    { invocationId: id, operationId: id, turnId: 't-1' },
    new MemoryMemoStore(),
  );
}

/** A repo with one staged file and a pre-commit hook that sleeps 30s. */
function hangingRepo(): { dir: string; registry: OperationKillRegistry } {
  const repo = createGitSandbox({
    prefix: 'kubic-git-abort-',
    injectProcessEnv: true,
  });
  // The sandbox pins core.hooksPath at an empty dir: unpin it so the
  // planted hook actually runs for the op-spawned git below.
  repo.git(['config', '--unset', 'core.hooksPath']);
  writeFileSync(join(repo.path, 'a.txt'), 'work\n');
  repo.git(['add', '--', 'a.txt']);
  writeFileSync(
    join(repo.path, '.git', 'hooks', 'pre-commit'),
    '#!/bin/sh\nsleep 30\n',
  );
  chmodSync(join(repo.path, '.git', 'hooks', 'pre-commit'), 0o755);
  return { dir: repo.path, registry: new OperationKillRegistry() };
}

function trackedCtx(
  dir: string,
  registry: OperationKillRegistry,
  extra?: Partial<OpContext>,
): { ctx: OpContext; gate: Promise<void> } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ctx: OpContext = {
    env: new NodeExecutionEnv(dir),
    sessionId: 's1',
    agentId: 'a1',
    trackHandle: (kill, invocation) => {
      release();
      return registry.track(String(invocation.operationId), kill);
    },
    ...extra,
  };
  return { ctx, gate };
}

describe('git abort kills the in-flight child', () => {
  it('draining the registry mid-commit kills the hook and fails the op', async () => {
    const { dir, registry } = hangingRepo();
    const { ctx, gate } = trackedCtx(dir, registry);
    const pending = callOperation(
      'git_commit',
      { message: 'hung' },
      inv('op-drain-1'),
      ctx,
    );
    // Deterministic handoff: the first child (the commit itself) is tracked
    // before the drain kills it — no sleep, no race with the hook.
    await gate;
    for (const kill of registry.drain('op-drain-1')) kill();
    const out = await pending;
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('tool_failed');
    // Settled means unregistered: the registry holds nothing afterwards.
    expect(registry.drain('op-drain-1')).toEqual([]);
  });

  it('an aborted signal kills the hook and reports aborted', async () => {
    const { dir, registry } = hangingRepo();
    const controller = new AbortController();
    const { ctx, gate } = trackedCtx(dir, registry, {
      signal: controller.signal,
    });
    const pending = callOperation(
      'git_commit',
      { message: 'hung' },
      inv('op-abort-1'),
      ctx,
    );
    await gate;
    controller.abort();
    const out = await pending;
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('tool_failed');
    expect(out.error.message).toContain('aborted');
  });

  it('runGit times out a hung child instead of waiting forever', async () => {
    const { dir } = hangingRepo();
    const ctx: OpContext = {
      env: new NodeExecutionEnv(dir),
      sessionId: 's1',
      agentId: 'a1',
    };
    await expect(
      runGit(ctx, inv('op-timeout-1'), 'git_commit', ['commit', '-m', 'hung'], {
        timeoutSec: 0.2,
      }),
    ).rejects.toThrow(/timed out after 0\.2 seconds/);
  });
});
