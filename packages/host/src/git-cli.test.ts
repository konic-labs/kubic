// Slice D: push guard, git CLI, git-via-bash reconciliation (issue #19; §43).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeExecutionEnv, NodeExecutionEnv } from '../../exec/src/env.js';
import {
  captureBaseline,
  FileJournalStore,
  reconcile,
} from '../../exec/src/journal.js';
import {
  createInvocation,
  MemoryMemoStore,
} from '../../worker/src/ops/memos.js';
import { callOperation } from '../../worker/src/ops/registry.js';
import { detectTriggers } from './approvals.js';
import { gitPushHasNoTool, runGitCommand } from './git-cli.js';

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
    'git status --porcelain=v1 -b': {
      exitCode: 0,
      stdout: statusOut,
      stderr: '',
    },
  };
  return {
    lines,
    deps: {
      env: new FakeExecutionEnv(scripts),
      out: (l: string) => lines.push(l),
    },
  };
}

describe('git guard + CLI + reconciliation (issue #19, slice D)', () => {
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
      '## main...origin/main [ahead 1]\nM  staged.txt\n?? new.txt\n',
    );
    expect(await runGitCommand(['status'], deps)).toBe(0);
    expect(lines).toContain('branch main (ahead 1)');
    expect(lines).toContain('staged: staged.txt');
    expect(lines).toContain('untracked: new.txt');
  });

  it('kubic git outside a repo explains itself and exits 1', async () => {
    const lines: string[] = [];
    const deps: Parameters<typeof runGitCommand>[1] = {
      env: new FakeExecutionEnv({
        'git status --porcelain=v1 -b': {
          exitCode: 128,
          stdout: '',
          stderr: 'fatal: not a git repository',
        },
      }),
      out: (l: string) => lines.push(l),
    };
    expect(await runGitCommand(['status'], deps)).toBe(1);
    expect(lines.join('\n')).toContain('not a git repository');
  });

  it('git-via-bash changes appear in reconciliation as unattributed', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-'));
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 't@t'], {
      cwd: root,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 't'], {
      cwd: root,
      stdio: 'ignore',
    });
    writeFileSync(join(root, 'tracked.txt'), 'v1\n');
    execFileSync('git', ['add', '--', 'tracked.txt'], {
      cwd: root,
      stdio: 'ignore',
    });
    execFileSync('git', ['commit', '-m', 'v1'], { cwd: root, stdio: 'ignore' });

    const env = new NodeExecutionEnv(root);
    const store = new FileJournalStore(mkdtempSync(join(tmpdir(), 'j-')));
    const baseline = captureBaseline(root);
    // The agent rewrites the file through bash + git (no journal entry —
    // bash mutations are not intercepted by design).
    execFileSync('git', ['checkout', '--', 'tracked.txt'], {
      cwd: root,
      stdio: 'ignore',
    });
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
    const root = mkdtempSync(join(tmpdir(), 'git-'));
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 't@t'], {
      cwd: root,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 't'], {
      cwd: root,
      stdio: 'ignore',
    });
    writeFileSync(join(root, 'tracked.txt'), 'v1\n');
    const store = new FileJournalStore(mkdtempSync(join(tmpdir(), 'j-')));
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
