// `kubic clean`: explicit-only disposal (issue #45, slice 4; #92 §42.4, §44.1, §78).
// RED first: --dry-run prunes nothing, real clean prunes worktrees +
// branches + journal retention, output supports --json, and the refusal
// posture holds on the faux seam before the scratch-repo suite
// (clean-repo.test.ts) proves it against real git.
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeExecutionEnv } from '../../../../exec/src/env.js';
import { createNodeFileBridge } from '../../../../exec/src/file-bridge.js';
import { FileJournalStore } from '../../../../exec/src/journal.js';
import {
  createSession,
  openSessionStore,
} from '../../../../worker/src/lane/session-store.js';
import { BACKGROUND_CONTEXT } from '../../../../worker/src/pi-boundary.js';
import {
  type CleanOptions,
  cleanDepsWithDefaults,
  planClean,
  planSessionClean,
  runCleanCommand,
} from './clean.js';

// Issue #337: temp workspaces for the real (non-injected) prune path.
const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

import type { FakeSpawnCall } from '../../../../exec/src/env.js';
import type { WorktreeEntry } from './list.js';
import { parseWorktreePorcelain } from './list.js';

// Exact argv issued, in order (issue #212).
function argvOf(env: FakeExecutionEnv): string[] {
  return env.calls.map(
    (call: FakeSpawnCall) => `${call.cmd} ${call.args.join(' ')}`,
  );
}

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
    // Issue #146: the delete default is safe (`-d`); only --force uses -D.
    // The probe reports every fixture branch merged unless a test overrides.
    'git branch -d kubic/agent-1': { exitCode: 0, stdout: '', stderr: '' },
    'git branch -d kubic/agent-2': { exitCode: 0, stdout: '', stderr: '' },
    'git branch -d kubic/agent-3': { exitCode: 0, stdout: '', stderr: '' },
    'git branch -D kubic/agent-1': { exitCode: 0, stdout: '', stderr: '' },
    'git branch -D kubic/agent-2': { exitCode: 0, stdout: '', stderr: '' },
    'git branch -D kubic/agent-3': { exitCode: 0, stdout: '', stderr: '' },
    'git -C /repo merge-base --is-ancestor kubic/agent-1 HEAD': {
      exitCode: 0,
      stdout: '',
      stderr: '',
    },
    'git -C /repo merge-base --is-ancestor kubic/agent-2 HEAD': {
      exitCode: 0,
      stdout: '',
      stderr: '',
    },
    'git -C /repo merge-base --is-ancestor kubic/agent-3 HEAD': {
      exitCode: 0,
      stdout: '',
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
    ...extra,
  };
}

describe('kubic clean (issue #45, #92)', () => {
  it('dry-run plans prunes but removes nothing', async () => {
    const env = new FakeExecutionEnv(repoScripts(), { strict: true });
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
        pruneJournal: async () => {
          journalCalls += 1;
          return { entries: 0, bytes: 0, overBound: 0 };
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
    // A dry run plans only: resolve, list, branch list, one read-only
    // merge probe per branch (issue #146) — no remover, no branch delete,
    // no prune.
    expect(argvOf(env)).toEqual([
      'git rev-parse --show-toplevel',
      'git worktree list --porcelain',
      'git branch --list kubic/* --format=%(refname:short)',
      'git -C /repo merge-base --is-ancestor kubic/agent-1 HEAD',
      'git -C /repo merge-base --is-ancestor kubic/agent-2 HEAD',
      'git -C /repo merge-base --is-ancestor kubic/agent-3 HEAD',
    ]);
  });

  it('real clean prunes worktrees and branches and applies journal retention', async () => {
    const env = new FakeExecutionEnv(repoScripts(), { strict: true });
    const lines: string[] = [];
    const errs: string[] = [];
    const policies: unknown[] = [];
    const code = await runCleanCommand(
      { maxAgeMs: 3600000, json: true },
      {
        env,
        out: (line: string) => lines.push(line),
        err: (line: string) => errs.push(line),
        pruneJournal: async (policy: unknown) => {
          policies.push(policy);
          return { entries: 4, bytes: 1024, overBound: 0 };
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
    // Full disposal order, pinned: each branch is merge-probed before its
    // worktree is removed before its branch is deleted (never
    // half-disposed), prune runs last. The delete default is safe `-d`
    // (issue #146); only --force escalates to -D.
    expect(argvOf(env)).toEqual([
      'git rev-parse --show-toplevel',
      'git worktree list --porcelain',
      'git branch --list kubic/* --format=%(refname:short)',
      'git -C /repo merge-base --is-ancestor kubic/agent-1 HEAD',
      'git worktree remove /repo/.kubic/wt/agent-1',
      'git branch -d kubic/agent-1',
      'git -C /repo merge-base --is-ancestor kubic/agent-2 HEAD',
      'git worktree remove /repo/.kubic/wt/agent-2',
      'git branch -d kubic/agent-2',
      'git -C /repo merge-base --is-ancestor kubic/agent-3 HEAD',
      'git worktree remove /repo/.kubic/wt/agent-3',
      'git branch -d kubic/agent-3',
      'git worktree prune',
    ]);
  });

  it('--journal alone prunes to the store default byte bound', async () => {
    const env = new FakeExecutionEnv(repoScripts(), { strict: true });
    const lines: string[] = [];
    const errs: string[] = [];
    const policies: { maxBytes?: number; maxAgeMs?: number }[] = [];
    const code = await runCleanCommand(
      { journal: true },
      {
        env,
        out: (line: string) => lines.push(line),
        err: (line: string) => errs.push(line),
        pruneJournal: async (policy: {
          maxBytes?: number;
          maxAgeMs?: number;
        }) => {
          policies.push(policy);
          return { entries: 2, bytes: 64, overBound: 0 };
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
    const env = new FakeExecutionEnv(
      {
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
      },
      { strict: true },
    );
    const lines: string[] = [];
    const errs: string[] = [];
    const code = await runCleanCommand(
      { journal: true, maxBytes: 10 },
      {
        env,
        out: (line: string) => lines.push(line),
        err: (line: string) => errs.push(line),
        pruneJournal: async () => ({ entries: 3, bytes: 99, overBound: 0 }),
      },
    );
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('journal: pruned 3 entr(ies), freed 99 byte(s)');
    expect(text).not.toContain('nothing to prune');
  });

  // Issue #348: the newest entry is never dropped, so a bound it alone
  // exceeds is reported rather than silently ignored.
  it('reports an over-bound journal whose newest entry was kept', async () => {
    const env = new FakeExecutionEnv(repoScripts(), { strict: true });
    const lines: string[] = [];
    const errs: string[] = [];
    const code = await runCleanCommand(
      { journal: true, maxBytes: 10 },
      {
        env,
        out: (line: string) => lines.push(line),
        err: (line: string) => errs.push(line),
        pruneJournal: async () => ({ entries: 4, bytes: 1024, overBound: 7 }),
      },
    );
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain(
      'journal: pruned 4 entr(ies), freed 1024 byte(s), over bound by 7 byte(s) (newest entry kept)',
    );
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
    const env = new FakeExecutionEnv(
      repoScripts({
        'git -C /repo merge-base --is-ancestor kubic/agent-7 HEAD': {
          exitCode: 0,
          stdout: '',
          stderr: '',
        },
      }),
      { strict: true },
    );
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
    const env = new FakeExecutionEnv(repoScripts(), { strict: true });
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

  it('refuses outside a git repo with exit 5 and mutates nothing', async () => {
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
    expect(code).toBe(5);
    expect(removals).toBe(0);
    // The refusal is a diagnostic: stderr, one logger line, stdout empty.
    expect(lines).toEqual([]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/^error: `kubic clean` needs a git repository/);
    expect(errs[0]).toContain('nothing was removed');

    // Under --json the refusal is the same one-document envelope a run
    // emits (issue #372): exitCode 5, nothing planned, nothing touched.
    const jsonLines: string[] = [];
    const jsonErrs: string[] = [];
    const jsonCode = await runCleanCommand(
      { json: true },
      {
        env,
        out: (line: string) => jsonLines.push(line),
        err: (line: string) => jsonErrs.push(line),
        remover: async () => {
          removals += 1;
        },
      },
    );
    expect(jsonCode).toBe(5);
    expect(removals).toBe(0);
    expect(jsonLines).toHaveLength(1);
    expect(JSON.parse(jsonLines[0] as string)).toEqual({
      ok: false,
      exitCode: 5,
      dryRun: false,
      worktrees: [],
      branches: [],
      journal: { entries: 0, bytes: 0, overBound: 0 },
    });
    expect(jsonErrs).toHaveLength(1);
    expect(jsonErrs[0]).toMatch(/needs a git repository/);
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
      { strict: true },
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

describe('kubic clean keeps unmerged branches without --force (issue #146)', () => {
  // RED first: the merge probe does not exist yet, so the strict fake
  // throws on the merge-base argv and plain clean deletes the branch —
  // every assertion below fails until the probe and the `-d` default land.
  const MERGED = {
    'git -C /repo merge-base --is-ancestor kubic/agent-1 HEAD': {
      exitCode: 0,
      stdout: '',
      stderr: '',
    },
    'git -C /repo merge-base --is-ancestor kubic/agent-2 HEAD': {
      exitCode: 0,
      stdout: '',
      stderr: '',
    },
    'git -C /repo merge-base --is-ancestor kubic/agent-3 HEAD': {
      exitCode: 0,
      stdout: '',
      stderr: '',
    },
  };
  const UNMERGED_AGENT_1 = {
    ...MERGED,
    'git -C /repo merge-base --is-ancestor kubic/agent-1 HEAD': {
      exitCode: 1,
      stdout: '',
      stderr: '',
    },
  };

  it('dry-run marks an unmerged branch would-refuse and removes nothing', async () => {
    const env = new FakeExecutionEnv(repoScripts(UNMERGED_AGENT_1), {
      strict: true,
    });
    const lines: string[] = [];
    const removed: string[] = [];
    const code = await runCleanCommand(
      { dryRun: true },
      {
        env,
        out: (line: string) => lines.push(line),
        err: () => {},
        remover: async (_e: unknown, path: string) => {
          removed.push(path);
        },
      },
    );
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toMatch(/would refuse: unmerged branch kubic\/agent-1/);
    expect(text).not.toContain('would remove worktree /repo/.kubic/wt/agent-1');
    expect(text).toContain('would remove worktree /repo/.kubic/wt/agent-2');
    expect(removed).toEqual([]);
  });

  it('plain clean skips the unmerged worktree and branch, exits 1', async () => {
    const env = new FakeExecutionEnv(repoScripts(UNMERGED_AGENT_1), {
      strict: true,
    });
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
    expect(errs.join('\n')).toMatch(/unmerged branch kubic\/agent-1.*--force/);
    const text = lines.join('\n');
    expect(text).not.toContain('removed worktree /repo/.kubic/wt/agent-1');
    expect(text).not.toContain('deleted branch kubic/agent-1');
    expect(text).toContain('deleted branch kubic/agent-2');
  });

  it('--force deletes the unmerged worktree and branch', async () => {
    const env = new FakeExecutionEnv(
      repoScripts({
        ...UNMERGED_AGENT_1,
        'git worktree remove /repo/.kubic/wt/agent-1 --force': {
          exitCode: 0,
          stdout: '',
          stderr: '',
        },
        'git worktree remove /repo/.kubic/wt/agent-2 --force': {
          exitCode: 0,
          stdout: '',
          stderr: '',
        },
        'git worktree remove /repo/.kubic/wt/agent-3 --force': {
          exitCode: 0,
          stdout: '',
          stderr: '',
        },
      }),
      { strict: true },
    );
    const lines: string[] = [];
    const code = await runCleanCommand(
      { force: true },
      {
        env,
        out: (line: string) => lines.push(line),
        err: () => {},
      },
    );
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('removed worktree /repo/.kubic/wt/agent-1');
    expect(text).toContain('deleted branch kubic/agent-1');
  });

  it('--json names the refused branch in failures', async () => {
    const env = new FakeExecutionEnv(repoScripts(UNMERGED_AGENT_1), {
      strict: true,
    });
    const lines: string[] = [];
    const code = await runCleanCommand(
      { json: true },
      {
        env,
        out: (line: string) => lines.push(line),
        err: () => {},
      },
    );
    expect(code).toBe(1);
    const doc = JSON.parse(lines.join('')) as {
      ok: boolean;
      exitCode: number;
      failures: { target: string; message: string }[];
    };
    expect(doc.ok).toBe(false);
    expect(doc.exitCode).toBe(1);
    expect(doc.failures).toContainEqual({
      target: 'kubic/agent-1',
      message: expect.stringContaining('--force') as unknown as string,
    });
  });
});

describe('kubic clean never disposes a live worker (§51 crash recovery)', () => {
  it('skips a worktree whose worker is still running, unless --force', async () => {
    const run = async (
      options: CleanOptions,
      command = 'node kubic.js run --session s-agent-2',
    ) => {
      const env = new FakeExecutionEnv(repoScripts(), { strict: true });
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
        pruneJournal: async () => ({ entries: 0, bytes: 0, overBound: 0 }),
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

describe('kubic clean --session is scoped to its own session (issue #144)', () => {
  const run = async (liveSession: string) => {
    const removed: string[] = [];
    const deleted: string[] = [];
    const killed: number[] = [];
    const errs: string[] = [];
    const code = await runCleanCommand(
      { sessionId: 'sa', force: true },
      {
        env: new FakeExecutionEnv(repoScripts(), { strict: true }),
        out: () => undefined,
        err: (line: string) => errs.push(line),
        repoRoot: '/repo',
        sessionAgents: () => ['worker-1'],
        // What session `sa` left behind: its own retained tree and branch.
        lister: async () => [
          {
            path: '/repo/.kubic/wt/sa/worker-1',
            branch: 'kubic/sa/worker-1',
            bare: false,
            detached: false,
          },
        ],
        branchLister: async () => ['kubic/sa/worker-1'],
        retireSessionState: () => undefined,
        remover: async (_e: unknown, path: string) => {
          removed.push(path);
        },
        branchDeleter: async (_e: unknown, branch: string) => {
          deleted.push(branch);
        },
        pruner: async () => undefined,
        pruneJournal: async () => ({ entries: 0, bytes: 0, overBound: 0 }),
        liveWorkers: () =>
          new Map([['worker-1', { pid: 4242, sessionId: liveSession }]]),
        workerCommand: async () => `node kubic.js run --session ${liveSession}`,
        killWorker: (pid: number) => {
          killed.push(pid);
        },
      },
    );
    return { code, removed, deleted, killed, errs };
  };

  it('retires the session state only after a failure-free disposal, naming the session and repo', async () => {
    const retired: string[][] = [];
    const runWith = async (
      overrides: Partial<Parameters<typeof runCleanCommand>[1]>,
    ) => {
      const out: string[] = [];
      const errs: string[] = [];
      const code = await runCleanCommand(
        { sessionId: 'sa', force: true },
        {
          env: new FakeExecutionEnv(repoScripts(), { strict: true }),
          out: (line: string) => out.push(line),
          err: (line: string) => errs.push(line),
          repoRoot: '/repo',
          sessionAgents: () => ['worker-1'],
          lister: async () => [
            {
              path: '/repo/.kubic/wt/sa/worker-1',
              branch: 'kubic/sa/worker-1',
              bare: false,
              detached: false,
            },
          ],
          branchLister: async () => ['kubic/sa/worker-1'],
          remover: async () => undefined,
          branchDeleter: async () => undefined,
          pruner: async () => undefined,
          pruneJournal: async () => ({ entries: 0, bytes: 0, overBound: 0 }),
          liveWorkers: () => new Map(),
          retireSessionState: (session: string, repo: string) => {
            retired.push([session, repo]);
          },
          ...overrides,
        },
      );
      return { code, out, errs };
    };
    const ok = await runWith({});
    expect(ok.code).toBe(0);
    expect(retired).toEqual([['sa', '/repo']]);
    expect(ok.out).toContain(
      'retired session state /repo/.kubic/orchestrator/sa.json',
    );
    // A failing branch delete leaves the worktree gone but the disposal
    // incomplete: the state stays.
    retired.length = 0;
    const failed = await runWith({
      branchDeleter: async () => {
        throw new Error('branch is checked out elsewhere');
      },
    });
    expect(failed.code).toBe(1);
    expect(retired).toEqual([]);
    expect(failed.out.join('\n')).not.toContain('retired session state');
    // A state that cannot be removed is a reported failure, not silence.
    const stuck = await runWith({
      retireSessionState: () => {
        throw new Error('read-only file system');
      },
    });
    expect(stuck.code).toBe(1);
    expect(stuck.errs.join('\n')).toContain('read-only file system');
  });

  it('plans only kubic/<session>/<agent> and never kills another session’s same-named worker', async () => {
    const other = await run('sb-worker-1');
    expect(other.code, other.errs.join('\n')).toBe(0);
    expect(other.removed).toEqual(['/repo/.kubic/wt/sa/worker-1']);
    expect(other.deleted).toEqual(['kubic/sa/worker-1']);
    expect(other.killed).toEqual([]);

    const own = await run('sa-worker-1');
    expect(own.killed).toEqual([4242]);
  });
});

// Issue #337: `kubic clean --journal` is a destructive pass over the whole
// journal — under a live writer it can drop entries the run just appended and
// delete blobs it just wrote. It steps aside, and says so.
describe('kubic clean steps aside for a live journal writer (issue #337)', () => {
  function repoWithJournal(): { repoRoot: string; journalDir: string } {
    const repoRoot = mkdtempSync(join(tmpdir(), 'clean337-'));
    scratch.push(repoRoot);
    const journalDir = join(repoRoot, '.kubic', 'journal');
    mkdirSync(join(journalDir, 'blobs'), { recursive: true });
    const store = new FileJournalStore(journalDir);
    store.append({
      path: 'a.txt',
      op: 'write',
      before: null,
      after: 'a\n',
      bytesDelta: 2,
      sessionId: 's1',
      agentId: 'root',
      toolCallId: null,
      timestamp: 100,
    });
    return { repoRoot, journalDir };
  }

  function envFor(repoRoot: string): FakeExecutionEnv {
    return new FakeExecutionEnv(
      {
        'git rev-parse --show-toplevel': {
          exitCode: 0,
          stdout: `${repoRoot}\n`,
          stderr: '',
        },
        'git worktree list --porcelain': {
          exitCode: 0,
          stdout: `worktree ${repoRoot}\nHEAD abc\nbranch refs/heads/main\n`,
          stderr: '',
        },
        'git branch --list kubic/* --format=%(refname:short)': {
          exitCode: 0,
          stdout: '',
          stderr: '',
        },
        'git worktree prune': { exitCode: 0, stdout: '', stderr: '' },
      },
      { strict: true },
    );
  }

  it('skips the prune and names the holder', async () => {
    const { repoRoot, journalDir } = repoWithJournal();
    const indexPath = join(journalDir, 'index.jsonl');
    const before = readFileSync(indexPath, 'utf8');
    // A live writer's lock: the pid `withFileLocked` writes.
    writeFileSync(`${indexPath}.lock`, String(process.pid));
    const lines: string[] = [];
    const errs: string[] = [];
    const code = await runCleanCommand(
      { journal: true, maxAgeMs: 1 },
      cleanDepsWithDefaults({
        env: envFor(repoRoot),
        out: (l) => lines.push(l),
        err: (l) => errs.push(l),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain(
      `journal: prune skipped — the journal is in use (pid ${process.pid})`,
    );
    expect(readFileSync(indexPath, 'utf8')).toBe(before);
    expect(readdirSync(join(journalDir, 'blobs'))).toHaveLength(1);

    // Control: with the holder gone the same invocation prunes (the aged
    // entry is dropped and its blob swept).
    rmSync(`${indexPath}.lock`);
    const after: string[] = [];
    const code2 = await runCleanCommand(
      { journal: true, maxAgeMs: 1 },
      cleanDepsWithDefaults({
        env: envFor(repoRoot),
        out: (l) => after.push(l),
        err: () => undefined,
      }),
    );
    expect(code2).toBe(0);
    expect(after.join('\n')).toMatch(/journal: pruned 1 entr\(ies\)/);
    expect(readFileSync(indexPath, 'utf8')).not.toBe(before);
    expect(readdirSync(join(journalDir, 'blobs'))).toHaveLength(0);
  });
});

// `kubic clean --journal` prunes session journals (issue #367): the legacy
// workspace store is one no run writes to, so the bounds must reach the
// session journals under the sessions root whose recorded cwd is this
// workspace (plus the legacy store), reported per session.
// RED first: the default pruner opens only the dead store, so every
// session assertion below fails until the session walk lands.
describe('kubic clean --journal prunes session journals (issue #367)', () => {
  async function makeSession(
    sessionsRoot: string,
    id: string,
    cwd: string,
  ): Promise<void> {
    const store = openSessionStore(
      sessionsRoot,
      createNodeFileBridge(sessionsRoot),
    );
    const handle = await createSession(store, { id, cwd }, BACKGROUND_CONTEXT);
    await handle.release(BACKGROUND_CONTEXT);
  }

  function appendJournal(
    sessionsRoot: string,
    id: string,
    timestamp: number,
    body: string,
  ): void {
    new FileJournalStore(join(sessionsRoot, id, 'journal')).append({
      path: 'a.txt',
      op: 'write',
      before: null,
      after: body,
      bytesDelta: body.length,
      sessionId: id,
      agentId: 'root',
      toolCallId: null,
      timestamp,
    });
  }

  function fakeRepo(repoRoot: string): FakeExecutionEnv {
    return new FakeExecutionEnv(
      {
        'git rev-parse --show-toplevel': {
          exitCode: 0,
          stdout: `${repoRoot}\n`,
          stderr: '',
        },
        'git worktree list --porcelain': {
          exitCode: 0,
          stdout: `worktree ${repoRoot}\nHEAD abc\nbranch refs/heads/main\n`,
          stderr: '',
        },
        'git branch --list kubic/* --format=%(refname:short)': {
          exitCode: 0,
          stdout: '',
          stderr: '',
        },
        'git worktree prune': { exitCode: 0, stdout: '', stderr: '' },
      },
      { strict: true },
    );
  }

  interface SessionRow {
    sessionId: string;
    entries: number;
    bytes: number;
  }

  function sessionRows(lines: string[]): SessionRow[] {
    const doc = JSON.parse(lines.join('')) as {
      journal: { sessions?: SessionRow[] };
    };
    return doc.journal.sessions ?? [];
  }

  it('prunes this workspace session journal with --max-bytes 1', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'clean367-repo-'));
    scratch.push(repoRoot);
    const sessionsRoot = mkdtempSync(join(tmpdir(), 'clean367-sess-'));
    scratch.push(sessionsRoot);
    await makeSession(sessionsRoot, 'ws-one', repoRoot);
    appendJournal(sessionsRoot, 'ws-one', 100, `${'x'.repeat(100)}\n`);
    appendJournal(sessionsRoot, 'ws-one', 200, `${'y'.repeat(100)}\n`);
    appendJournal(sessionsRoot, 'ws-one', 300, `${'z'.repeat(100)}\n`);

    const lines: string[] = [];
    const code = await runCleanCommand(
      { journal: true, maxBytes: 1, json: true },
      cleanDepsWithDefaults({
        env: fakeRepo(repoRoot),
        out: (l) => lines.push(l),
        err: () => undefined,
        sessionsRoot,
      }),
    );
    expect(code).toBe(0);
    const rows = sessionRows(lines);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionId).toBe('ws-one');
    expect(rows[0]?.entries ?? 0).toBeGreaterThan(0);
    expect(rows[0]?.bytes ?? 0).toBeGreaterThan(0);
  });

  it('prunes two aged sessions and reports each', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'clean367-repo-'));
    scratch.push(repoRoot);
    const sessionsRoot = mkdtempSync(join(tmpdir(), 'clean367-sess-'));
    scratch.push(sessionsRoot);
    await makeSession(sessionsRoot, 'ws-one', repoRoot);
    await makeSession(sessionsRoot, 'ws-two', repoRoot);
    appendJournal(sessionsRoot, 'ws-one', 100, 'old one\n');
    appendJournal(sessionsRoot, 'ws-two', 100, 'old two\n');

    const lines: string[] = [];
    const text: string[] = [];
    const code = await runCleanCommand(
      { journal: true, maxAgeMs: 1 },
      cleanDepsWithDefaults({
        env: fakeRepo(repoRoot),
        out: (l) => text.push(l),
        err: () => undefined,
        sessionsRoot,
      }),
    );
    expect(code).toBe(0);
    const joined = text.join('\n');
    expect(joined).toContain('for session ws-one');
    expect(joined).toContain('for session ws-two');
    const code2 = await runCleanCommand(
      { journal: true, maxAgeMs: 1, json: true },
      cleanDepsWithDefaults({
        env: fakeRepo(repoRoot),
        out: (l) => lines.push(l),
        err: () => undefined,
        sessionsRoot,
      }),
    );
    expect(code2).toBe(0);
    const ids = sessionRows(lines)
      .map((row) => row.sessionId)
      .sort();
    expect(ids).toEqual(['ws-one', 'ws-two']);
  });

  it('leaves other workspaces alone unless --all-sessions', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'clean367-repo-'));
    scratch.push(repoRoot);
    const otherRoot = mkdtempSync(join(tmpdir(), 'clean367-other-'));
    scratch.push(otherRoot);
    const sessionsRoot = mkdtempSync(join(tmpdir(), 'clean367-sess-'));
    scratch.push(sessionsRoot);
    await makeSession(sessionsRoot, 'ws-one', repoRoot);
    await makeSession(sessionsRoot, 'other-one', otherRoot);
    appendJournal(sessionsRoot, 'ws-one', 100, 'mine\n');
    appendJournal(sessionsRoot, 'other-one', 100, 'theirs\n');
    const indexPath = join(sessionsRoot, 'other-one', 'journal', 'index.jsonl');
    const before = readFileSync(indexPath, 'utf8');

    const lines: string[] = [];
    const code = await runCleanCommand(
      { journal: true, maxAgeMs: 1, json: true },
      cleanDepsWithDefaults({
        env: fakeRepo(repoRoot),
        out: (l) => lines.push(l),
        err: () => undefined,
        sessionsRoot,
      }),
    );
    expect(code).toBe(0);
    expect(sessionRows(lines).map((row) => row.sessionId)).toEqual(['ws-one']);
    expect(readFileSync(indexPath, 'utf8')).toBe(before);

    const allLines: string[] = [];
    const code2 = await runCleanCommand(
      { journal: true, maxAgeMs: 1, json: true, allSessions: true },
      cleanDepsWithDefaults({
        env: fakeRepo(repoRoot),
        out: (l) => allLines.push(l),
        err: () => undefined,
        sessionsRoot,
      }),
    );
    expect(code2).toBe(0);
    expect(
      sessionRows(allLines)
        .map((row) => row.sessionId)
        .sort(),
    ).toEqual(['other-one', 'ws-one']);
  });

  it('--session limits pruning to that journal', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'clean367-repo-'));
    scratch.push(repoRoot);
    const sessionsRoot = mkdtempSync(join(tmpdir(), 'clean367-sess-'));
    scratch.push(sessionsRoot);
    await makeSession(sessionsRoot, 'ws-one', repoRoot);
    await makeSession(sessionsRoot, 'ws-two', repoRoot);
    appendJournal(sessionsRoot, 'ws-one', 100, 'one\n');
    appendJournal(sessionsRoot, 'ws-two', 100, 'two\n');
    const otherIndex = join(sessionsRoot, 'ws-two', 'journal', 'index.jsonl');
    const before = readFileSync(otherIndex, 'utf8');

    const lines: string[] = [];
    const code = await runCleanCommand(
      { journal: true, maxAgeMs: 1, json: true, sessionId: 'ws-one' },
      {
        ...cleanDepsWithDefaults({
          env: fakeRepo(repoRoot),
          out: (l) => lines.push(l),
          err: () => undefined,
          sessionsRoot,
        }),
        sessionAgents: () => ['worker-1'],
      },
    );
    expect(code).toBe(0);
    expect(sessionRows(lines).map((row) => row.sessionId)).toEqual(['ws-one']);
    expect(readFileSync(otherIndex, 'utf8')).toBe(before);
  });

  it('refuses a session id outside the pattern before pruning anything', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'clean367-repo-'));
    scratch.push(repoRoot);
    const sessionsRoot = mkdtempSync(join(tmpdir(), 'clean367-sess-'));
    scratch.push(sessionsRoot);
    await makeSession(sessionsRoot, 'ws-one', repoRoot);
    appendJournal(sessionsRoot, 'ws-one', 100, 'one\n');
    const indexPath = join(sessionsRoot, 'ws-one', 'journal', 'index.jsonl');
    const before = readFileSync(indexPath, 'utf8');

    const code = await runCleanCommand(
      { journal: true, maxAgeMs: 1, sessionId: '../evil' },
      cleanDepsWithDefaults({
        env: fakeRepo(repoRoot),
        out: () => undefined,
        err: () => undefined,
        sessionsRoot,
      }),
    );
    expect(code).toBe(2);
    expect(readFileSync(indexPath, 'utf8')).toBe(before);
  });

  it('skips a live-locked session journal and says so', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'clean367-repo-'));
    scratch.push(repoRoot);
    const sessionsRoot = mkdtempSync(join(tmpdir(), 'clean367-sess-'));
    scratch.push(sessionsRoot);
    await makeSession(sessionsRoot, 'ws-one', repoRoot);
    appendJournal(sessionsRoot, 'ws-one', 100, 'one\n');
    const indexPath = join(sessionsRoot, 'ws-one', 'journal', 'index.jsonl');
    const before = readFileSync(indexPath, 'utf8');
    writeFileSync(`${indexPath}.lock`, String(process.pid));

    const text: string[] = [];
    const code = await runCleanCommand(
      { journal: true, maxAgeMs: 1 },
      cleanDepsWithDefaults({
        env: fakeRepo(repoRoot),
        out: (l) => text.push(l),
        err: () => undefined,
        sessionsRoot,
      }),
    );
    expect(code).toBe(0);
    expect(text.join('\n')).toContain(
      `journal: prune skipped — session ws-one journal is in use (pid ${process.pid})`,
    );
    expect(readFileSync(indexPath, 'utf8')).toBe(before);
  });

  it('dry-run names prunable sessions and changes nothing', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'clean367-repo-'));
    scratch.push(repoRoot);
    const sessionsRoot = mkdtempSync(join(tmpdir(), 'clean367-sess-'));
    scratch.push(sessionsRoot);
    await makeSession(sessionsRoot, 'ws-one', repoRoot);
    appendJournal(sessionsRoot, 'ws-one', 100, 'one\n');
    const indexPath = join(sessionsRoot, 'ws-one', 'journal', 'index.jsonl');
    const before = readFileSync(indexPath, 'utf8');

    const text: string[] = [];
    const code = await runCleanCommand(
      { journal: true, maxAgeMs: 1, dryRun: true },
      cleanDepsWithDefaults({
        env: fakeRepo(repoRoot),
        out: (l) => text.push(l),
        err: () => undefined,
        sessionsRoot,
      }),
    );
    expect(code).toBe(0);
    expect(text.join('\n')).toContain('would prune journal for session ws-one');
    expect(readFileSync(indexPath, 'utf8')).toBe(before);
  });
});
