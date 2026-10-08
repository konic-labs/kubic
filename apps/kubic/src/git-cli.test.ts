// Push guard, git CLI, git-via-bash reconciliation.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CliExitError,
  CliUsageError,
} from '../../../packages/core/src/cli/exit-codes.js';
import { createCliTheme } from '../../../packages/core/src/cli/theme.js';
import {
  FakeExecutionEnv,
  NodeExecutionEnv,
} from '../../../packages/exec/src/env.js';
import {
  captureBaseline,
  FileJournalStore,
  reconcile,
} from '../../../packages/exec/src/journal.js';
import {
  createGitSandbox,
  disposeAllGitSandboxes,
} from '../../../packages/exec/src/test-support/git-sandbox.js';
import { detectTriggers } from '../../../packages/host/src/approvals.js';
import {
  GIT_NOT_A_REPO,
  gitPushHasNoTool,
  runGitCommand,
} from '../../../packages/host/src/git-cli.js';
import {
  createInvocation,
  MemoryMemoStore,
} from '../../../packages/worker/src/ops/memos.js';
import { callOperation } from '../../../packages/worker/src/ops/registry.js';

const made: string[] = [];

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  disposeAllGitSandboxes();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const TRIGGER_CTX = {
  workspace: '/ws',
  network: 'none' as const,
  isDestructive: () => false,
  isNetworkCommand: () => false,
  isOutsideWorkspace: () => false,
};

function fakeGitCli(statusOut: string): {
  lines: string[];
  deps: Parameters<typeof runGitCommand>[1];
} {
  const lines: string[] = [];
  const scripts: Record<
    string,
    { exitCode: number; stdout: string; stderr: string }
  > = {
    'git status --porcelain=v2 -z -b': {
      exitCode: 0,
      stdout: statusOut,
      stderr: '',
    },
    // Fakes are strict-by-default: script the status side-queries too.
    'git rev-parse --show-toplevel': {
      exitCode: 0,
      stdout: '/repo\n',
      stderr: '',
    },
    'git submodule status': { exitCode: 0, stdout: '', stderr: '' },
  };
  return {
    lines,
    deps: {
      env: new FakeExecutionEnv(scripts),
      out: (l: string) => lines.push(l),
    },
  };
}

describe('git guard + CLI + reconciliation', () => {
  it('push has no tool and always raises the git-push approval trigger', () => {
    expect(gitPushHasNoTool()).toBe(true);
    const triggers = detectTriggers(
      'bash',
      { command: 'git push origin main' },
      TRIGGER_CTX,
    );
    expect(triggers).toContain('git-push');
  });

  it('kubic git status renders the structured state', async () => {
    const { lines, deps } = fakeGitCli(
      [
        '# branch.oid abc1234\0',
        '# branch.head main\0',
        '# branch.upstream origin/main\0',
        '# branch.ab +1 -0\0',
        '1 M. N... 100644 100644 100644 1111111 2222222 staged.txt\0',
        '? new.txt\0',
      ].join(''),
    );
    expect((await runGitCommand({ command: 'status' }, deps)).exitCode).toBe(0);
    expect(lines).toContain('branch main (ahead 1)');
    expect(lines).toContain('staged: staged.txt');
    expect(lines).toContain('untracked: new.txt');
  });

  it('kubic git status renders conflicts on their own line', async () => {
    const { lines, deps } = fakeGitCli(
      [
        '# branch.oid abc1234\0',
        '# branch.head main\0',
        'u UU N... 100644 100644 100644 100644 1111111 2222222 3333333 cl.txt\0',
      ].join(''),
    );
    expect((await runGitCommand({ command: 'status' }, deps)).exitCode).toBe(0);
    expect(lines).toContain('conflicts: cl.txt');
    expect(lines.some((line) => line.includes('staged:'))).toBe(false);
    expect(lines.some((line) => line.includes('modified:'))).toBe(false);
  });

  it('kubic git status prints a detached HEAD instead of a null branch', async () => {
    const { lines, deps } = fakeGitCli(
      '# branch.oid abc1234\0# branch.head (detached)\0',
    );
    expect((await runGitCommand({ command: 'status' }, deps)).exitCode).toBe(0);
    expect(lines).toContain('branch (detached HEAD)');
  });

  it('kubic git outside a repo explains itself and exits 1', async () => {
    const lines: string[] = [];
    const deps: Parameters<typeof runGitCommand>[1] = {
      env: new FakeExecutionEnv({
        'git status --porcelain=v2 -z -b': {
          exitCode: 128,
          stdout: '',
          stderr: 'fatal: not a git repository',
        },
      }),
      out: (l: string) => lines.push(l),
    };
    await expect(runGitCommand({ command: 'status' }, deps)).rejects.toThrow(
      new CliExitError(1, GIT_NOT_A_REPO),
    );
    expect(lines).toEqual([]);
  });

  it('git-via-bash changes appear in reconciliation as unattributed', () => {
    // Real git runs through the shared sandbox, never raw
    // execFileSync — the bash op below inherits the sandbox env.
    const repo = createGitSandbox({
      prefix: 'git-cli-',
      injectProcessEnv: true,
    });
    const root = repo.path;
    writeFileSync(join(root, 'tracked.txt'), 'v1\n');
    repo.git(['add', '--', 'tracked.txt']);
    repo.git(['commit', '-m', 'v1']);

    const env = new NodeExecutionEnv(root);
    const store = new FileJournalStore(mkTmp('j-'));
    const baseline = captureBaseline(root);
    // The agent rewrites the file through bash + git (no journal entry —
    // bash mutations are not intercepted by design).
    repo.git(['checkout', '--', 'tracked.txt']);
    writeFileSync(join(root, 'tracked.txt'), 'v2-external\n');
    const added = reconcile(store, baseline, root, {
      sessionId: 's1',
      agentId: 'root',
      timestamp: 1,
    });
    expect(added).toBe(1);
    const [entry] = store.entries();
    expect(entry?.path).toBe('tracked.txt');
    expect(entry?.unattributed).toBe(true);
    void env;
  });

  it('git mutations through the bash op reconcile the same way', async () => {
    // Shared sandbox (activated: the bash op inherits its env).
    const repo = createGitSandbox({
      prefix: 'git-cli-',
      injectProcessEnv: true,
    });
    const root = repo.path;
    writeFileSync(join(root, 'tracked.txt'), 'v1\n');
    const store = new FileJournalStore(mkTmp('j-'));
    const baseline = captureBaseline(root);
    const memos = new MemoryMemoStore();
    const out = await callOperation(
      'bash',
      { command: 'printf v2-via-bash > tracked.txt' },
      createInvocation(
        { invocationId: 'b1', operationId: 'b1', turnId: 't-1' },
        memos,
      ),
      { env: new NodeExecutionEnv(root), sessionId: 's1', agentId: 'root' },
    );
    expect(out.ok).toBe(true);
    const added = reconcile(store, baseline, root, {
      sessionId: 's1',
      agentId: 'root',
      timestamp: 2,
    });
    expect(added).toBe(1);
    expect(store.entries()[0]?.unattributed).toBe(true);
  });
});

// The typed-request surface commander drives (apps/kubic/src/commands/
// journal.ts): every subcommand end to end over a real temp repo, in the
// human, coloured and `--json` forms.
describe('kubic git over a real repo (typed requests)', () => {
  function repo(): {
    root: string;
    lines: string[];
    out: (l: string) => void;
  } {
    // Shared sandbox. The log tests assert author `tester`, so
    // the repo-local identity overrides the sandbox default.
    const sandbox = createGitSandbox({
      prefix: 'git-cli-',
      injectProcessEnv: true,
    });
    sandbox.git(['config', 'user.email', 't@t']);
    sandbox.git(['config', 'user.name', 'tester']);
    const lines: string[] = [];
    return { root: sandbox.path, lines, out: (l) => lines.push(l) };
  }

  it('stage, commit, log and status round-trip in the human form', async () => {
    const { root, lines, out } = repo();
    const env = new NodeExecutionEnv(root);
    writeFileSync(join(root, 'a.txt'), 'a\n');
    writeFileSync(join(root, 'b.txt'), 'b\n');
    expect(
      (
        await runGitCommand(
          { command: 'stage', paths: ['a.txt'] },
          { env, out },
        )
      ).exitCode,
    ).toBe(0);
    expect(lines).toEqual(['staged a.txt']);
    lines.length = 0;
    expect(
      (
        await runGitCommand(
          { command: 'commit', message: 'feat: add a' },
          { env, out },
        )
      ).exitCode,
    ).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^committed [0-9a-f]{8} \(1 file\(s\)\)$/);
    lines.length = 0;
    expect(
      (await runGitCommand({ command: 'log' }, { env, out })).exitCode,
    ).toBe(0);
    // Plain aligned table: header plus one row, no box characters.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^SHA\s+DATE\s+AUTHOR\s+MESSAGE$/);
    expect(lines[1]).toMatch(/^[0-9a-f]{8}\s+\S.*\s+tester\s+feat: add a$/);
    lines.length = 0;
    expect(
      (await runGitCommand({ command: 'status' }, { env, out })).exitCode,
    ).toBe(0);
    expect(lines).toEqual(['branch main', 'untracked: b.txt']);
  });

  it('--json prints exactly one document per subcommand', async () => {
    const { root, lines, out } = repo();
    const env = new NodeExecutionEnv(root);
    writeFileSync(join(root, 'a.txt'), 'a\n');
    const docs: unknown[] = [];
    const run = async (request: Parameters<typeof runGitCommand>[0]) => {
      lines.length = 0;
      expect((await runGitCommand(request, { env, out })).exitCode).toBe(0);
      expect(lines).toHaveLength(1);
      docs.push(JSON.parse(lines[0] ?? ''));
    };
    await run({ command: 'stage', paths: ['a.txt'], json: true });
    await run({ command: 'commit', message: 'm1', json: true });
    await run({ command: 'log', max: 1, json: true });
    await run({ command: 'status', json: true });
    expect(docs[0]).toEqual({ staged: ['a.txt'] });
    expect(docs[1]).toMatchObject({ files: ['a.txt'] });
    expect(docs[2]).toMatchObject([{ author: 'tester', message: 'm1' }]);
    expect(docs[3]).toMatchObject({ branch: 'main', clean: true });
  });

  it('colours only through the injected theme, and never under --json', async () => {
    const { root, lines, out } = repo();
    const env = new NodeExecutionEnv(root);
    const theme = createCliTheme('16');
    writeFileSync(join(root, 'u.txt'), 'u\n');
    await runGitCommand({ command: 'status' }, { env, out, theme });
    expect(lines.join('\n')).toContain('\u001b[');
    expect(lines.join('\n')).toContain('untracked:');
    lines.length = 0;
    await runGitCommand({ command: 'status', json: true }, { env, out, theme });
    expect(lines.join('\n')).not.toContain('\u001b[');
  });

  it('a fresh repo (unborn branch) has an empty history, not a failure', async () => {
    const { root, lines, out } = repo();
    const env = new NodeExecutionEnv(root);
    expect(
      (await runGitCommand({ command: 'log' }, { env, out })).exitCode,
    ).toBe(0);
    expect(lines).toEqual(['no commits']);
    lines.length = 0;
    expect(
      (await runGitCommand({ command: 'log', json: true }, { env, out }))
        .exitCode,
    ).toBe(0);
    expect(lines).toEqual(['[]']);
  });

  it('programmatic usage errors throw CliUsageError (exit 2) before any git call', async () => {
    const deps = {
      env: new FakeExecutionEnv({}),
      out: () => {
        throw new Error('no output on a usage error');
      },
    };
    for (const max of [0, -1, 1.5]) {
      await expect(
        runGitCommand({ command: 'log', max }, deps),
      ).rejects.toThrow(new CliUsageError('--max needs a positive integer'));
    }
    await expect(
      runGitCommand({ command: 'stage', paths: [] }, deps),
    ).rejects.toThrow(new CliUsageError('stage needs at least one path'));
    await expect(
      runGitCommand({ command: 'commit', message: '' }, deps),
    ).rejects.toThrow(
      new CliUsageError('commit needs a non-empty message (-m)'),
    );
  });

  it('an op failure other than not-a-repo keeps its own message, exit 1', async () => {
    const { root } = repo();
    const env = new NodeExecutionEnv(root);
    const error = await runGitCommand(
      { command: 'commit', message: 'nothing staged' },
      { env, out: () => {} },
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(CliExitError);
    expect((error as CliExitError).exitCode).toBe(1);
    expect((error as CliExitError).message).not.toBe(GIT_NOT_A_REPO);
  });
});
