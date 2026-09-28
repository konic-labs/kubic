// `kubic clean`: explicit-only disposal (issue #45, slice 4; #92 §42.4, §44.1, §78).
// RED first: --dry-run prunes nothing, real clean prunes worktrees +
// branches + journal retention, output supports --json, and the refusal
// posture holds on the faux seam before the scratch-repo suite
// (clean-repo.test.ts) proves it against real git.
import { describe, expect, it } from 'vitest';
import { FakeExecutionEnv } from '../../../../exec/src/env.js';
import {
  type CleanOptions,
  planClean,
  planSessionClean,
  runCleanCommand,
} from './clean.js';
import type { WorktreeEntry } from './list.js';
import { parseWorktreePorcelain } from './list.js';

// Kept local, not imported from list.test.ts: importing a test file
// re-registers its suites here, so they ran twice.
const THREE_WT_PORCELAIN = `worktree /repo
HEAD abcdef0123456789
branch refs/heads/main

worktree /repo/.kubic/wt/agent-1
HEAD 1111111111111111
branch refs/heads/kubic/agent-1

worktree /repo/.kubic/wt/agent-2
HEAD 2222222222222222
branch refs/heads/kubic/agent-2

worktree /repo/.kubic/wt/agent-3
HEAD 3333333333333333
branch refs/heads/kubic/agent-3
`;

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
    const errs: string[] = [];
    const removed: string[] = [];
    let journalCalls = 0;
    const code = await runCleanCommand(
      { dryRun: true },
      {
        env,
        out: (line: string) => lines.push(line),
        err: (line: string) => errs.push(line),
        remover: async (_e: unknown, path: string) => {
          removed.push(path);
        },
        pruneJournal: () => {
          journalCalls += 1;
          return { entries: 0, bytes: 0 };
        },
      },
    );
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
    const errs: string[] = [];
    const policies: unknown[] = [];
    const code = await runCleanCommand(
      { maxAgeMs: 3600000, json: true },
      {
        env,
        out: (line: string) => lines.push(line),
        err: (line: string) => errs.push(line),
        pruneJournal: (policy: unknown) => {
          policies.push(policy);
          return { entries: 4, bytes: 1024 };
        },
      },
    );
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
    const errs: string[] = [];
    const policies: { maxBytes?: number; maxAgeMs?: number }[] = [];
    const code = await runCleanCommand(
      { journal: true },
      {
        env,
        out: (line: string) => lines.push(line),
        err: (line: string) => errs.push(line),
        pruneJournal: (policy: { maxBytes?: number; maxAgeMs?: number }) => {
          policies.push(policy);
          return { entries: 2, bytes: 64 };
        },
      },
    );
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
    const errs: string[] = [];
    const code = await runCleanCommand(
      { journal: true, maxBytes: 10 },
      {
        env,
        out: (line: string) => lines.push(line),
        err: (line: string) => errs.push(line),
        pruneJournal: () => ({ entries: 3, bytes: 99 }),
      },
    );
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
    // Every planned worktree carries the branch it is disposed with; the
    // main checkout's `main` is never among them.
    expect(plan.worktrees.map((w) => w.branch)).toEqual([
      'kubic/agent-1',
      'kubic/agent-2',
      'kubic/agent-3',
    ]);
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

  it('follows the configured worktree root (issue #133)', () => {
    // A repo whose config sets `[orchestrator] root = ".kubic-custom/wt"`:
    // the default set is out of scope, and the custom set is the plan.
    const entries: WorktreeEntry[] = [
      ...parseWorktreePorcelain(THREE_WT_PORCELAIN),
      {
        path: '/repo/.kubic-custom/wt/agent-7',
        branch: 'kubic/agent-7',
        bare: false,
        detached: false,
      },
    ];
    const plan = planClean(entries, {}, '/repo', [], '.kubic-custom/wt');
    expect(plan.worktrees.map((w) => w.path)).toEqual([
      '/repo/.kubic-custom/wt/agent-7',
    ]);
    // Session scope reads the same value: the retained set is derived
    // under the configured root, so `kubic clean --session` finds it.
    const session = planSessionClean(
      ['agent-7'],
      '/repo',
      {},
      '.kubic-custom/wt',
    );
    expect(session.worktrees).toEqual([
      { path: '/repo/.kubic-custom/wt/agent-7', branch: 'kubic/agent-7' },
    ]);
    expect(session.branches).toEqual(['kubic/agent-7']);
  });

  it('plans a custom-root worktree from the deps root, not the argv (issue #133)', async () => {
    const env = new FakeExecutionEnv(repoScripts());
    const lines: string[] = [];
    const errs: string[] = [];
    const removed: string[] = [];
    const code = await runCleanCommand(
      { json: true },
      {
        env,
        out: (line: string) => lines.push(line),
        err: (line: string) => errs.push(line),
        worktreeRoot: '.kubic-custom/wt',
        lister: async () =>
          parseWorktreePorcelain(
            `${THREE_WT_PORCELAIN}\nworktree /repo/.kubic-custom/wt/agent-7\nHEAD 7777777777777777\nbranch refs/heads/kubic/agent-7\n`,
          ),
        branchLister: async () => ['kubic/agent-7'],
        remover: async (_env: unknown, path: string) => {
          removed.push(path);
        },
        branchDeleter: async () => undefined,
        pruner: async () => undefined,
      },
    );
    expect(code).toBe(0);
    expect(removed).toEqual(['/repo/.kubic-custom/wt/agent-7']);
    const parsed = JSON.parse(lines.join('\n')) as {
      worktrees: { path: string }[];
    };
    expect(parsed.worktrees).toEqual([
      { path: '/repo/.kubic-custom/wt/agent-7', branch: 'kubic/agent-7' },
    ]);
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

  // Argv-level refusals (unknown flag, starved or malformed bound, stray
  // operand, invalid --session id, --all with --session) are the commander
  // program's: apps/kubic/src/commands/orchestrator.test.ts pins each one
  // exits 2 before this handler runs.

  it('refuses an unsafe session id from a library caller before touching the store', async () => {
    // The id names <repo>/.kubic/orchestrator/<id>.json: the CLI refuses it
    // at parse time, and the handler re-checks so no caller can bypass it.
    const env = new FakeExecutionEnv(repoScripts());
    const lines: string[] = [];
    const errs: string[] = [];
    let looked = 0;
    const code = await runCleanCommand(
      { sessionId: '../etc' },
      {
        env,
        out: (line: string) => lines.push(line),
        err: (line: string) => errs.push(line),
        sessionAgents: () => {
          looked += 1;
          return [];
        },
      },
    );
    expect(code).toBe(2);
    expect(looked).toBe(0);
    expect(lines).toEqual([]);
    expect(errs).toEqual([
      'error: invalid --session id "../etc" (use [A-Za-z0-9_-]); nothing was removed',
    ]);
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
    const errs: string[] = [];
    let removals = 0;
    const code = await runCleanCommand(
      {},
      {
        env,
        out: (line: string) => lines.push(line),
        err: (line: string) => errs.push(line),
        remover: async () => {
          removals += 1;
        },
      },
    );
    expect(code).toBe(2);
    expect(removals).toBe(0);
    // The refusal is a diagnostic: stderr, one logger line, stdout empty.
    expect(lines).toEqual([]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/^error: `kubic clean` needs a git repository/);
    expect(errs[0]).toContain('nothing was removed');
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
    const errs: string[] = [];
    const code = await runCleanCommand(
      {},
      {
        env,
        out: (line: string) => lines.push(line),
        err: (line: string) => errs.push(line),
      },
    );
    expect(code).toBe(1);
    const text = lines.join('\n');
    // The failure is on stderr; stdout carries only what was disposed.
    expect(text).not.toContain('error:');
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/^error: .*agent-1/);
    // Never half-disposed: no branch delete for the worktree that survived.
    expect(text).not.toContain('deleted branch kubic/agent-1');
    expect(text).toContain('deleted branch kubic/agent-2');
  });
});

describe('kubic clean never disposes a live worker (§51 crash recovery)', () => {
  it('skips a worktree whose worker is still running, unless --force', async () => {
    const run = async (
      options: CleanOptions,
      command = 'node kubic.js run --session s-agent-2',
    ) => {
      const env = new FakeExecutionEnv(repoScripts());
      const lines: string[] = [];
      const errs: string[] = [];
      const removed: string[] = [];
      const killed: number[] = [];
      const code = await runCleanCommand(options, {
        env,
        out: (line: string) => lines.push(line),
        err: (line: string) => errs.push(line),
        remover: async (_e: unknown, path: string) => {
          removed.push(path);
        },
        pruneJournal: () => ({ entries: 0, bytes: 0 }),
        liveWorkers: () =>
          new Map([['agent-2', { pid: 4242, sessionId: 's-agent-2' }]]),
        workerCommand: async () => command,
        killWorker: (pid: number) => {
          killed.push(pid);
        },
      });
      return { code, errs: errs.join('\n'), removed, killed };
    };
    const refused = await run({});
    expect(refused.removed).not.toContain('/repo/.kubic/wt/agent-2');
    expect(refused.removed).toContain('/repo/.kubic/wt/agent-1');
    expect(refused.errs).toMatch(/agent-2.*still live.*pid 4242.*--force/);
    expect(refused.code).toBe(1);

    const forced = await run({ force: true });
    expect(forced.removed).toContain('/repo/.kubic/wt/agent-2');
    expect(refused.killed).toEqual([]);
    // --force stops the live worker's process group before disposing.
    expect(forced.killed).toEqual([4242]);

    // A reused pid (command does not name the worker's session) is treated
    // as dead: never killed, and the worktree is disposed.
    const reused = await run({ force: true }, '/usr/bin/vim notes.txt');
    expect(reused.killed).toEqual([]);
    expect(reused.removed).toContain('/repo/.kubic/wt/agent-2');
  });
});
