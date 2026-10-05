// The §49.1 trajectory event reaches DISK on the composed prod path
// (issue #106). The unit test proves the CLI calls the sink once per
// admission transition; this proves the composition root's own default sink
// writes the record to `<repo>/.kubic/orchestrator/<session>.trajectory.jsonl`
// — the sink the shipped binary gets, and the one a defect here would leave
// silently empty.
//
// The queue is produced by the run itself now (issue #206): one worker at a
// time against two agents, so the second genuinely waits and is woken when
// the first settles. Everything is the prod path: the real composition root,
// its real default sink, real child processes, and the file it writes.
//
// No network and no paid tokens: the worker entry is this test process's own
// node running a fixture that prints its readiness marker and exits.

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { orchestrateDepsWithDefaults } from '../../../apps/kubic/src/orchestrate-run.js';
import {
  createGitSandbox,
  disposeAllGitSandboxes,
} from '../../exec/src/test-support/git-sandbox.js';
import { runOrchestrateCommand } from './orchestrate-cli.js';

const WORKER = `
process.stdout.write('KUBIC_WORKER_READY ' + (process.env.KUBIC_WORKER_ID ?? '') + '\\n');
if (0 === 0) { const a = process.argv; process.stdout.write(JSON.stringify({ ok: true, exitCode: 0, sessionId: a[a.indexOf('--session') + 1], status: 'completed', result: { summary: 'fixture done' } }) + String.fromCharCode(10)); }
process.exit(0);
`;

// Every scratch dir is removed after the test (the worktree lives under the
// repo root, so removing it disposes it too) — nothing accumulates in tmpdir.
const scratchDirs: string[] = [];

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  disposeAllGitSandboxes();
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('prod orchestrate path: the trajectory event lands (issue #106, §49.1)', () => {
  it('the composition root default sink writes the parallel event to disk', async () => {
    // Injected sandbox repo (issue #420): the run under test manages
    // worktrees and commits through production git.
    const sandbox = createGitSandbox({ injectProcessEnv: true });
    const root = sandbox.path;
    const git = (args: string[]) => sandbox.git(args, { cwd: root });
    writeFileSync(join(root, 'file.txt'), 'base\n');
    git(['add', '-A']);
    git(['commit', '-m', 'base']);

    const childDir = scratch('kubic-orch-106-traj-child-');
    const worker = join(childDir, 'worker.mjs');
    writeFileSync(worker, WORKER);
    const sessionsRoot = scratch('kubic-orch-106-traj-s-');

    const lines: string[] = [];
    const prod = await orchestrateDepsWithDefaults({
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
      cwd: root,
      sessionsRoot,
      workerEntry: { cmd: process.execPath, args: [worker] },
    });

    const code = await runOrchestrateCommand(
      {
        prompt: 'do the thing',
        agents: ['alpha', 'beta'],
        session: 'traj',
        yes: true,
        // The per-session override `--concurrency 1` installs: one worker at
        // a time, so the second agent genuinely queues and is woken by the
        // first worker's own settle.
        concurrency: 1,
      },
      // The prod deps, unchanged: `trajectoryEvent` is deliberately NOT
      // overridden, so the run uses the composition root's own default sink.
      prod,
    );

    expect(code).toBe(0);
    const record = join(
      root,
      '.kubic',
      'orchestrator',
      'traj.trajectory.jsonl',
    );
    expect(existsSync(record)).toBe(true);
    const rows = readFileSync(record, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const queued = rows.filter((row) => row.kind === 'parallel');
    // One record for the queued spawn (nothing was woken by the request) and
    // one for the FIFO wakeup that admitted it when alpha settled.
    expect(queued.length).toBe(2);
    expect(queued[0]).toMatchObject({
      sessionId: 'traj',
      running: 1,
      queued: 1,
      maxConcurrency: 1,
      wakeups: [],
    });
    expect(queued[1]).toMatchObject({
      sessionId: 'traj',
      maxConcurrency: 1,
      wakeups: ['beta'],
    });
  }, 60_000);
});
