// The §49.1 trajectory event reaches DISK on the composed prod path
// (issue #106). The unit test proves the CLI calls the sink once per queued
// spawn; this proves the composition root's own default sink writes the
// record to `<repo>/.kubic/orchestrator/<session>.trajectory.jsonl` — the sink
// the shipped binary gets, and the one a defect here would leave silently
// empty.
//
// One honest caveat, measured and stated rather than papered over: the run
// loop is strictly sequential, so it drains each worker before requesting the
// next admission and can never queue against the shipped cap (the CLI
// documents this as review finding F2). A queued spawn is therefore PRIMED
// here by handing the run a scheduler whose only slot is already occupied —
// the same device the CLI's own contract test uses. Everything after that is
// the prod path: the real composition root, its real default sink, a real
// child process, and the file it writes.
//
// No network and no paid tokens: the worker entry is this test process's own
// node running a fixture that prints its readiness marker and exits.
import { execFileSync } from 'node:child_process';
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
import { runOrchestrateCommand } from './orchestrate-cli.js';
import { ParallelScheduler } from './orchestrator/parallel/scheduler.js';

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
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('prod orchestrate path: the trajectory event lands (issue #106, §49.1)', () => {
  it('the composition root default sink writes the parallel event to disk', async () => {
    const root = scratch('kubic-orch-106-traj-');
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    git(['init', '-b', 'main', '.']);
    git(['config', 'user.email', 'a@b.c']);
    git(['config', 'user.name', 't']);
    git(['config', 'commit.gpgsign', 'false']);
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
      cwd: root,
      sessionsRoot,
      workerEntry: { cmd: process.execPath, args: [worker] },
    });
    // Occupy the only slot, so the run's first real spawn genuinely queues.
    const scheduler = new ParallelScheduler(undefined, { sessionOverride: 1 });
    const primed = scheduler.requestSpawn(
      { agentId: 'occupant', sessionId: 'traj', worktree: root },
      'autonomous',
    );
    expect(primed.outcome).toBe('admitted');

    const code = await runOrchestrateCommand(
      ['-p', 'do the thing', '--agents', 'alpha', '--session', 'traj', '--yes'],
      // The prod deps, with only the admission layer primed. `trajectoryEvent`
      // is deliberately NOT overridden: the run uses the composition root's own
      // default sink.
      { ...prod, scheduler },
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
    expect(rows.length).toBeGreaterThan(0);
    const queued = rows.filter((row) => row.kind === 'parallel');
    expect(queued.length).toBe(1);
    expect(queued[0]).toMatchObject({
      sessionId: 'traj',
      running: 1,
      queued: 1,
      maxConcurrency: 1,
      wakeups: [],
    });
  }, 60_000);
});
