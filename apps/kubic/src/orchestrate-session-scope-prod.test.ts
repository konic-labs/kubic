// Session-scoped worktrees (issue #144; §44, §44.1, §11.1) — real git, real
// child processes, no provider. Worktrees are retained until `kubic clean`,
// so the names MUST be scoped by the orchestrator session: a later fresh run
// with the same agents gets its own tree on the current HEAD, never the
// previous run's stale (possibly dirty, possibly unmerged) one.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import {
  createGitSandbox,
  disposeAllGitSandboxes,
  type GitSandbox,
} from '../../../packages/exec/src/test-support/git-sandbox.js';
import { runOrchestrateCommand } from '../../../packages/host/src/orchestrate-cli.js';
import { addWorktree } from '../../../packages/host/src/orchestrator/worktree/add.js';
import { runCleanCommand } from '../../../packages/host/src/orchestrator/worktree/clean.js';
import type { WorktreeError } from '../../../packages/host/src/orchestrator/worktree/errors.js';
import { orchestrateDepsWithDefaults } from './orchestrate-run.js';

// The worker child: writes `<KUBIC_WORKER_ID>.txt` (the run commits it), then
// reports a completed envelope.
const WORKER_FIXTURE = `
import { writeFileSync } from 'node:fs';
writeFileSync((process.env.KUBIC_WORKER_ID ?? 'worker') + '.txt', 'work\\n');
process.stdout.write('KUBIC_WORKER_READY ' + (process.env.KUBIC_WORKER_ID ?? '') + '\\n');
const a = process.argv;
process.stdout.write(JSON.stringify({ ok: true, exitCode: 0, sessionId: a[a.indexOf('--session') + 1], status: 'completed', result: { summary: 'fixture done' } }) + String.fromCharCode(10));
process.exit(0);
`;

const scratchDirs: string[] = [];

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  driver = undefined;
  disposeAllGitSandboxes();
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The test's git driver (issue #420): setup and assertion spawns run
// through the repo's sandbox. Set by initRepo, which every git-driving
// test calls first.
let driver: GitSandbox | undefined;

function git(cwd: string, args: string[]): string {
  if (driver === undefined) throw new Error('git() needs initRepo() first');
  return driver.git(args, { cwd });
}

function initRepo(): string {
  // Injected: the orchestrate run commits and manages worktrees through
  // production git on the inherited environment.
  const sandbox = createGitSandbox({ injectProcessEnv: true });
  driver = sandbox;
  const root = sandbox.path;
  writeFileSync(join(root, 'base.txt'), 'base\n');
  sandbox.git(['add', 'base.txt']);
  sandbox.git(['commit', '-m', 'base']);
  return root;
}

async function depsFor(root: string, lines: string[]) {
  const dir = scratch('kubic-orch-144-child-');
  const fixture = join(dir, 'worker-child.mjs');
  writeFileSync(fixture, WORKER_FIXTURE);
  return orchestrateDepsWithDefaults({
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
    cwd: root,
    sessionsRoot: scratch('kubic-orch-144-sessions-'),
    workerEntry: { cmd: process.execPath, args: [fixture] },
  });
}

describe('session-scoped worktrees (issue #144)', () => {
  it('a second fresh run gets its own worktree on the current HEAD; run 1 leftovers never reach run 2', async () => {
    const root = initRepo();
    const first: string[] = [];
    const code1 = await runOrchestrateCommand(
      { prompt: 'work', agents: ['worker-1'], session: 'runa', yes: true },
      await depsFor(root, first),
    );
    expect(code1, first.join('\n')).toBe(0);
    const runA = join(root, '.kubic', 'wt', 'runa', 'worker-1');
    expect(existsSync(runA)).toBe(true);
    expect(git(root, ['branch', '--list', 'kubic/runa/worker-1'])).toMatch(
      /kubic\/runa\/worker-1/,
    );
    // Run 1's retained tree turns dirty after the run (§44.1 keeps it).
    writeFileSync(join(runA, 'leftover.txt'), 'stale\n');
    const headAfterRun1 = git(root, ['rev-parse', 'HEAD']).trim();

    const second: string[] = [];
    const code2 = await runOrchestrateCommand(
      { prompt: 'work', agents: ['worker-1'], session: 'runb', yes: true },
      await depsFor(root, second),
    );
    expect(code2, second.join('\n')).toBe(0);
    const runB = join(root, '.kubic', 'wt', 'runb', 'worker-1');
    expect(existsSync(runB)).toBe(true);
    // Fresh on the current HEAD: run 2's branch forks from run 1's merge.
    const forkPoint = git(root, [
      'merge-base',
      'kubic/runb/worker-1',
      headAfterRun1,
    ]).trim();
    expect(forkPoint).toBe(headAfterRun1);
    // Run 1's dirty leftover never became run 2's work.
    const files = git(root, ['ls-tree', '-r', '--name-only', 'HEAD']);
    expect(files).not.toMatch(/leftover\.txt/);
    expect(existsSync(join(runB, 'leftover.txt'))).toBe(false);
  });

  it('a fresh run that finds its own session name already on disk fails closed with worktree_exists', async () => {
    const root = initRepo();
    await addWorktree(new NodeExecutionEnv(root), root, 'worker-1', {
      sessionId: 'dup',
      ownerSession: 'dup',
    });
    const lines: string[] = [];
    const code = await runOrchestrateCommand(
      { prompt: 'work', agents: ['worker-1'], session: 'dup', yes: true },
      await depsFor(root, lines),
    );
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/code=worktree_exists/);
    expect(lines.join('\n')).toMatch(/--resume/);
  });

  it('a fresh run under a session name that already has state is refused with exit 2 and never overwrites that state (issue #144)', async () => {
    const root = initRepo();
    const first: string[] = [];
    const code1 = await runOrchestrateCommand(
      {
        prompt: 'do something',
        agents: ['worker-1'],
        session: 's1',
        yes: true,
      },
      await depsFor(root, first),
    );
    expect(code1, first.join('\n')).toBe(0);
    const statePath = join(root, '.kubic', 'orchestrator', 's1.json');
    const before = readFileSync(statePath, 'utf8');
    expect(JSON.parse(before)).toMatchObject({
      prompt: 'do something',
      merged: ['worker-1'],
    });

    const second: string[] = [];
    const code2 = await runOrchestrateCommand(
      { prompt: 'again', agents: ['worker-1'], session: 's1', yes: true },
      await depsFor(root, second),
    );
    const text = second.join('\n');
    expect(code2, text).toBe(2);
    expect(text).toMatch(/code=session_exists/);
    expect(text).toContain("session 's1' already has orchestrator state");
    // The message names every way out.
    expect(text).toContain('--resume --session s1');
    expect(text).toContain('another --session');
    expect(text).toContain('kubic clean --session s1');
    // The stored run is byte-for-byte what run 1 left: prompt, merged list.
    expect(readFileSync(statePath, 'utf8')).toBe(before);
    // Nothing was spawned for the refused run.
    expect(text).not.toMatch(/spawn:/);
  });

  it('`kubic clean --session s1` makes the id reusable: the retired state no longer refuses a fresh run', async () => {
    const root = initRepo();
    const first: string[] = [];
    expect(
      await runOrchestrateCommand(
        { prompt: 'first', agents: ['worker-1'], session: 's1', yes: true },
        await depsFor(root, first),
      ),
      first.join('\n'),
    ).toBe(0);
    const statePath = join(root, '.kubic', 'orchestrator', 's1.json');
    expect(existsSync(statePath)).toBe(true);
    const out: string[] = [];
    const cleaned = await runCleanCommand(
      { sessionId: 's1' },
      {
        env: new NodeExecutionEnv(root),
        out: (line) => out.push(line),
        err: (line) => out.push(line),
      },
    );
    expect(cleaned, out.join('\n')).toBe(0);
    expect(existsSync(statePath)).toBe(false);
    expect(existsSync(join(root, '.kubic', 'wt', 's1'))).toBe(false);
    const again: string[] = [];
    const code = await runOrchestrateCommand(
      { prompt: 'again', agents: ['worker-1'], session: 's1', yes: true },
      await depsFor(root, again),
    );
    expect(code, again.join('\n')).toBe(0);
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      prompt: 'again',
    });
  });

  it('the refusal is a machine-readable usage envelope under --json', async () => {
    const root = initRepo();
    const first: string[] = [];
    await runOrchestrateCommand(
      {
        prompt: 'do something',
        agents: ['worker-1'],
        session: 's1',
        yes: true,
      },
      await depsFor(root, first),
    );
    const out: string[] = [];
    const deps = await depsFor(root, []);
    const code = await runOrchestrateCommand(
      {
        prompt: 'again',
        agents: ['worker-1'],
        session: 's1',
        yes: true,
        json: true,
      },
      { ...deps, out: (line) => out.push(line) },
    );
    expect(code).toBe(2);
    const envelope = JSON.parse(out.join('\n')) as {
      ok: boolean;
      exitCode: number;
      status: string;
      error: { code: string };
    };
    expect(envelope).toMatchObject({
      ok: false,
      exitCode: 2,
      status: 'usage',
      error: { code: 'session_exists' },
    });
  });

  it('a session file that is not valid state (torn write) is not state: a fresh run replaces it', async () => {
    const root = initRepo();
    const stateDir = join(root, '.kubic', 'orchestrator');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 's2.json'), '{"version": 1, "sess');
    const lines: string[] = [];
    const code = await runOrchestrateCommand(
      { prompt: 'work', agents: ['worker-1'], session: 's2', yes: true },
      await depsFor(root, lines),
    );
    expect(code, lines.join('\n')).toBe(0);
    expect(
      JSON.parse(readFileSync(join(stateDir, 's2.json'), 'utf8')),
    ).toMatchObject({ prompt: 'work', merged: ['worker-1'] });
  });

  it('--resume of a killed run reuses that session’s own worktree', async () => {
    const root = initRepo();
    const added = await addWorktree(
      new NodeExecutionEnv(root),
      root,
      'worker-1',
      { sessionId: 'killed', ownerSession: 'killed' },
    );
    const deps = await depsFor(root, []);
    const reused = await deps.ensureWorktree('worker-1', {
      sessionId: 'killed',
      resume: true,
    });
    expect(realpathSync(reused.path)).toBe(realpathSync(added.path));
    expect(reused.branch).toBe('kubic/killed/worker-1');
    // The same tree without --resume is refused, never silently reused.
    const error = (await Promise.resolve(
      deps.ensureWorktree('worker-1', { sessionId: 'killed', resume: false }),
    ).catch((e: unknown) => e)) as WorktreeError;
    expect(error.code).toBe('worktree_exists');
  });

  it('`kubic clean --session A` leaves session B’s worktree and branch untouched', async () => {
    const root = initRepo();
    const env = new NodeExecutionEnv(root);
    const a = await addWorktree(env, root, 'worker-1', {
      sessionId: 'sa',
      ownerSession: 'sa',
    });
    const b = await addWorktree(env, root, 'worker-1', {
      sessionId: 'sb',
      ownerSession: 'sb',
    });
    const stateDir = join(root, '.kubic', 'orchestrator');
    mkdirSync(stateDir, { recursive: true });
    for (const session of ['sa', 'sb']) {
      writeFileSync(
        join(stateDir, `${session}.json`),
        JSON.stringify({
          version: 1,
          sessionId: session,
          agents: ['worker-1'],
        }),
      );
    }
    const out: string[] = [];
    const code = await runCleanCommand(
      { sessionId: 'sa', force: true },
      { env, out: (line) => out.push(line), err: (line) => out.push(line) },
    );
    expect(code, out.join('\n')).toBe(0);
    expect(existsSync(a.path)).toBe(false);
    expect(git(root, ['branch', '--list', 'kubic/sa/worker-1']).trim()).toBe(
      '',
    );
    expect(existsSync(b.path)).toBe(true);
    expect(git(root, ['branch', '--list', 'kubic/sb/worker-1'])).toMatch(
      /kubic\/sb\/worker-1/,
    );
  });
});
