// Issue #112, prod path: a commit subject containing multi-byte UTF-8 must
// round-trip through git_log intact. Real git in a throwaway repo
// (mkdtempSync + git init — never this repo), real NodeExecutionEnv shell,
// no fakes: this is the git-op end of the chunk-boundary decode seam.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeExecutionEnv } from '../../../exec/src/env.js';
import { createInvocation, MemoryMemoStore } from './memos.js';
import { callOperation } from './registry.js';
import type { OpContext, ToolInvocation } from './types.js';

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

// realpath: macOS tmpdir is a symlink (/var → /private/var) and git reports
// the resolved toplevel, so the env's cwd must be the resolved form too.
function scratchRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kubic-git-log-utf8-')));
  scratchDirs.push(dir);
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'kubic-test@local']);
  git(dir, ['config', 'user.name', 'kubic test']);
  writeFileSync(join(dir, 'README.md'), '# scratch\n');
  git(dir, ['add', 'README.md']);
  return dir;
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

describe('git_log multi-byte UTF-8 round-trip (issue #112)', () => {
  it('returns a commit subject containing multi-byte UTF-8 intact', async () => {
    const dir = scratchRepo();
    const subject = 'fix: café 😀 über';
    git(dir, ['commit', '-m', subject]);
    const out = await callOperation(
      'git_log',
      { max: 5 },
      inv('utf8-log-1'),
      ctx(dir),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.entries).toHaveLength(1);
      expect(out.result.entries[0]?.message).toBe(subject);
    }
  });
});
