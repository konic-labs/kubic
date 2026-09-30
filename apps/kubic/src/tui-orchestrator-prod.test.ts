// The TUI orchestrator lane on the PROD run path (issue #327): real git, real
// child processes, no provider. Two defects only show up here, where the real
// manager, worktree store and merge gate run under the TUI drive:
//
//   1. worktrees/branches are retained per session, so the SECOND delegation
//      prompt of one TUI session used to fail `worktree_exists` on the first
//      prompt's retained `worker-1` — each prompt must be its own session;
//   2. the merge gate's shipped decider is a readline over the stdin/stderr
//      the TUI owns — under the TUI the merge ask must reach the approval
//      surface's seat, and the readline must never open.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApprovalSnapshot } from '../../../packages/host/src/orchestrator/merge/conflicts.js';
import { WorkerRegistry } from '../../../packages/worker/src/lifecycle/registry.js';
import { orchestrateDepsWithDefaults } from './orchestrate-run.js';
import {
  createProdTuiOrchestrator,
  mergeSeatFromAnswer,
} from './tui-orchestrator.js';

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
const restores: Array<() => void> = [];

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(): string {
  const root = realpathSync(scratch('kubic-tui-orch-327-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'issue327@kubic.dev']);
  git(root, ['config', 'user.name', 'kubic issue327']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  git(root, ['add', 'base.txt']);
  git(root, ['commit', '-m', 'base']);
  return root;
}

// A stdin that reports as a terminal and is watched: readline over it would
// attach listeners (and write its prompt to stderr). The TUI path must touch
// neither.
function stubTtyStdin(): { stdin: PassThrough } {
  const stdin = new PassThrough();
  Object.defineProperty(stdin, 'isTTY', { value: true, configurable: true });
  const original = Object.getOwnPropertyDescriptor(process, 'stdin');
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  restores.push(() => {
    if (original !== undefined) {
      Object.defineProperty(process, 'stdin', original);
    }
  });
  return { stdin };
}

function captureStderr(): { text: () => string } {
  const chunks: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  restores.push(() => {
    process.stderr.write = original;
  });
  return { text: () => chunks.join('') };
}

const POLICY: ApprovalSnapshot = {
  route: 'ask-user',
  autoApprove: [],
  maxPendingMs: 5_000,
};

function driveFor(
  root: string,
  reports: string[],
  extra: Partial<Parameters<typeof createProdTuiOrchestrator>[0]> = {},
) {
  const fixtureDir = scratch('kubic-tui-orch-327-child-');
  const fixture = join(fixtureDir, 'worker-child.mjs');
  writeFileSync(fixture, WORKER_FIXTURE);
  const sessionsRoot = scratch('kubic-tui-orch-327-sessions-');
  return createProdTuiOrchestrator({
    sessionId: 'tui-1',
    cwd: root,
    sessionsRoot,
    out: (line) => reports.push(line),
    approvalPolicy: POLICY,
    createDeps: (options) =>
      orchestrateDepsWithDefaults({
        ...options,
        registry: new WorkerRegistry(),
        workerEntry: { cmd: process.execPath, args: [fixture] },
        signals: { install: () => () => undefined, reraise: () => undefined },
      }),
    ...extra,
  });
}

describe('the TUI orchestrator lane on the prod run path (issue #327)', () => {
  it('runs two delegation prompts in ONE TUI session: each prompt is its own orchestrator session, both merge through the TUI seat', async () => {
    const root = initRepo();
    const asked: string[] = [];
    const reports: string[] = [];
    const drive = driveFor(root, reports, {
      mergeSeat: mergeSeatFromAnswer(async (request) => {
        asked.push(request.summary);
        return { approved: true, by: 'allow-once' };
      }),
    });

    const first = await drive.run('add the first thing');
    expect(first, reports.join('\n')).toEqual({ status: 'completed' });
    const second = await drive.run('add the second thing');
    expect(second, reports.join('\n')).toEqual({ status: 'completed' });

    // Two orchestrator sessions under the TUI session, never the bare id.
    const states = readdirSync(join(root, '.kubic', 'orchestrator'))
      .filter((name) => /^tui-1-o[a-z0-9]+\.json$/.test(name))
      .sort();
    expect(states).toHaveLength(2);
    const branches = git(root, ['branch', '--list', 'kubic/*'])
      .split('\n')
      // `+ ` marks a branch checked out in a retained worktree.
      .map((line) => line.replace(/^[*+]?\s*/, '').trim())
      .filter((line) => line !== '');
    // worker-1 and worker-2 of each of the two turns, all retained.
    expect(branches).toHaveLength(4);
    expect(new Set(branches.map((b) => b.split('/')[1])).size).toBe(2);
    for (const branch of branches) {
      expect(branch).toMatch(/^kubic\/tui-1-o[a-z0-9]+\/worker-[12]$/);
    }
    // The merge ask went to the TUI seat once per worker per turn.
    expect(asked).toHaveLength(4);
    expect(asked[0]).toMatch(/^merge worker 'worker-1' \(kubic\/tui-1-o/);
    // The work of both turns landed on main.
    const files = git(root, ['ls-tree', '-r', '--name-only', 'HEAD']);
    expect(files).toContain('worker-1.txt');
    expect(files).toContain('worker-2.txt');
  });

  it('never opens the stdio readline for a merge — a wired-in seat decides, on a TTY stdin', async () => {
    const root = initRepo();
    const tty = stubTtyStdin();
    const stderr = captureStderr();
    const reports: string[] = [];
    const drive = driveFor(root, reports, {
      mergeSeat: async () => ({ verdict: 'approve' }),
    });
    const outcome = await drive.run('go');
    expect(outcome, reports.join('\n')).toEqual({ status: 'completed' });
    expect(tty.stdin.listenerCount('data')).toBe(0);
    expect(tty.stdin.listenerCount('end')).toBe(0);
    expect(stderr.text()).not.toContain('approve merge');
    expect(stderr.text()).not.toContain('[y/N]');
  });

  it('with no seat wired a merge denies closed (exit 4) — the readline never opens, even on a TTY stdin', async () => {
    const root = initRepo();
    const tty = stubTtyStdin();
    const stderr = captureStderr();
    const reports: string[] = [];
    const drive = driveFor(root, reports);
    const outcome = await drive.run('go');
    expect(outcome).toEqual({
      status: 'failed',
      detail: 'the orchestrator run failed (exit 4)',
    });
    expect(tty.stdin.listenerCount('data')).toBe(0);
    expect(tty.stdin.listenerCount('end')).toBe(0);
    expect(stderr.text()).not.toContain('[y/N]');
    // The refusal names no flag the TUI does not have.
    const text = reports.join('\n');
    expect(text).toContain(
      "approval denied for worker 'worker-1': the decider is the user",
    );
    expect(text).not.toContain('--yes');
    // Nothing was merged.
    expect(existsSync(join(root, 'worker-1.txt'))).toBe(false);
    expect(git(root, ['ls-tree', '-r', '--name-only', 'HEAD'])).not.toContain(
      'worker-1.txt',
    );
  });
});
