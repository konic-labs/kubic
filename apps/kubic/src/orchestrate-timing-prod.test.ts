// §61 timing on the prod run path (issue #158): the merge telemetry is
// measured by the run itself and the launch sample carries the attach leg and
// the worktree-creation leg as real numbers. Real git, a real child process,
// no provider.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runOrchestrateCommand } from '../../../packages/host/src/orchestrate-cli.js';
import type { MergeTelemetry } from '../../../packages/host/src/orchestrator/merge/telemetry.js';
import { totalMergeMs } from '../../../packages/host/src/orchestrator/merge/telemetry.js';
import { WorkerRegistry } from '../../../packages/worker/src/lifecycle/registry.js';
import { orchestrateDepsWithDefaults } from './orchestrate-run.js';

// The child contract as a real process: announce readiness, report the §68
// result shape, write one file so the branch has a hunk to merge, exit 0.
const FIXTURE = `
import { writeFileSync } from 'node:fs';
const id = process.env.KUBIC_WORKER_ID ?? 'worker';
process.stdout.write('KUBIC_WORKER_READY ' + id + '\\n');
writeFileSync(id + '.txt', 'work by ' + id + '\\n');
const a = process.argv;
process.stdout.write(JSON.stringify({ ok: true, exitCode: 0, sessionId: a[a.indexOf('--session') + 1], status: 'completed', result: { summary: 'fixture done' } }) + String.fromCharCode(10));
process.exit(0);
`;

const scratchDirs: string[] = [];

function scratch(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratchDirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  vi.stubEnv('KUBIC_PROVIDER', '');
  vi.stubEnv('KUBIC_MODEL', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function initRepo(): string {
  const repo = scratch('kubic-timing-');
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'timing@kubic.dev']);
  git(repo, ['config', 'user.name', 'kubic timing']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, ['add', 'base.txt']);
  git(repo, ['commit', '-m', 'base']);
  return repo;
}

function fixtureEntry(): { cmd: string; args: string[] } {
  const dir = scratch('kubic-timing-child-');
  const fixture = join(dir, 'worker-child.mjs');
  writeFileSync(fixture, FIXTURE);
  return { cmd: process.execPath, args: [fixture] };
}

describe('§61 timing on the prod orchestrate path (issue #158)', () => {
  it('reports the measured merge phases and the attach/worktree legs', async () => {
    const repo = initRepo();
    const lines: string[] = [];
    const deps = await orchestrateDepsWithDefaults({
      out: (line) => lines.push(line),
      err: () => undefined,
      debug: () => undefined,
      cwd: repo,
      sessionsRoot: scratch('kubic-timing-sessions-'),
      registry: new WorkerRegistry(),
      workerEntry: fixtureEntry(),
      signals: { install: () => () => undefined, reraise: () => undefined },
    });
    const code = await runOrchestrateCommand(
      {
        prompt: 'go',
        agents: ['worker-1'],
        yes: true,
        json: true,
        session: 'timing',
      },
      deps,
    );
    expect(code).toBe(0);
    const envelope = JSON.parse(lines[lines.length - 1] as string) as {
      mergeTelemetry?: MergeTelemetry[];
    };
    const telemetry = envelope.mergeTelemetry ?? [];
    expect(telemetry).toHaveLength(1);
    const record = telemetry[0] as MergeTelemetry;
    expect(record.agentId).toBe('worker-1');
    expect(record.outcome).toBe('merged');
    // Every phase is a real measurement (never negative), and the total is
    // exactly their sum — the §61 contract.
    for (const phase of [
      record.queueMs,
      record.diffMs,
      record.mergeMs,
      record.resolveMs,
      record.applyMs,
    ]) {
      expect(typeof phase).toBe('number');
      expect(phase).toBeGreaterThanOrEqual(0);
    }
    expect(totalMergeMs(record)).toBe(
      record.queueMs +
        record.diffMs +
        record.mergeMs +
        record.resolveMs +
        record.applyMs,
    );

    // §61: the launch sample carries the attach leg and the worktree-creation
    // leg as numbers. Creation is measured when it RETURNS, so it is the
    // creation duration — a number here, not a launch-time subtraction.
    const perf = deps.launches?.perf() ?? [];
    expect(perf).toHaveLength(1);
    expect(typeof perf[0]?.sample.attachMs).toBe('number');
    expect(perf[0]?.sample.attachMs).toBeGreaterThanOrEqual(0);
    expect(typeof perf[0]?.sample.worktreeMs).toBe('number');
    expect(perf[0]?.sample.worktreeMs).toBeGreaterThanOrEqual(0);
  }, 30_000);
});
