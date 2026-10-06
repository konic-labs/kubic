// Worktree add: preflight + untracked gaps + cold budget (issue #45, slice 2).
// RED first: git ops go through the exec Shell seam (`git worktree`
// explicit argv, never shell-interpolated); faux seam in tests.
import { describe, expect, it } from 'vitest';
import {
  FakeExecutionEnv,
  type FakeSpawnCall,
} from '../../../../exec/src/env.js';
import {
  addWorktree,
  COLD_ADD_BUDGET_MS,
  isColdAddWithinBudget,
} from './add.js';

// Exact argv issued, in order (issue #212): strict mode throws on
// anything unscripted, and this pins what was scripted — including the
// `-b kubic/<agent>` the add must carry.
function argvOf(env: FakeExecutionEnv): string[] {
  return env.calls.map(
    (call: FakeSpawnCall) => `${call.cmd} ${call.args.join(' ')}`,
  );
}

const TOPLEVEL = {
  exitCode: 0,
  stdout: '/repo\n',
  stderr: '',
};

const COMMON_DIR = {
  exitCode: 0,
  stdout: '.git\n',
  stderr: '',
};

function seedRepo(env: FakeExecutionEnv): void {
  env.fs.writeFile('/repo/.git/HEAD', 'ref: refs/heads/main\n');
}

describe('addWorktree preflight (issue #45)', () => {
  it('refuses non-git spawn with exit 5 and leaves solo unaffected', async () => {
    const env = new FakeExecutionEnv(
      {
        'git rev-parse --show-toplevel': {
          exitCode: 128,
          stdout: '',
          stderr: 'fatal: not a git repository',
        },
      },
      { strict: true },
    );
    const error = await addWorktree(env, '/tmp/plain-dir', 'agent-1').catch(
      (e: unknown) => e,
    );
    expect((error as { exitCode?: number }).exitCode).toBe(5);
    expect((error as { code?: string }).code).toBe('not_a_repo');
    expect((error as Error).message).toMatch(/solo/);
    expect(argvOf(env)).toEqual(['git rev-parse --show-toplevel']);
  });

  it('gives parallel spawns distinct worktrees and branches', async () => {
    const agents = ['agent-1', 'agent-2', 'agent-3'];
    const scripts: Record<
      string,
      { exitCode: number; stdout: string; stderr: string }
    > = {
      'git rev-parse --show-toplevel': TOPLEVEL,
      'git rev-parse --git-common-dir': COMMON_DIR,
    };
    for (const agent of agents) {
      scripts[`git branch --list kubic/${agent}`] = {
        exitCode: 0,
        stdout: '',
        stderr: '',
      };
      scripts[`git worktree add /repo/.kubic/wt/${agent} -b kubic/${agent}`] = {
        exitCode: 0,
        stdout: `Preparing worktree (new branch 'kubic/${agent}')\n`,
        stderr: '',
      };
    }
    const env = new FakeExecutionEnv(scripts, { strict: true });
    seedRepo(env);
    const results = [];
    for (const agent of agents) {
      results.push(await addWorktree(env, '/repo', agent));
    }
    const paths = results.map((r) => r.path);
    const branches = results.map((r) => r.branch);
    expect(new Set(paths).size).toBe(3);
    expect(new Set(branches).size).toBe(3);
    expect(branches).toEqual([
      'kubic/agent-1',
      'kubic/agent-2',
      'kubic/agent-3',
    ]);
    expect(paths).toEqual([
      '/repo/.kubic/wt/agent-1',
      '/repo/.kubic/wt/agent-2',
      '/repo/.kubic/wt/agent-3',
    ]);
    // Every add carries its own `-b kubic/<agent>`: omit it in prod and
    // strict mode throws on the unscripted argv.
    expect(argvOf(env)).toEqual([
      'git rev-parse --show-toplevel',
      'git rev-parse --git-common-dir',
      'git branch --list kubic/agent-1',
      'git worktree add /repo/.kubic/wt/agent-1 -b kubic/agent-1',
      'git rev-parse --show-toplevel',
      'git rev-parse --git-common-dir',
      'git branch --list kubic/agent-2',
      'git worktree add /repo/.kubic/wt/agent-2 -b kubic/agent-2',
      'git rev-parse --show-toplevel',
      'git rev-parse --git-common-dir',
      'git branch --list kubic/agent-3',
      'git worktree add /repo/.kubic/wt/agent-3 -b kubic/agent-3',
    ]);
  });

  it('warns on untracked gaps instead of running a silent phantom loop', async () => {
    const env = new FakeExecutionEnv(
      {
        'git rev-parse --show-toplevel': TOPLEVEL,
        'git rev-parse --git-common-dir': COMMON_DIR,
        'git worktree add /repo/.kubic/wt/agent-1 -b kubic/agent-1': {
          exitCode: 0,
          stdout: `Preparing worktree (new branch 'kubic/agent-1')\n`,
          stderr: '',
        },
        'git branch --list kubic/agent-1': {
          exitCode: 0,
          stdout: '',
          stderr: '',
        },
      },
      { strict: true },
    );
    seedRepo(env);
    env.fs.writeFile('/repo/.env.local', 'SECRET=1\n');
    env.fs.writeFile('/repo/node_modules/pkg/package.json', '{}\n');
    const result = await addWorktree(env, '/repo', 'agent-1');
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
    const text = result.warnings.map((w) => w.message).join('\n');
    expect(text).toMatch(/\.env\.local/);
    expect(text).toMatch(/node_modules/);
    expect(text).toMatch(/never silent|copy|npm ci/i);
    expect(argvOf(env)).toEqual([
      'git rev-parse --show-toplevel',
      'git rev-parse --git-common-dir',
      'git branch --list kubic/agent-1',
      'git worktree add /repo/.kubic/wt/agent-1 -b kubic/agent-1',
    ]);
  });

  it('stays inside the cold-add budget on a controlled clock', async () => {
    const env = new FakeExecutionEnv(
      {
        'git rev-parse --show-toplevel': TOPLEVEL,
        'git rev-parse --git-common-dir': COMMON_DIR,
        'git branch --list kubic/agent-9': {
          exitCode: 0,
          stdout: '',
          stderr: '',
        },
        'git worktree add /repo/.kubic/wt/agent-9 -b kubic/agent-9': {
          exitCode: 0,
          stdout: `Preparing worktree (new branch 'kubic/agent-9')\n`,
          stderr: '',
        },
      },
      { strict: true },
    );
    seedRepo(env);
    const ticks = [1000, 1042];
    const result = await addWorktree(env, '/repo', 'agent-9', {
      now: () => ticks.shift() ?? 0,
    });
    expect(result.elapsedMs).toBe(42);
    expect(COLD_ADD_BUDGET_MS).toBe(300);
    expect(isColdAddWithinBudget(result.elapsedMs)).toBe(true);
    expect(isColdAddWithinBudget(500)).toBe(false);
    expect(argvOf(env)).toEqual([
      'git rev-parse --show-toplevel',
      'git rev-parse --git-common-dir',
      'git branch --list kubic/agent-9',
      'git worktree add /repo/.kubic/wt/agent-9 -b kubic/agent-9',
    ]);
  });

  it('refuses a second add when the worktree path already exists', async () => {
    const env = new FakeExecutionEnv(
      {
        'git rev-parse --show-toplevel': TOPLEVEL,
        'git rev-parse --git-common-dir': COMMON_DIR,
      },
      { strict: true },
    );
    seedRepo(env);
    env.fs.writeFile(
      '/repo/.kubic/wt/agent-1/HEAD',
      'ref: refs/heads/kubic/agent-1\n',
    );
    const error = await addWorktree(env, '/repo', 'agent-1').catch(
      (e: unknown) => e,
    );
    expect((error as { code?: string }).code).toBe('already_exists');
    expect((error as Error).message).toMatch(/already exists/);
    // The path check fires before the branch check: no branch list runs.
    expect(argvOf(env)).toEqual([
      'git rev-parse --show-toplevel',
      'git rev-parse --git-common-dir',
    ]);
  });

  it('refuses a second add when the branch already exists', async () => {
    const env = new FakeExecutionEnv(
      {
        'git rev-parse --show-toplevel': TOPLEVEL,
        'git rev-parse --git-common-dir': COMMON_DIR,
        'git branch --list kubic/agent-1': {
          exitCode: 0,
          stdout: '  kubic/agent-1\n',
          stderr: '',
        },
      },
      { strict: true },
    );
    seedRepo(env);
    const error = await addWorktree(env, '/repo', 'agent-1').catch(
      (e: unknown) => e,
    );
    expect((error as { code?: string }).code).toBe('already_exists');
    expect((error as Error).message).toMatch(/kubic\/agent-1/);
    // The branch check fires before the add: no worktree add runs.
    expect(argvOf(env)).toEqual([
      'git rev-parse --show-toplevel',
      'git rev-parse --git-common-dir',
      'git branch --list kubic/agent-1',
    ]);
  });

  it('does not confuse kubic/agent-1 with kubic/agent-10 in the branch list', async () => {
    const env = new FakeExecutionEnv(
      {
        'git rev-parse --show-toplevel': TOPLEVEL,
        'git rev-parse --git-common-dir': COMMON_DIR,
        'git branch --list kubic/agent-1': {
          exitCode: 0,
          stdout: '  kubic/agent-10\n  kubic/agent-11\n',
          stderr: '',
        },
        'git worktree add /repo/.kubic/wt/agent-1 -b kubic/agent-1': {
          exitCode: 0,
          stdout: `Preparing worktree (new branch 'kubic/agent-1')\n`,
          stderr: '',
        },
      },
      { strict: true },
    );
    seedRepo(env);
    const result = await addWorktree(env, '/repo', 'agent-1');
    expect(result.branch).toBe('kubic/agent-1');
    expect(result.path).toBe('/repo/.kubic/wt/agent-1');
    expect(argvOf(env)).toEqual([
      'git rev-parse --show-toplevel',
      'git rev-parse --git-common-dir',
      'git branch --list kubic/agent-1',
      'git worktree add /repo/.kubic/wt/agent-1 -b kubic/agent-1',
    ]);
  });
});
