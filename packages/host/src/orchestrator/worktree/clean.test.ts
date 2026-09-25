// `kubic clean`: explicit-only disposal (issue #45, slice 4; #92 §42.4, §44.1, §78).
// RED first: --dry-run prunes nothing, real clean prunes worktrees +
// branches + journal retention, output supports --json, and the refusal
// posture holds on the faux seam before the scratch-repo suite
// (clean-repo.test.ts) proves it against real git.
import { describe, expect, it } from 'vitest';
import { FakeExecutionEnv } from '../../../../exec/src/env.js';
import { parseCleanArgs, planClean, runCleanCommand } from './clean.js';
import type { WorktreeEntry } from './list.js';
import { parseWorktreePorcelain } from './list.js';
import { THREE_WT_PORCELAIN } from './list.test.js';

function spawnedEntries(): WorktreeEntry[] {
  return parseWorktreePorcelain(THREE_WT_PORCELAIN).filter((e) =>
    e.path.includes('/.kubic/wt/'),
  );
}

const TOPLEVEL = {
  exitCode: 0,
  stdout: '/repo\n',
  stderr: '',
};

function repoScripts(
  extra: Record<
    string,
    { exitCode: number; stdout: string; stderr: string }
  > = {},
): Record<string, { exitCode: number; stdout: string; stderr: string }> {
  return {
    'git rev-parse --show-toplevel': TOPLEVEL,
    'git worktree list --porcelain': {
      exitCode: 0,
      stdout: THREE_WT_PORCELAIN,
      stderr: '',
    },
    'git branch --list kubic/* --format=%(refname:short)': {
      exitCode: 0,
      stdout: 'kubic/agent-1\nkubic/agent-2\nkubic/agent-3\n',
      stderr: '',
    },
    'git worktree prune': { exitCode: 0, stdout: '', stderr: '' },
    'git branch -D kubic/agent-1': { exitCode: 0, stdout: '', stderr: '' },
    'git branch -D kubic/agent-2': { exitCode: 0, stdout: '', stderr: '' },
    'git branch -D kubic/agent-3': { exitCode: 0, stdout: '', stderr: '' },
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
    ...extra,
  };
}

describe('kubic clean (issue #45, #92)', () => {
  it('dry-run plans prunes but removes nothing', async () => {
    const env = new FakeExecutionEnv(repoScripts());
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
    const text = lines.join('\n');
    expect(text).toMatch(/would remove worktree \/repo\/\.kubic\/wt\/agent-1/);
    expect(text).toMatch(/would remove worktree \/repo\/\.kubic\/wt\/agent-3/);
    expect(text).toMatch(/would delete branch kubic\/agent-1/);
    expect(text).toContain('nothing changed');
  });

  it('real clean prunes worktrees and branches and applies journal retention', async () => {
    const env = new FakeExecutionEnv(repoScripts());
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
      ok: boolean;
      exitCode: number;
      dryRun: boolean;
      worktrees: { path: string; branch: string }[];
      branches: string[];
      journal: { entries: number };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.dryRun).toBe(false);
    expect(parsed.worktrees).toHaveLength(3);
    expect(parsed.branches).toEqual([
      'kubic/agent-1',
      'kubic/agent-2',
      'kubic/agent-3',
    ]);
    expect(parsed.journal.entries).toBe(4);
  });

  it('--journal alone prunes to the store default byte bound', async () => {
    const env = new FakeExecutionEnv(repoScripts());
    const lines: string[] = [];
    const policies: { maxBytes?: number; maxAgeMs?: number }[] = [];
    const code = await runCleanCommand(['--journal'], {
      env,
      out: (line: string) => lines.push(line),
      pruneJournal: (policy: { maxBytes?: number; maxAgeMs?: number }) => {
        policies.push(policy);
        return { entries: 2, bytes: 64 };
      },
    });
    expect(code).toBe(0);
    expect(policies).toHaveLength(1);
    expect(policies[0]?.maxBytes).toBe(100 * 1024 * 1024);
    const text = lines.join('\n');
    expect(text).toContain('journal: pruned 2 entr(ies), freed 64 byte(s)');
    // The journal prune is the work this invocation did — never reported as
    // a no-op.
    expect(text).not.toContain('clean: nothing to prune');
  });

  it('reports a journal-only prune honestly on an otherwise clean repo', async () => {
    const env = new FakeExecutionEnv({
      'git rev-parse --show-toplevel': TOPLEVEL,
      'git worktree list --porcelain': {
        exitCode: 0,
        stdout: 'worktree /repo\nHEAD abc\nbranch refs/heads/main\n',
        stderr: '',
      },
      'git branch --list kubic/* --format=%(refname:short)': {
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
      'git worktree prune': { exitCode: 0, stdout: '', stderr: '' },
    });
    const lines: string[] = [];
    const code = await runCleanCommand(['--journal', '--max-bytes', '10'], {
      env,
      out: (line: string) => lines.push(line),
      pruneJournal: () => ({ entries: 3, bytes: 99 }),
    });
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('journal: pruned 3 entr(ies), freed 99 byte(s)');
    expect(text).not.toContain('nothing to prune');
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

  it('anchors clean scope to the repo root, not a substring', () => {
    const entries = [
      ...parseWorktreePorcelain(THREE_WT_PORCELAIN),
      {
        path: '/other/.kubic/wt/agent-9',
        branch: 'kubic/agent-9',
        bare: false,
        detached: false,
      },
      {
        path: '/repo/.kubic/wt/../escape',
        branch: null,
        bare: false,
        detached: false,
      },
    ];
    const anchored = planClean(entries, {}, '/repo');
    expect(anchored.worktrees.map((w) => w.path)).toEqual([
      '/repo/.kubic/wt/agent-1',
      '/repo/.kubic/wt/agent-2',
      '/repo/.kubic/wt/agent-3',
    ]);
    const unanchored = planClean(entries, {});
    expect(unanchored.worktrees.map((w) => w.path)).not.toContain(
      '/repo/.kubic/wt/../escape',
    );
  });

  it('never plans a namespace-shaped worktree sitting on a foreign branch', () => {
    const entries: WorktreeEntry[] = [
      ...parseWorktreePorcelain(THREE_WT_PORCELAIN),
      {
        path: '/repo/.kubic/wt/fake',
        branch: 'feature/foreign',
        bare: false,
        detached: false,
      },
      {
        path: '/repo/.kubic/wt/detached',
        branch: null,
        bare: false,
        detached: true,
      },
    ];
    const plan = planClean(entries, {}, '/repo', ['feature/foreign']);
    expect(plan.worktrees.map((w) => w.path)).toEqual([
      '/repo/.kubic/wt/agent-1',
      '/repo/.kubic/wt/agent-2',
      '/repo/.kubic/wt/agent-3',
    ]);
    expect(plan.branches).toEqual([]);
  });

  it('rejects unknown flags with exit 2 without pruning', async () => {
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
    expect(code).toBe(2);
    expect(removals).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('unknown flag --nuke');
    expect(text).toMatch(/usage: kubic clean/);
  });

  it('rejects a stray positional argument with exit 2', async () => {
    const env = new FakeExecutionEnv({});
    const lines: string[] = [];
    const code = await runCleanCommand(['worker-1'], {
      env,
      out: (line: string) => lines.push(line),
    });
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('unexpected argument');
  });

  it('refuses outside a git repo with exit 2 and mutates nothing', async () => {
    const env = new FakeExecutionEnv({
      'git rev-parse --show-toplevel': {
        exitCode: 128,
        stdout: '',
        stderr: 'fatal: not a git repository',
      },
    });
    const lines: string[] = [];
    let removals = 0;
    const code = await runCleanCommand([], {
      env,
      out: (line: string) => lines.push(line),
      remover: async () => {
        removals += 1;
      },
    });
    expect(code).toBe(2);
    expect(removals).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('needs a git repository');
    expect(text).toContain('nothing was removed');
  });

  it('rejects --all together with --session', () => {
    expect(parseCleanArgs(['--all', '--session', 'orch-1'])).toEqual({
      valid: false,
      error: '--all and --session are mutually exclusive',
    });
    expect(
      parseCleanArgs(['--all', '--session', 'orch-1', '--dry-run']),
    ).toEqual({ valid: false, error: expect.stringContaining('mutually') });
  });

  it('rejects an invalid --session id before touching the store', () => {
    const parsed = parseCleanArgs(['--session', '../etc']);
    expect(parsed.valid).toBe(false);
    expect(parsed.valid ? '' : parsed.error).toContain('invalid --session id');
  });

  it('reports a hard failure when a dirty worktree refuses removal', async () => {
    const env = new FakeExecutionEnv(
      repoScripts({
        'git worktree remove /repo/.kubic/wt/agent-1': {
          exitCode: 128,
          stdout: '',
          stderr: 'fatal: contains modified or untracked files, use --force',
        },
      }),
    );
    const lines: string[] = [];
    const code = await runCleanCommand([], {
      env,
      out: (line: string) => lines.push(line),
    });
    expect(code).toBe(1);
    const text = lines.join('\n');
    expect(text).toContain('error:');
    expect(text).toContain('agent-1');
    // Never half-disposed: no branch delete for the worktree that survived.
    expect(text).not.toContain('deleted branch kubic/agent-1');
    expect(text).toContain('deleted branch kubic/agent-2');
  });
});
