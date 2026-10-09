// Prod path: a commit subject containing multi-byte UTF-8 must
// round-trip through git_log intact. Real git in a sandboxed throwaway repo
// (scrubbed env, never the inherited one and never this repo),
// real NodeExecutionEnv shell, no fakes: this is the git-op end of the
// chunk-boundary decode seam.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeExecutionEnv } from '@kubic/exec/env';
import {
  createGitSandbox,
  disposeAllGitSandboxes,
  type GitSandbox,
} from '@kubic/exec/test-support/git-sandbox';
import { afterEach, describe, expect, it } from 'vitest';
import { createInvocation, MemoryMemoStore } from '../memos.js';
import { callOperation } from '../registry.js';
import type { OpContext, ToolInvocation } from '../types.js';

afterEach(() => {
  disposeAllGitSandboxes();
});

// Activated: the op under test spawns git through NodeExecutionEnv on the
// inherited environment, so process.env itself must be the sandbox's.
function scratchRepo(): GitSandbox {
  const sandbox = createGitSandbox({
    prefix: 'kubic-git-log-utf8-',
    injectProcessEnv: true,
  });
  writeFileSync(join(sandbox.path, 'README.md'), '# scratch\n');
  sandbox.git(['add', 'README.md']);
  return sandbox;
}

function inv(id: string): ToolInvocation {
  return createInvocation(
    { invocationId: id, operationId: 'git_log', turnId: 't-1' },
    new MemoryMemoStore(),
  );
}

function ctx(cwd: string): OpContext {
  return {
    env: new NodeExecutionEnv(cwd),
    sessionId: 's1',
    agentId: 'a1',
  };
}

describe('git_log multi-byte UTF-8 round-trip', () => {
  it('returns a commit subject containing multi-byte UTF-8 intact', async () => {
    const repo = scratchRepo();
    const subject = 'fix: café 😀 über';
    repo.git(['commit', '-m', subject]);
    const out = await callOperation(
      'git_log',
      { max: 5 },
      inv('utf8-log-1'),
      ctx(repo.path),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.entries).toHaveLength(1);
      expect(out.result.entries[0]?.message).toBe(subject);
    }
  });
});
