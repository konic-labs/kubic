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
import { type CleanOptions, runCleanCommand } from './clean.js';

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
// Issue #144: an orchestrate run names its trees `<session>/<agent>`.
function retainWorktree(root: string, agent: string, session?: string): string {
  const scoped = session === undefined ? agent : `${session}/${agent}`;
  const path = join(root, '.kubic', 'wt', scoped);
  git(root, ['worktree', 'add', path, '-b', `kubic/${scoped}`]);
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
  options: CleanOptions,
  worktreeRoot?: string,
): Promise<{ code: number; lines: string[]; errs: string[] }> {
  const lines: string[] = [];
  const errs: string[] = [];
  const code = await runCleanCommand(options, {
    env: new NodeExecutionEnv(root),
    out: (line: string) => lines.push(line),
    err: (line: string) => errs.push(line),
    ...(worktreeRoot === undefined ? {} : { worktreeRoot }),
  });
  return { code, lines, errs };
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

    const { code, lines } = await clean(root, { dryRun: true });

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

    const { code, lines } = await clean(root, {});

    expect(code).toBe(0);
    expect(lines).toContain(`removed worktree ${retained}`);
    expect(lines).toContain('deleted branch kubic/worker-1');
    expect(existsSync(retained)).toBe(false);
    expect(kubicBranches(root)).toEqual([]);
    expect(worktreeList(root)).not.toContain('.kubic/wt/');
    // The main checkout is never pruned.
    expect(worktreeList(root)).toContain(root);

    const second = await clean(root, {});
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
    const { code, lines } = await clean(root, {}, '.kubic-custom/wt');

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

    const { code, lines } = await clean(root, {});

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

    const dry = await clean(root, { dryRun: true });
    const real = await clean(root, {});

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

    for (const options of [{}, { dryRun: true }]) {
      const { code, lines, errs } = await clean(dir, options);
      expect(lines).toEqual([]);
      const text = errs.join('\n');
      expect(code).toBe(2);
      expect(text).toContain('needs a git repository');
      expect(text).toContain('nothing was removed');
    }
    expect(existsSync(join(dir, 'keep.txt'))).toBe(true);
  });

  it('--session scopes disposal to a failed orchestrate run', async () => {
    const root = scratchRepo();
    const one = retainWorktree(root, 'worker-1', 'orch-fail');
    const two = retainWorktree(root, 'worker-2', 'orch-fail');
    // Another session's same-named agent is never planned (issue #144).
    const three = retainWorktree(root, 'worker-1', 'orch-other');
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

    const dry = await clean(root, { sessionId: 'orch-fail', dryRun: true });
    const dryText = dry.lines.join('\n');
    expect(dry.code).toBe(0);
    expect(dryText).toContain(one);
    expect(dryText).toContain(two);
    expect(dryText).not.toContain(three);

    const real = await clean(root, { sessionId: 'orch-fail' });
    expect(real.code).toBe(0);
    expect(existsSync(one)).toBe(false);
    expect(existsSync(two)).toBe(false);
    expect(existsSync(three)).toBe(true);
    expect(kubicBranches(root)).toEqual(['kubic/orch-other/worker-1']);

    const missing = await clean(root, { sessionId: 'nope', dryRun: true });
    expect(missing.code).toBe(1);
    expect(missing.errs.join('\n')).toContain(
      "no retained set for session 'nope'",
    );
  });

  it('--session removes the session directory it emptied, and only that one (issue #144)', async () => {
    const root = scratchRepo();
    const one = retainWorktree(root, 'worker-1', 'orch-fail');
    retainWorktree(root, 'worker-2', 'orch-fail');
    const other = retainWorktree(root, 'worker-1', 'orch-other');
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
    const sessionDir = join(root, '.kubic', 'wt', 'orch-fail');
    expect(existsSync(sessionDir)).toBe(true);

    // A dry run mutates nothing, the session directory included.
    await clean(root, { sessionId: 'orch-fail', dryRun: true });
    expect(existsSync(one)).toBe(true);
    expect(existsSync(sessionDir)).toBe(true);

    const real = await clean(root, { sessionId: 'orch-fail' });
    expect(real.code).toBe(0);
    expect(existsSync(one)).toBe(false);
    // The emptied session directory is gone; nothing else is.
    expect(existsSync(sessionDir)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(join(root, '.kubic', 'wt', 'orch-other'))).toBe(true);
    expect(existsSync(join(root, '.kubic', 'wt'))).toBe(true);
  });

  describe('a full --session clean retires the session state so the id can be reused (issue #144)', () => {
    const writeState = (root: string, session: string, agents: string[]) => {
      const stateDir = join(root, '.kubic', 'orchestrator');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, `${session}.json`),
        JSON.stringify({
          version: 1,
          sessionId: session,
          prompt: 'p',
          agents,
          merged: [],
          pending: agents,
          stopped: false,
          records: [],
        }),
      );
      return join(stateDir, `${session}.json`);
    };

    // Approvals state a run leaves under `approvals/<session>/` (the full-access
    // record, memoized decisions, the ask mailbox) beside the repo-wide ledger.
    const writeApprovals = (root: string, session: string) => {
      const dir = join(root, '.kubic', 'orchestrator', 'approvals', session);
      mkdirSync(join(dir, 'asks'), { recursive: true });
      writeFileSync(join(dir, 'skip-records.json'), '[{"sessionId":"x"}]');
      writeFileSync(join(dir, 'decisions.json'), '{"k":{"approved":true}}');
      writeFileSync(join(dir, 'asks', 'a.json'), '{}');
      return dir;
    };
    const writeLedger = (root: string) => {
      const ledger = join(
        root,
        '.kubic',
        'orchestrator',
        'approvals',
        'audit.jsonl',
      );
      mkdirSync(join(ledger, '..'), { recursive: true });
      writeFileSync(ledger, '{"row":1}\n');
      return ledger;
    };

    it('removes exactly that session\u2019s state file once all its worktrees are gone', async () => {
      const root = scratchRepo();
      retainWorktree(root, 'worker-1', 'sess-a');
      retainWorktree(root, 'worker-2', 'sess-a');
      retainWorktree(root, 'worker-1', 'sess-b');
      const stateA = writeState(root, 'sess-a', ['worker-1', 'worker-2']);
      const stateB = writeState(root, 'sess-b', ['worker-1']);
      const real = await clean(root, { sessionId: 'sess-a' });
      expect(real.code, real.errs.join('\n')).toBe(0);
      expect(existsSync(stateA)).toBe(false);
      // Another session's state is never touched.
      expect(existsSync(stateB)).toBe(true);
      expect(kubicBranches(root)).toEqual(['kubic/sess-b/worker-1']);
    });

    it('a session whose later worker never spawned still cleans fully and is retired', async () => {
      // The usual shape of a failed run: worker-1 failed and stayed retained,
      // worker-2 was never given a worktree or a branch.
      const root = scratchRepo();
      retainWorktree(root, 'worker-1', 'sess-a');
      const state = writeState(root, 'sess-a', ['worker-1', 'worker-2']);
      const real = await clean(root, { sessionId: 'sess-a' });
      expect(real.errs).toEqual([]);
      expect(real.code).toBe(0);
      expect(kubicBranches(root)).toEqual([]);
      expect(existsSync(join(root, '.kubic', 'wt', 'sess-a'))).toBe(false);
      expect(existsSync(state)).toBe(false);
    });

    it('keeps the state on a dry run', async () => {
      const root = scratchRepo();
      retainWorktree(root, 'worker-1', 'sess-a');
      const state = writeState(root, 'sess-a', ['worker-1']);
      await clean(root, { sessionId: 'sess-a', dryRun: true });
      expect(existsSync(state)).toBe(true);
    });

    it('keeps the state while any worktree of the session remains (a dirty tree without --force)', async () => {
      const root = scratchRepo();
      const one = retainWorktree(root, 'worker-1', 'sess-a');
      retainWorktree(root, 'worker-2', 'sess-a');
      writeFileSync(join(one, 'dirty.txt'), 'uncommitted\n');
      const state = writeState(root, 'sess-a', ['worker-1', 'worker-2']);
      const approvals = writeApprovals(root, 'sess-a');
      const real = await clean(root, { sessionId: 'sess-a' });
      expect(real.code).toBe(1);
      expect(existsSync(one)).toBe(true);
      expect(existsSync(state)).toBe(true);
      // A partial clean keeps the approvals state with the session state.
      expect(existsSync(approvals)).toBe(true);
      // Forced, the rest goes and the state is retired.
      const forced = await clean(root, { sessionId: 'sess-a', force: true });
      expect(forced.code, forced.errs.join('\n')).toBe(0);
      expect(existsSync(state)).toBe(false);
      expect(existsSync(approvals)).toBe(false);
    });

    it('retires the state when the session has nothing left to dispose (workers never got a worktree), approvals dir included', async () => {
      const root = scratchRepo();
      const state = writeState(root, 'sess-a', ['worker-1']);
      const otherState = writeState(root, 'sess-b', ['worker-1']);
      const approvals = writeApprovals(root, 'sess-a');
      const otherApprovals = writeApprovals(root, 'sess-b');
      const ledger = writeLedger(root);
      const real = await clean(root, { sessionId: 'sess-a' });
      expect(real.errs).toEqual([]);
      expect(real.code).toBe(0);
      expect(existsSync(state)).toBe(false);
      expect(existsSync(approvals)).toBe(false);
      expect(real.lines.join('\n')).toContain('retired session state');
      expect(real.lines.join('\n')).not.toContain('nothing to prune');
      // Only that session: another session's state and approvals, and the
      // repo-wide audit ledger, are never touched.
      expect(existsSync(otherState)).toBe(true);
      expect(existsSync(otherApprovals)).toBe(true);
      expect(existsSync(ledger)).toBe(true);
      // The loop is closed: a second clean of the retired id has no state.
      const again = await clean(root, { sessionId: 'sess-a' });
      expect(again.code).toBe(1);
    });

    it('retires the approvals dir with a disposing clean, and tolerates a run that never wrote one', async () => {
      const root = scratchRepo();
      retainWorktree(root, 'worker-1', 'sess-a');
      const state = writeState(root, 'sess-a', ['worker-1']);
      const approvals = writeApprovals(root, 'sess-a');
      const ledger = writeLedger(root);
      const real = await clean(root, { sessionId: 'sess-a' });
      expect(real.code, real.errs.join('\n')).toBe(0);
      expect(existsSync(state)).toBe(false);
      expect(existsSync(approvals)).toBe(false);
      expect(existsSync(ledger)).toBe(true);
      retainWorktree(root, 'worker-1', 'sess-c');
      writeState(root, 'sess-c', ['worker-1']);
      const noApprovals = await clean(root, { sessionId: 'sess-c' });
      expect(noApprovals.code, noApprovals.errs.join('\n')).toBe(0);
    });

    it('--dry-run says it would retire the session state and its approvals dir, and changes nothing', async () => {
      const root = scratchRepo();
      const state = writeState(root, 'sess-a', ['worker-1']);
      const approvals = writeApprovals(root, 'sess-a');
      const dry = await clean(root, { sessionId: 'sess-a', dryRun: true });
      expect(dry.code).toBe(0);
      const text = dry.lines.join('\n');
      expect(text).toContain(`would retire session state ${state}`);
      expect(text).toContain(approvals);
      expect(text).not.toContain('nothing to prune');
      expect(existsSync(state)).toBe(true);
      expect(existsSync(approvals)).toBe(true);
    });
  });

  it('a session directory that holds anything else is left in place', async () => {
    const root = scratchRepo();
    retainWorktree(root, 'worker-1', 'orch-keep');
    const sessionDir = join(root, '.kubic', 'wt', 'orch-keep');
    writeFileSync(join(sessionDir, 'notes.txt'), 'not a worktree\n');
    const stateDir = join(root, '.kubic', 'orchestrator');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'orch-keep.json'),
      JSON.stringify({
        version: 1,
        sessionId: 'orch-keep',
        prompt: 'p',
        agents: ['worker-1'],
        merged: [],
        pending: ['worker-1'],
        stopped: false,
        records: [],
      }),
    );
    const real = await clean(root, { sessionId: 'orch-keep' });
    expect(real.code).toBe(0);
    expect(existsSync(join(sessionDir, 'worker-1'))).toBe(false);
    expect(existsSync(join(sessionDir, 'notes.txt'))).toBe(true);
  });

  it('removes the emptied session directory with a NON-recursive rmdir, so a worker dir a concurrent resume adds is never wiped', async () => {
    const root = scratchRepo();
    retainWorktree(root, 'worker-1', 'orch-race');
    const stateDir = join(root, '.kubic', 'orchestrator');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'orch-race.json'),
      JSON.stringify({
        version: 1,
        sessionId: 'orch-race',
        prompt: 'p',
        agents: ['worker-1'],
        merged: [],
        pending: ['worker-1'],
        stopped: false,
        records: [],
      }),
    );
    const sessionDir = join(root, '.kubic', 'wt', 'orch-race');
    const env = new NodeExecutionEnv(root);
    const commands: string[][] = [];
    // A `--resume` of the same session lands `<wt>/S/worker-2` after the
    // disposal emptied the directory and before the directory is removed: the
    // hook fires on the rmdir itself, exactly in that window.
    const racing = {
      ...env,
      cwd: env.cwd,
      shell: {
        ...env.shell,
        spawn: (
          cmd: string,
          args: string[],
          options: Parameters<typeof env.shell.spawn>[2],
        ) => {
          if (cmd === 'rmdir') {
            commands.push([cmd, ...args]);
            mkdirSync(join(sessionDir, 'worker-2'), { recursive: true });
            writeFileSync(join(sessionDir, 'worker-2', 'late.txt'), 'late\n');
          }
          return env.shell.spawn(cmd, args, options);
        },
      },
    } as unknown as NodeExecutionEnv;
    const out: string[] = [];
    const errs: string[] = [];
    const code = await runCleanCommand(
      { sessionId: 'orch-race' },
      {
        env: racing,
        out: (line: string) => out.push(line),
        err: (line: string) => errs.push(line),
      },
    );
    // The disposal itself succeeded, silently leaving the busy directory.
    expect(code, errs.join('\n')).toBe(0);
    expect(errs).toEqual([]);
    expect(commands).toEqual([['rmdir', sessionDir]]);
    expect(existsSync(join(sessionDir, 'worker-2', 'late.txt'))).toBe(true);
  });

  it('--all removes every session directory it emptied but never the worktree root', async () => {
    const root = scratchRepo();
    retainWorktree(root, 'worker-1', 'sess-a');
    retainWorktree(root, 'worker-1', 'sess-b');
    const real = await clean(root, {});
    expect(real.code).toBe(0);
    expect(kubicBranches(root)).toEqual([]);
    expect(existsSync(join(root, '.kubic', 'wt', 'sess-a'))).toBe(false);
    expect(existsSync(join(root, '.kubic', 'wt', 'sess-b'))).toBe(false);
    expect(existsSync(join(root, '.kubic', 'wt'))).toBe(true);
  });

  it('a legacy unscoped worktree leaves the worktree root itself in place', async () => {
    const root = scratchRepo();
    retainWorktree(root, 'worker-1');
    const real = await clean(root, {});
    expect(real.code).toBe(0);
    expect(existsSync(join(root, '.kubic', 'wt', 'worker-1'))).toBe(false);
    expect(existsSync(join(root, '.kubic', 'wt'))).toBe(true);
  });

  it('removes the emptied session directory under a configured worktree root too', async () => {
    const root = scratchRepo();
    const custom = join(root, '.kubic-custom', 'wt', 'sess-c', 'worker-1');
    git(root, ['worktree', 'add', custom, '-b', 'kubic/sess-c/worker-1']);
    const real = await clean(root, {}, '.kubic-custom/wt');
    expect(real.code).toBe(0);
    expect(existsSync(custom)).toBe(false);
    expect(existsSync(join(root, '.kubic-custom', 'wt', 'sess-c'))).toBe(false);
    expect(existsSync(join(root, '.kubic-custom', 'wt'))).toBe(true);
  });

  it('--json emits the envelope for dry-run and for real removal', async () => {
    const root = scratchRepo();
    const retained = retainWorktree(root, 'worker-1');

    const dry = await clean(root, { dryRun: true, json: true });
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

    const real = await clean(root, { json: true });
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

    const explicit = await clean(root, { all: true, dryRun: true });
    const implicit = await clean(root, { dryRun: true });

    expect(explicit.code).toBe(0);
    expect(implicit.code).toBe(0);
    expect(explicit.lines).toEqual(implicit.lines);

    const real = await clean(root, { all: true });
    expect(real.code).toBe(0);
    expect(existsSync(one)).toBe(false);
    expect(existsSync(two)).toBe(false);
    expect(kubicBranches(root)).toEqual([]);
  });

  it('keeps a dirty worktree until --force, then removes it with its branch', async () => {
    const root = scratchRepo();
    const retained = retainWorktree(root, 'worker-1');
    writeFileSync(join(retained, 'wip.txt'), 'wip\n');

    const refused = await clean(root, {});
    const refusedText = refused.errs.join('\n');
    expect(refused.code).toBe(1);
    expect(refusedText).toContain('error:');
    expect(refusedText).toContain('--force');
    expect(existsSync(join(retained, 'wip.txt'))).toBe(true);
    // Never half-disposed: the failed worktree keeps its branch.
    expect(kubicBranches(root)).toEqual(['kubic/worker-1']);

    const forced = await clean(root, { force: true });
    expect(forced.code).toBe(0);
    expect(existsSync(retained)).toBe(false);
    expect(kubicBranches(root)).toEqual([]);
  });
});
