// `kubic clean`: explicit-only disposal (issue #45, slice 4; §42.4, §44.1).
// RED first: --dry-run prunes nothing, real clean prunes worktrees +
// journal retention, output supports --json.
import { describe, expect, it } from 'vitest';
import { FakeExecutionEnv } from '../../../../exec/src/env.js';
import { planClean, runCleanCommand } from './clean.js';
import type { WorktreeEntry } from './list.js';
import { parseWorktreePorcelain } from './list.js';
import { THREE_WT_PORCELAIN } from './list.test.js';

function spawnedEntries(): WorktreeEntry[] {
  return parseWorktreePorcelain(THREE_WT_PORCELAIN).filter((e) =>
    e.path.includes('/.kubic/wt/'),
  );
}

describe('kubic clean (issue #45)', () => {
  it('dry-run plans prunes but removes nothing', async () => {
    const env = new FakeExecutionEnv({
      'git worktree list --porcelain': {
        exitCode: 0,
        stdout: THREE_WT_PORCELAIN,
        stderr: '',
      },
    });
    const lines: string[] = [];
    const removed: string[] = [];
    let journalCalls = 0;
    const code = await runCleanCommand(['--dry-run'], {
      env,
      out: (line: string) => lines.push(line),
      remover: async (_e: unknown, path: string) => {
        removed.push(path);
      },
      pruneJournal: () => {
        journalCalls += 1;
        return { entries: 0, bytes: 0 };
      },
    });
    expect(code).toBe(0);
    expect(removed).toEqual([]);
    expect(journalCalls).toBe(0);
    expect(lines.join('\n')).toMatch(/would prune 3 worktree/);
  });

  it('real clean prunes worktrees and applies journal retention', async () => {
    const env = new FakeExecutionEnv({
      'git worktree list --porcelain': {
        exitCode: 0,
        stdout: THREE_WT_PORCELAIN,
        stderr: '',
      },
      'git worktree remove /repo/.kubic/wt/agent-1': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'git worktree remove /repo/.kubic/wt/agent-2': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'git worktree remove /repo/.kubic/wt/agent-3': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
    });
    const lines: string[] = [];
    const policies: unknown[] = [];
    const code = await runCleanCommand(['--max-age-ms', '3600000', '--json'], {
      env,
      out: (line: string) => lines.push(line),
      pruneJournal: (policy: unknown) => {
        policies.push(policy);
        return { entries: 4, bytes: 1024 };
      },
    });
    expect(code).toBe(0);
    expect(policies).toEqual([{ maxAgeMs: 3600000 }]);
    const parsed = JSON.parse(lines.join('\n')) as {
      pruned: string[];
      journal: { entries: number };
    };
    expect(parsed.pruned).toHaveLength(3);
    expect(parsed.journal.entries).toBe(4);
  });

  it('plans only spawned worktrees, never the main checkout', () => {
    const plan = planClean(parseWorktreePorcelain(THREE_WT_PORCELAIN), {});
    expect(plan.worktrees.map((w) => w.path)).toEqual([
      '/repo/.kubic/wt/agent-1',
      '/repo/.kubic/wt/agent-2',
      '/repo/.kubic/wt/agent-3',
    ]);
    expect(spawnedEntries()).toHaveLength(3);
  });

  it('rejects unknown flags without pruning', async () => {
    const env = new FakeExecutionEnv({});
    const lines: string[] = [];
    let removals = 0;
    const code = await runCleanCommand(['--nuke'], {
      env,
      out: (line: string) => lines.push(line),
      remover: async () => {
        removals += 1;
      },
    });
    expect(code).toBe(1);
    expect(removals).toBe(0);
    expect(lines.join('\n')).toMatch(/usage/);
  });
});
