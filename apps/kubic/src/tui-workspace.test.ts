import { describe, expect, it } from 'vitest';
import type {
  ProcessHandle,
  Shell,
  ShellResult,
} from '../../../packages/exec/src/env.js';
import { readTuiWorkspace, workspaceFromStatus } from './tui-workspace.js';

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
