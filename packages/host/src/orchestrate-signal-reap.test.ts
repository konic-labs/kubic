// Prod orchestrate path: live workers die with the manager (§51, §61).
//
// The defect: every worker child is spawned into its OWN process group
// (exec's detached spawn, so a kill takes grandchildren too). That also
// means a terminal Ctrl-C — which the kernel delivers to the FOREGROUND
// group only — never reaches a worker, and the manager installed no signal
// handler of its own. A SIGINT/SIGTERM/SIGHUP to `kubic orchestrate` killed
// the manager and left every running `kubic run` child orphaned, still
// spending tokens and writing into its worktree for up to the 600s bound.
//
// These tests drive the real composition-root adapter against real git and
// a REAL child process; only the process-signal seam is injected, so the
// vitest worker itself is never signalled.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type OrchestrateSignals,
  orchestrateDepsWithDefaults,
} from '../../../apps/kubic/src/orchestrate-run.js';
import type { Provenance } from '../../exec/src/env.js';
import { NodeExecutionEnv } from '../../exec/src/env.js';
import { WorkerRegistry } from '../../worker/src/lifecycle/registry.js';

const PROVENANCE: Provenance = {
  sessionId: 'sigreap',
  agentId: 'manager',
  toolCallId: 'signal-reap',
  turnId: 0,
  operation: 'orchestrate_signal_reap',
};

// Announce readiness, then stay alive until killed (a worker mid-run).
// SLOW_ABORT=<ms> (issue #249): a cooperative SIGTERM shutdown that takes
// <ms> to settle, so a cancel grace can be measured against it.
// ABORT_MARKER=<path>: the handler writes this file when the cooperative
// settle COMPLETES — proof the abort finished, not just that the row says so.
// STUBBORN_GRANDCHILD: leave a grandchild behind that ignores SIGTERM, so the
// leader exits inside the grace while the group still needs the escalation.
const FIXTURE = `
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
process.stdout.write('KUBIC_WORKER_READY ' + (process.env.KUBIC_WORKER_ID ?? '') + '\\n');
const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf('-p') + 1] ?? '';
const slowAbort = /SLOW_ABORT=(\\d+)/.exec(prompt)?.[1];
const abortMarker = /ABORT_MARKER=(\\S+)/.exec(prompt)?.[1];
if (prompt.includes('STUBBORN_GRANDCHILD')) {
  spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], { stdio: 'ignore' });
}
if (slowAbort !== undefined) {
  process.on('SIGTERM', () => {
    setTimeout(() => {
      if (abortMarker !== undefined) writeFileSync(abortMarker, 'settled');
      process.exit(0);
    }, Number(slowAbort));
  });
  setInterval(() => {}, 1000);
}
setTimeout(() => process.exit(0), 30000);
`;

const scratchDirs: string[] = [];
const pids: number[] = [];

function scratchRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function gitOrThrow(cwd: string, args: string[]): Promise<void> {
  const done = await new NodeExecutionEnv(cwd).shell
    .spawn('git', args, { provenance: PROVENANCE })
    .wait();
  if (done.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${done.stderr}`);
  }
}

async function initRepo(): Promise<string> {
  const root = scratchRoot('kubic-orch-sigreap-');
  await gitOrThrow(root, ['init', '-b', 'main']);
  await gitOrThrow(root, ['config', 'user.email', 'sig@kubic.dev']);
  await gitOrThrow(root, ['config', 'user.name', 'kubic sig']);
  await gitOrThrow(root, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  await gitOrThrow(root, ['add', 'base.txt']);
  await gitOrThrow(root, ['commit', '-m', 'base']);
  return root;
}

// A fake process-signal seam: records installs/removals and re-raises.
function fakeSignals(): OrchestrateSignals & {
  fire: (signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'exit') => void;
  installed: () => number;
  reraised: string[];
} {
  const handlers = new Set<
    (signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'exit') => void
  >();
  const reraised: string[] = [];
  return {
    install: (handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    reraise: (signal) => {
      reraised.push(signal);
    },
    fire: (signal) => {
      for (const handler of [...handlers]) handler(signal);
    },
    installed: () => handlers.size,
    reraised,
  };
}

async function startLiveWorker(
  signals: OrchestrateSignals,
  options: { prompt?: string; cancelGraceMs?: number } = {},
): Promise<{
  pid: number;
  settled: Promise<unknown>;
  deps: Awaited<ReturnType<typeof orchestrateDepsWithDefaults>>;
}> {
  const root = await initRepo();
  const sessionsRoot = scratchRoot('kubic-orch-sigreap-sessions-');
  const fixture = join(scratchRoot('kubic-orch-sigreap-child-'), 'w.mjs');
  writeFileSync(fixture, FIXTURE);
  const registry = new WorkerRegistry();
  const deps = await orchestrateDepsWithDefaults({
    out: () => undefined,
    err: () => undefined,
    cwd: root,
    sessionsRoot,
    registry,
    workerEntry: { cmd: process.execPath, args: [fixture] },
    signals,
    ...(options.cancelGraceMs === undefined
      ? {}
      : { workerCancelGraceMs: options.cancelGraceMs }),
  });
  const worktree = await deps.ensureWorktree('worker-1');
  await deps.createWorkerSession?.({
    sessionId: 'sigreap',
    agentId: 'worker-1',
    workerSessionId: 'sigreap-worker-1',
    worktree,
    // Issue #278 (§19): the simulated run passes no --autonomous.
    mode: 'interactive',
  });
  const settled = Promise.resolve(
    deps.runWorker('worker-1', worktree, options.prompt ?? 'work', {
      sessionId: 'sigreap',
      workerSessionId: 'sigreap-worker-1',
    }),
  ).catch((error: unknown) => error);
  await vi.waitFor(
    // §13 (issue #151): the AGENT is running once the marker landed; the
    // PROCESS phase is `ready`.
    () => expect(registry.get('worker-1')?.agentStatus).toBe('running'),
    { timeout: 10_000 },
  );
  const pid = registry.get('worker-1')?.pid;
  if (pid === undefined) throw new Error('worker has no pid');
  pids.push(pid);
  return { pid, settled, deps };
}

// Two workers of ONE run, in flight at once (issue #206): the same composition
// root, two worktrees, two real children. The guard must reap every live
// process group on one signal, not only the last one it tracked.
async function startTwoLiveWorkers(signals: OrchestrateSignals): Promise<{
  pids: number[];
  settled: Promise<unknown>[];
}> {
  const root = await initRepo();
  const sessionsRoot = scratchRoot('kubic-orch-sigreap-sessions-');
  const fixture = join(scratchRoot('kubic-orch-sigreap-child-'), 'w.mjs');
  writeFileSync(fixture, FIXTURE);
  const registry = new WorkerRegistry();
  const deps = await orchestrateDepsWithDefaults({
    out: () => undefined,
    err: () => undefined,
    cwd: root,
    sessionsRoot,
    registry,
    workerEntry: { cmd: process.execPath, args: [fixture] },
    signals,
  });
  const agents = ['worker-1', 'worker-2'];
  const settled: Promise<unknown>[] = [];
  for (const agentId of agents) {
    const worktree = await deps.ensureWorktree(agentId);
    const workerSessionId = `sigreap-${agentId}`;
    await deps.createWorkerSession?.({
      sessionId: 'sigreap',
      agentId,
      workerSessionId,
      worktree,
      // Issue #278 (§19): the simulated run passes no --autonomous.
      mode: 'interactive',
    });
    // Both launches are started before either is awaited: the two children
    // are genuinely in flight together.
    settled.push(
      Promise.resolve(
        deps.runWorker(agentId, worktree, 'work', {
          sessionId: 'sigreap',
          workerSessionId,
        }),
      ).catch((error: unknown) => error),
    );
  }
  await vi.waitFor(
    () =>
      expect(
        agents.map((agentId) => registry.get(agentId)?.agentStatus),
      ).toEqual(['running', 'running']),
    { timeout: 10_000 },
  );
  const livePids = agents.map((agentId) => registry.get(agentId)?.pid);
  if (livePids.some((pid) => pid === undefined)) {
    throw new Error('a worker has no pid');
  }
  const live = livePids as number[];
  for (const pid of live) pids.push(pid);
  return { pids: live, settled };
}

describe('prod orchestrate path: workers never outlive the manager', () => {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    it(`kills every live worker on ${signal} and re-raises it`, async () => {
      const signals = fakeSignals();
      const { pid, settled } = await startLiveWorker(signals);
      expect(processAlive(pid)).toBe(true);
      expect(signals.installed()).toBe(1);

      signals.fire(signal);

      await vi.waitFor(() => expect(processAlive(pid)).toBe(false), {
        timeout: 5_000,
      });
      expect(signals.reraised).toEqual([signal]);
      await settled;
    }, 30_000);
  }

  it('kills BOTH in-flight workers on one SIGINT (issue #206)', async () => {
    const signals = fakeSignals();
    const { pids: live, settled } = await startTwoLiveWorkers(signals);
    expect(live).toHaveLength(2);
    for (const pid of live) expect(processAlive(pid)).toBe(true);

    // One signal to the manager reaches every live child: the guard holds
    // each worker's own process-group kill, so the sibling of the worker
    // that happened to launch last is not left orphaned.
    signals.fire('SIGINT');

    await vi.waitFor(
      () => expect(live.every((pid) => !processAlive(pid))).toBe(true),
      { timeout: 5_000 },
    );
    expect(signals.reraised).toEqual(['SIGINT']);
    await Promise.all(settled);
  }, 30_000);

  it('kills live workers synchronously when the manager exits', async () => {
    const signals = fakeSignals();
    const { pid, settled } = await startLiveWorker(signals);
    signals.fire('exit');
    await vi.waitFor(() => expect(processAlive(pid)).toBe(false), {
      timeout: 5_000,
    });
    // 'exit' is not a signal: nothing is re-raised.
    expect(signals.reraised).toEqual([]);
    await settled;
  }, 30_000);

  it('removes its handlers once no worker is live', async () => {
    const signals = fakeSignals();
    const { pid, settled } = await startLiveWorker(signals);
    process.kill(-pid, 'SIGTERM');
    await settled;
    expect(signals.installed()).toBe(0);
  }, 30_000);
});

describe('prod orchestrate path: fail-fast cancellation (issue #206)', () => {
  it('cancelWorker kills the live child and settles its worker as cancelled', async () => {
    const signals = fakeSignals();
    const { pid, settled, deps } = await startLiveWorker(signals);
    expect(processAlive(pid)).toBe(true);
    expect(deps.cancelWorker).toBeDefined();

    // What the run calls for a sibling still in flight when another worker
    // failed: the lifecycle layer's reap takes the detached process group,
    // and the in-flight runWorker promise settles with its named terminus —
    // the manager never returns while a cancelled child is still running.
    deps.cancelWorker?.('worker-1');

    await vi.waitFor(() => expect(processAlive(pid)).toBe(false), {
      timeout: 5_000,
    });
    const error = (await settled) as { code?: string; message?: string };
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('cancelled');
    expect(error.message).toMatch(/cancelled by the run/);
    // §13 (issue #151): the row says the AGENT was cancelled — the old
    // single status called a manager kill `crashed`. The reap's row update
    // lands asynchronously, so wait for it.
    await vi.waitFor(() =>
      expect(deps.launches?.rows()[0]).toMatchObject({
        status: 'exiting',
        agentStatus: 'cancelled',
      }),
    );
    expect(signals.reraised).toEqual([]);
  }, 30_000);
});

describe('prod orchestrate path: orphans left by a hard-killed manager', () => {
  it('kills a live orphan and marks it cancelled at the next start', async () => {
    const root = await initRepo();
    const script = join(scratchRoot('kubic-orch-orphan-'), 'orphan.mjs');
    writeFileSync(script, 'setTimeout(() => {}, 30000);\n');
    // A worker the dead manager left behind, in its own process group,
    // whose command line names its own session.
    const orphan = new NodeExecutionEnv(root).shell.spawn(
      process.execPath,
      [script, 'run', '--session', 'orch-dead-w1'],
      { provenance: PROVENANCE },
    );
    const pid = orphan.pid;
    if (pid === undefined) throw new Error('no orphan pid');
    pids.push(pid);
    const dir = join(root, '.kubic', 'orchestrator');
    mkdirSync(dir, { recursive: true });
    const row = {
      workerId: 'w1',
      sessionId: 'orch-dead-w1',
      generation: 1,
      // §13 (issue #151): a live row is a live PROCESS whose AGENT is running.
      status: 'ready',
      agentStatus: 'running',
      startedAtMs: 0,
      ageMs: 0,
      owner: 'orchestrate:orch-dead',
      pid,
      // A manager pid that cannot be alive.
      managerPid: 2 ** 22 + 7,
    };
    writeFileSync(
      join(dir, 'workers.json'),
      JSON.stringify({ version: 1, rows: [row] }),
    );
    await orchestrateDepsWithDefaults({
      out: () => undefined,
      err: () => undefined,
      cwd: root,
      sessionsRoot: scratchRoot('kubic-orch-orphan-sessions-'),
      signals: fakeSignals(),
    });
    await vi.waitFor(() => expect(processAlive(pid)).toBe(false), {
      timeout: 5_000,
    });
    const rows = JSON.parse(
      readFileSync(join(dir, 'workers.json'), 'utf8'),
    ) as { rows: { status: string; agentStatus: string }[] };
    expect(rows.rows[0]?.status).toBe('exiting');
    expect(rows.rows[0]?.agentStatus).toBe('cancelled');
    await orphan.wait();
  }, 30_000);
});

describe('prod orchestrate path: a signal another listener owns still stops the run', () => {
  it('fails the in-flight worker as cancelled and refuses the next spawn', async () => {
    // reraise is a no-op here, as when a TUI owns SIGINT.
    const signals = fakeSignals();
    const { pid, settled } = await startLiveWorker(signals);
    signals.fire('SIGINT');
    await vi.waitFor(() => expect(processAlive(pid)).toBe(false), {
      timeout: 5_000,
    });
    const error = (await settled) as { code?: string; message?: string };
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('cancelled');
    expect(error.message).toMatch(/cancelled by SIGINT/);
  }, 30_000);
});

describe('prod orchestrate path: §51 cancellation grace (issue #249)', () => {
  it('lets a slow cooperative settle finish inside the worker grace (settled)', async () => {
    const signals = fakeSignals();
    // The child takes 3 s to settle after SIGTERM; the worker grace is 8 s,
    // so the SIGKILL escalation must NOT cut it off.
    const marker = join(scratchRoot('kubic-orch-settle-'), 'abort.done');
    const { pid, settled, deps } = await startLiveWorker(signals, {
      prompt: `work SLOW_ABORT=3000 ABORT_MARKER=${marker}`,
      cancelGraceMs: 8_000,
    });
    expect(processAlive(pid)).toBe(true);
    deps.cancelWorker?.('worker-1');
    await settled;
    await vi.waitFor(
      () => expect(deps.launches?.rows()[0]?.cancel).toBe('settled'),
      { timeout: 10_000 },
    );
    // The marker proves the child's own shutdown actually COMPLETED: the row
    // saying `settled` is not taken on its own word.
    expect(existsSync(marker)).toBe(true);
    expect(processAlive(pid)).toBe(false);
  }, 30_000);

  it('records a forced kill when the grace elapses before the settle', async () => {
    const signals = fakeSignals();
    // Same 3 s settle, but only 500 ms of grace: the group SIGKILL lands
    // first and the row says so.
    const marker = join(scratchRoot('kubic-orch-settle-'), 'abort.done');
    const { settled, deps } = await startLiveWorker(signals, {
      prompt: `work SLOW_ABORT=3000 ABORT_MARKER=${marker}`,
      cancelGraceMs: 500,
    });
    deps.cancelWorker?.('worker-1');
    await settled;
    await vi.waitFor(
      () => expect(deps.launches?.rows()[0]?.cancel).toBe('forced'),
      { timeout: 10_000 },
    );
    // The grace beat the abort: the marker was never written.
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  it('is settled even when a grandchild outlives the SIGTERM (issue #249 review)', async () => {
    // The leader exits cooperatively inside the grace while a grandchild
    // ignores SIGTERM: the group SIGKILL is cleanup, not a forced worker —
    // and the manager's settle budget must cover the whole drain (abort +
    // reapGroup), not just the kill.
    const signals = fakeSignals();
    const marker = join(scratchRoot('kubic-orch-settle-'), 'abort.done');
    const { settled, deps } = await startLiveWorker(signals, {
      prompt: `work SLOW_ABORT=500 ABORT_MARKER=${marker} STUBBORN_GRANDCHILD`,
      cancelGraceMs: 2_000,
    });
    deps.cancelWorker?.('worker-1');
    await settled;
    await vi.waitFor(
      () => expect(deps.launches?.rows()[0]?.cancel).toBe('settled'),
      { timeout: 10_000 },
    );
    // The cooperative settle COMPLETED (the marker exists) and it did so
    // inside the manager's budget: the row is `settled`, not a timeout.
    expect(existsSync(marker)).toBe(true);
    expect(deps.launches?.rows()[0]?.cancel).not.toBe('forced');
  }, 30_000);
});
