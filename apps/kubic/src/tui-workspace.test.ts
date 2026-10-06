// The TUI header's workspace facts (EPIC N, issue #453): project, branch and
// changed-file count from `git status --porcelain=v2 -z -b`, read through a
// fake shell (no real git, no network).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NodeExecutionEnv,
  type ProcessHandle,
  type Shell,
  type ShellResult,
} from '../../../packages/exec/src/env.js';
import {
  createGitSandbox,
  disposeAllGitSandboxes,
} from '../../../packages/exec/src/test-support/git-sandbox.js';
import {
  readTuiWorkspace,
  readWorkerDiff,
  workspaceFromStatus,
} from './tui-workspace.js';

const STATUS_OUT = [
  '# branch.oid abc1234\0',
  '# branch.head main\0',
  '1 M. N... 100644 100644 100644 1111111 2222222 staged.txt\0',
  '1 .M N... 100644 100644 100644 1111111 2222222 unstaged.txt\0',
  '1 MM N... 100644 100644 100644 1111111 2222222 both.txt\0',
  'u UU N... 100644 100644 100644 100644 1111111 2222222 3333333 conflict.txt\0',
  '? new.txt\0',
].join('');

interface Call {
  readonly cmd: string;
  readonly args: readonly string[];
}

function fakeShell(
  answers: Record<string, Partial<ShellResult> | Error>,
): Shell & { readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    spawn: (cmd, args, options): ProcessHandle => {
      calls.push({ cmd, args });
      const answer = answers[args.join(' ')];
      return {
        pid: undefined,
        kill: () => {},
        wait: async (): Promise<ShellResult> => {
          if (answer instanceof Error) throw answer;
          return {
            exitCode: 0,
            stdout: '',
            stderr: '',
            provenance: options.provenance,
            ...answer,
          };
        },
      };
    },
  };
}

describe('tui workspace facts (issue #453)', () => {
  it('counts each changed path once, conflicts and untracked included', () => {
    expect(workspaceFromStatus('/work/kubic-playground', STATUS_OUT)).toEqual({
      project: 'kubic-playground',
      branch: 'main',
      dirty: 5,
    });
  });

  it('names a detached HEAD and a clean tree', () => {
    expect(
      workspaceFromStatus(
        '/work/app',
        '# branch.oid abc1234\0# branch.head (detached)\0',
      ),
    ).toEqual({ project: 'app', branch: 'detached', dirty: 0 });
  });

  it('reads the top level and the status without the optional index lock', async () => {
    const shell = fakeShell({
      'rev-parse --show-toplevel': { stdout: '/work/kubic-playground\n' },
      '--no-optional-locks status --porcelain=v2 -z -b': { stdout: STATUS_OUT },
    });
    expect(await readTuiWorkspace(shell, '/work/kubic-playground/src')).toEqual(
      { project: 'kubic-playground', branch: 'main', dirty: 5 },
    );
    expect(shell.calls.every((call) => call.cmd === 'git')).toBe(true);
  });

  it('falls back to the directory name outside a repository or without git', async () => {
    const outside = fakeShell({
      'rev-parse --show-toplevel': { exitCode: 128, stderr: 'not a git repo' },
    });
    expect(await readTuiWorkspace(outside, '/tmp/scratch')).toEqual({
      project: 'scratch',
    });
    const noGit = fakeShell({
      'rev-parse --show-toplevel': new Error('spawn git ENOENT'),
    });
    expect(await readTuiWorkspace(noGit, '/tmp/scratch')).toEqual({
      project: 'scratch',
    });
    const statusFails = fakeShell({
      'rev-parse --show-toplevel': { stdout: '/work/repo\n' },
      '--no-optional-locks status --porcelain=v2 -z -b': { exitCode: 1 },
    });
    expect(await readTuiWorkspace(statusFails, '/work/repo')).toEqual({
      project: 'repo',
    });
  });
});

describe('readWorkerDiff (issue #465)', () => {
  const scratch: string[] = [];
  afterEach(() => {
    disposeAllGitSandboxes();
    for (const dir of scratch.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shows what the branch changed since it left base, uncommitted edits and new files', async () => {
    const sandbox = createGitSandbox({ injectProcessEnv: true });
    const root = sandbox.path;
    writeFileSync(join(root, 'cart.js'), 'a\n');
    sandbox.git(['add', 'cart.js']);
    sandbox.git(['commit', '-qm', 'base']);
    sandbox.git(['checkout', '-q', '-b', 'kubic/run/worker-1']);
    writeFileSync(join(root, 'cart.js'), 'a\nb\n');
    sandbox.git(['commit', '-qam', 'worker']);
    writeFileSync(join(root, 'cart.js'), 'a\nb\nc\n');
    writeFileSync(join(root, 'notes.md'), 'fresh\n');
    const diff =
      (await readWorkerDiff(new NodeExecutionEnv(root).shell, 'main')) ?? '';
    expect(diff).toContain('+b');
    expect(diff).toContain('+c');
    expect(diff).toContain('notes.md');
    expect(diff).toContain('+fresh');
    // Reading never staged anything in the worker's index.
    expect(sandbox.git(['diff', '--cached', '--name-only']).trim()).toBe('');
  });

  it('is undefined outside a repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kubic-465-nogit-'));
    scratch.push(dir);
    expect(
      await readWorkerDiff(new NodeExecutionEnv(dir).shell, 'main'),
    ).toBeUndefined();
  });
});
