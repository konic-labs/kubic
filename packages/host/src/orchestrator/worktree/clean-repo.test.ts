// `kubic clean` on a real scratch repository (issue #92; §42.4, §44.1, §78).
// RED first: every disposer acceptance checkbox is proven against real git
// state in a throwaway repo (mkdtempSync + git init — never this repo).
// `--dry-run` mutates nothing, the real run removes retained worktrees +
// branches through the library path (idempotent, one line per removal), and
// git state Kubic did not name is never touched.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeExecutionEnv } from '../../../../exec/src/env.js';
import { runCleanCommand } from './clean.js';

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// stderr is piped, not inherited: `git worktree add` narrates "Preparing
// worktree ..." on stderr, which would otherwise leak into the test output.
// A failing call still throws with that stderr attached.
function git(dir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// realpath: macOS tmpdir is a symlink (/var → /private/var) and git reports
// the resolved toplevel, so the test's root must be the resolved form too.
// Identity and signing are passed per-commit, so the operator's global git
// config (e.g. commit.gpgsign) cannot break or stall the fixture.
function scratchRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kubic-clean-')));
  scratchDirs.push(dir);
  git(dir, ['init', '-q']);
  writeFileSync(join(dir, 'README.md'), '# scratch\n');
  git(dir, ['add', 'README.md']);
  git(dir, [
    '-c',
    'user.email=kubic-test@local',
    '-c',
    'user.name=kubic test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'init',
  ]);
  return dir;
}

function plainDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kubic-clean-plain-')));
  scratchDirs.push(dir);
  return dir;
}

// Exactly how `kubic orchestrate` retains a worker (§44.1).
function retainWorktree(root: string, agent: string): string {
  const path = join(root, '.kubic', 'wt', agent);
  git(root, ['worktree', 'add', path, '-b', `kubic/${agent}`]);
  return path;
}

function worktreeList(root: string): string {
  return git(root, ['worktree', 'list', '--porcelain']);
}

function kubicBranches(root: string): string[] {
  return git(root, ['branch', '--list', 'kubic/*', '--format=%(refname:short)'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function clean(
  root: string,
  args: string[],
  worktreeRoot?: string,
): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runCleanCommand(args, {
    env: new NodeExecutionEnv(root),
    out: (line: string) => lines.push(line),
    ...(worktreeRoot === undefined ? {} : { worktreeRoot }),
  });
  return { code, lines };
}

describe('kubic clean on a scratch repo (issue #92)', () => {
  it('--dry-run lists retained worktrees and branches and mutates nothing', async () => {
    const root = scratchRepo();
    const retained = retainWorktree(root, 'worker-1');
    // A failed orchestrate run leaves uncommitted junk behind — still
    // retained, and still listed by dry-run.
    writeFileSync(join(retained, 'partial.txt'), 'half-written\n');
    const worktreesBefore = worktreeList(root);
    const branchesBefore = kubicBranches(root);

    const { code, lines } = await clean(root, ['--dry-run']);

    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain(`would remove worktree ${retained}`);
    expect(text).toContain('would delete branch kubic/worker-1');
    expect(text).toContain('nothing changed');
    expect(worktreeList(root)).toBe(worktreesBefore);
    expect(kubicBranches(root)).toEqual(branchesBefore);
    expect(existsSync(join(retained, 'partial.txt'))).toBe(true);
  });

  it('removes the retained worktree and branch, one line per removal, and is idempotent', async () => {
    const root = scratchRepo();
    const retained = retainWorktree(root, 'worker-1');

    const { code, lines } = await clean(root, []);

    expect(code).toBe(0);
    expect(lines).toContain(`removed worktree ${retained}`);
    expect(lines).toContain('deleted branch kubic/worker-1');
    expect(existsSync(retained)).toBe(false);
    expect(kubicBranches(root)).toEqual([]);
    expect(worktreeList(root)).not.toContain('.kubic/wt/');
    // The main checkout is never pruned.
    expect(worktreeList(root)).toContain(root);

    const second = await clean(root, []);
    expect(second.code).toBe(0);
    const secondText = second.lines.join('\n');
    expect(secondText).toContain('nothing to prune');
    expect(secondText).not.toContain('removed worktree');
  });

  it('disposes a retained worktree under the configured root (issue #133)', async () => {
    const root = scratchRepo();
    const custom = join(root, '.kubic-custom', 'wt', 'worker-1');
    git(root, ['worktree', 'add', custom, '-b', 'kubic/worker-1']);

    // The composition root threads `[orchestrator].root` here; the default
    // scope would never plan this worktree.
    const { code, lines } = await clean(root, [], '.kubic-custom/wt');

    expect(code).toBe(0);
    expect(lines).toContain(`removed worktree ${custom}`);
    expect(lines).toContain('deleted branch kubic/worker-1');
    expect(existsSync(custom)).toBe(false);
    expect(kubicBranches(root)).toEqual([]);
  });

  it('leaves a hand-made worktree and its branch alone', async () => {
    const root = scratchRepo();
    const handmade = join(root, 'handmade-wt');
    git(root, ['worktree', 'add', handmade, '-b', 'handmade']);
    const retained = retainWorktree(root, 'worker-1');

    const { code, lines } = await clean(root, []);

    expect(code).toBe(0);
    expect(lines).toContain(`removed worktree ${retained}`);
    expect(existsSync(handmade)).toBe(true);
    expect(worktreeList(root)).toContain(handmade);
    expect(worktreeList(root)).not.toContain(retained);
    expect(
      git(root, ['branch', '--list', 'handmade', '--format=%(refname:short)']),
    ).toContain('handmade');
    // Kubic's own retained branch is gone; the hand-made one is intact.
    expect(kubicBranches(root)).toEqual([]);
  });

  it('leaves a namespace-shaped worktree on a foreign branch alone', async () => {
    const root = scratchRepo();
    const foreign = join(root, '.kubic', 'wt', 'fake');
    git(root, ['worktree', 'add', foreign, '-b', 'feature/foreign']);

    const dry = await clean(root, ['--dry-run']);
    const real = await clean(root, []);

    expect(dry.code).toBe(0);
    expect(dry.lines.join('\n')).not.toContain(foreign);
    expect(real.code).toBe(0);
    expect(worktreeList(root)).toContain(foreign);
    expect(
      git(root, [
        'branch',
        '--list',
        'feature/foreign',
        '--format=%(refname:short)',
      ]),
    ).toContain('feature/foreign');
  });

  it('refuses outside a git repo with exit 2 without touching anything', async () => {
    const dir = plainDir();
    writeFileSync(join(dir, 'keep.txt'), 'keep\n');

    for (const args of [[], ['--dry-run']]) {
      const { code, lines } = await clean(dir, args);
      const text = lines.join('\n');
      expect(code).toBe(2);
      expect(text).toContain('needs a git repository');
      expect(text).toContain('nothing was removed');
    }
    expect(existsSync(join(dir, 'keep.txt'))).toBe(true);
  });

  it('rejects an unknown flag with exit 2 and removes nothing', async () => {
    const root = scratchRepo();
    const retained = retainWorktree(root, 'worker-1');

    const { code, lines } = await clean(root, ['--nuke']);

    const text = lines.join('\n');
    expect(code).toBe(2);
    expect(text).toContain('unknown flag --nuke');
    expect(text).toContain('usage: kubic clean');
    expect(existsSync(retained)).toBe(true);
    expect(kubicBranches(root)).toEqual(['kubic/worker-1']);
  });

  it('--session scopes disposal to a failed orchestrate run', async () => {
    const root = scratchRepo();
    const one = retainWorktree(root, 'worker-1');
    const two = retainWorktree(root, 'worker-2');
    const three = retainWorktree(root, 'worker-3');
    const stateDir = join(root, '.kubic', 'orchestrator');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'orch-fail.json'),
      JSON.stringify({
        version: 1,
        sessionId: 'orch-fail',
        prompt: 'demo prompt',
        agents: ['worker-1', 'worker-2'],
        merged: [],
        pending: ['worker-1', 'worker-2'],
        stopped: true,
        records: [],
      }),
    );

    const dry = await clean(root, ['--session', 'orch-fail', '--dry-run']);
    const dryText = dry.lines.join('\n');
    expect(dry.code).toBe(0);
    expect(dryText).toContain(one);
    expect(dryText).toContain(two);
    expect(dryText).not.toContain(three);

    const real = await clean(root, ['--session', 'orch-fail']);
    expect(real.code).toBe(0);
    expect(existsSync(one)).toBe(false);
    expect(existsSync(two)).toBe(false);
    expect(existsSync(three)).toBe(true);
    expect(kubicBranches(root)).toEqual(['kubic/worker-3']);

    const missing = await clean(root, ['--session', 'nope', '--dry-run']);
    expect(missing.code).toBe(1);
    expect(missing.lines.join('\n')).toContain(
      "no retained set for session 'nope'",
    );
  });

  it('--json emits the envelope for dry-run and for real removal', async () => {
    const root = scratchRepo();
    const retained = retainWorktree(root, 'worker-1');

    const dry = await clean(root, ['--dry-run', '--json']);
    const dryEnvelope = JSON.parse(dry.lines.join('\n')) as {
      ok: boolean;
      exitCode: number;
      dryRun: boolean;
      worktrees: { path: string; branch: string }[];
      branches: string[];
    };
    expect(dry.code).toBe(0);
    expect(dryEnvelope.ok).toBe(true);
    expect(dryEnvelope.exitCode).toBe(0);
    expect(dryEnvelope.dryRun).toBe(true);
    expect(dryEnvelope.worktrees).toEqual([
      { path: retained, branch: 'kubic/worker-1' },
    ]);
    expect(dryEnvelope.branches).toEqual(['kubic/worker-1']);
    expect(existsSync(retained)).toBe(true);

    const real = await clean(root, ['--json']);
    const envelope = JSON.parse(real.lines.join('\n')) as {
      dryRun: boolean;
      worktrees: { path: string; branch: string }[];
      branches: string[];
    };
    expect(real.code).toBe(0);
    expect(envelope.dryRun).toBe(false);
    expect(envelope.worktrees).toEqual([
      { path: retained, branch: 'kubic/worker-1' },
    ]);
    expect(envelope.branches).toEqual(['kubic/worker-1']);
    expect(worktreeList(root)).not.toContain('.kubic/wt/');
    expect(kubicBranches(root)).toEqual([]);
  });

  it('--all is the explicit form of the default scope', async () => {
    const root = scratchRepo();
    const one = retainWorktree(root, 'worker-1');
    const two = retainWorktree(root, 'worker-2');

    const explicit = await clean(root, ['--all', '--dry-run']);
    const implicit = await clean(root, ['--dry-run']);

    expect(explicit.code).toBe(0);
    expect(implicit.code).toBe(0);
    expect(explicit.lines).toEqual(implicit.lines);

    const real = await clean(root, ['--all']);
    expect(real.code).toBe(0);
    expect(existsSync(one)).toBe(false);
    expect(existsSync(two)).toBe(false);
    expect(kubicBranches(root)).toEqual([]);
  });

  it('keeps a dirty worktree until --force, then removes it with its branch', async () => {
    const root = scratchRepo();
    const retained = retainWorktree(root, 'worker-1');
    writeFileSync(join(retained, 'wip.txt'), 'wip\n');

    const refused = await clean(root, []);
    const refusedText = refused.lines.join('\n');
    expect(refused.code).toBe(1);
    expect(refusedText).toContain('error:');
    expect(refusedText).toContain('--force');
    expect(existsSync(join(retained, 'wip.txt'))).toBe(true);
    // Never half-disposed: the failed worktree keeps its branch.
    expect(kubicBranches(root)).toEqual(['kubic/worker-1']);

    const forced = await clean(root, ['--force']);
    expect(forced.code).toBe(0);
    expect(existsSync(retained)).toBe(false);
    expect(kubicBranches(root)).toEqual([]);
  });
});
