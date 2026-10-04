// Worker launch through the lifecycle layer (issue #94): the live
// orchestrator calls launchWorker instead of touching the exec Shell, so
// generations, the §3.8 env allowlist, the readiness handshake, §13
// statuses, §52 failure codes, and the §61 budgets are enforced on the
// path that actually spawns. Controllable fake shell + injected clock:
// no process, no network, and the marker/exit order is ours to drive.
import { describe, expect, it, vi } from 'vitest';
import type {
  ProcessHandle,
  ShellResult,
  SpawnOptions,
} from '../../../exec/src/env.js';
import { ROOT_PROVENANCE } from '../../../exec/src/env.js';
import type { ResultStatus } from '../result.js';
import { validateAgentResult } from '../result.js';
import { LIFECYCLE_BUDGETS_MS } from './budgets.js';
import type { LaunchWorkerRequest } from './launch.js';
import { launchWorker } from './launch.js';
import { WorkerRegistry } from './registry.js';
import { StaleGenerationError } from './replace.js';
import { readyMarker } from './spawn.js';

const READY = readyMarker('worker-1');

interface Controllable {
  shell: {
    spawn: (
      cmd: string,
      args: string[],
      options: SpawnOptions & { env: Record<string, string> },
    ) => ProcessHandle;
  };
  /** What the child was started with (env included), once spawned. */
  spawned: { cmd: string; args: string[]; env: Record<string, string> }[];
  /** Stream text as the child's stdout — the readiness marker arrives here. */
  emit: (text: string) => void;
  /** The child exits; wait() settles with this code. */
  exit: (code: number, stderr?: string) => void;
  killed: () => number;
}

function controllable(pid = 4242): Controllable {
  let update:
    | ((snapshot: {
        stdout: string;
        stderr: string;
        exitCode: number | null;
      }) => void)
    | undefined;
  let settle: ((result: ShellResult) => void) | undefined;
  let stdout = '';
  let stderr = '';
  let kills = 0;
  let exited: ShellResult | undefined;
  const spawned: Controllable['spawned'] = [];
  const handle: ProcessHandle = {
    pid,
    wait: () => {
      // An exit that already happened settles the wait immediately: the
      // child dies before the caller asks, which is the real ordering for
      // a boot crash.
      if (exited !== undefined) return Promise.resolve(exited);
      return new Promise<ShellResult>((resolve) => {
        settle = resolve;
      });
    },
    kill: () => {
      kills += 1;
    },
  };
  return {
    spawned,
    killed: () => kills,
    emit: (text: string) => {
      stdout += text;
      update?.({ stdout, stderr, exitCode: null });
    },
    exit: (code: number, errorText = '') => {
      stderr += errorText;
      exited = {
        exitCode: code,
        stdout,
        stderr,
        provenance: ROOT_PROVENANCE,
      };
      settle?.(exited);
    },
    shell: {
      spawn: (cmd, args, options) => {
        spawned.push({
          cmd,
          args,
          env: options.env,
        });
        update = options.onUpdate as typeof update;
        return handle;
      },
    },
  };
}

function request(
  overrides: Partial<LaunchWorkerRequest> = {},
): LaunchWorkerRequest {
  return {
    workerId: 'worker-1',
    sessionId: 's-1',
    role: 'writer',
    cmd: 'worker',
    args: ['--run'],
    baseEnv: { PATH: '/bin', PARENT_ONLY_SECRET: 'leak' },
    provenance: ROOT_PROVENANCE,
    ...overrides,
  };
}

describe('launchWorker (issue #94)', () => {
  it('refuses a stale generation before any side effect', () => {
    const child = controllable();
    const spy = vi.fn(child.shell.spawn);
    const registry = new WorkerRegistry(() => 0);
    registry.register({
      workerId: 'worker-1',
      sessionId: 's-1',
      generation: 3,
      owner: 'orchestrator',
    });
    // A resume that names generation 2 against a live generation 3 is
    // stale: it never spawns, never bumps, never touches the row.
    expect(() =>
      launchWorker(request({ expectedGeneration: 2 }), {
        shell: { spawn: spy },
        registry,
        clock: () => 0,
      }),
    ).toThrow(StaleGenerationError);
    expect(spy).not.toHaveBeenCalled();
    expect(registry.get('worker-1')?.generation).toBe(3);
  });

  it('registers the worker before the child starts and keeps the generation', () => {
    const child = controllable();
    const registry = new WorkerRegistry(() => 0);
    const launched = launchWorker(request(), {
      shell: child.shell,
      registry,
      clock: () => 0,
    });
    // The row exists while the child is still booting: that is the row
    // `kubic workers` reads, with the pid the OS handed back.
    expect(registry.get('worker-1')?.status).toBe('ready');
    expect(registry.get('worker-1')?.generation).toBe(1);
    expect(registry.get('worker-1')?.pid).toBe(4242);
    expect(launched.generation).toBe(1);
    expect(child.spawned).toHaveLength(1);
  });

  it('flips to running only when the readiness marker arrives', async () => {
    const child = controllable();
    const registry = new WorkerRegistry(() => 0);
    const launched = launchWorker(request(), {
      shell: child.shell,
      registry,
      clock: () => 0,
    });
    // Spawned but silent: the PROCESS is up, the AGENT has not started —
    // the handshake is mandatory (§13, issue #151).
    expect(registry.get('worker-1')?.status).toBe('ready');
    expect(registry.get('worker-1')?.agentStatus).toBe('starting');
    child.emit(`${READY}\n`);
    await launched.ready;
    expect(launched.agentStatus()).toBe('running');
    expect(registry.get('worker-1')?.agentStatus).toBe('running');
    expect(registry.get('worker-1')?.startupMs).toBe(0);
  });

  it('ends a worker that never prints its marker as SPAWN_FAILED', async () => {
    const child = controllable();
    const registry = new WorkerRegistry(() => 0);
    const launched = launchWorker(request({ readyTimeoutMs: 5 }), {
      shell: child.shell,
      registry,
      clock: () => 0,
    });
    child.emit('still booting\n');
    await expect(launched.ready).rejects.toThrow(/readiness/i);
    expect(registry.get('worker-1')?.status).toBe('exiting');
    expect(registry.get('worker-1')?.agentStatus).toBe('spawn_failed');
    expect(launched.agentStatus()).toBe('spawn_failed');
    expect(launched.failure()?.code).toBe('process_spawn_failed');
    // A failed launch is terminal: the reaper never revives the row.
    child.exit(0);
    await launched.reap();
    expect(registry.get('worker-1')?.agentStatus).toBe('spawn_failed');
  });

  it('reports a nonzero child exit through the §52 failure code', async () => {
    const child = controllable();
    const registry = new WorkerRegistry(() => 0);
    const launched = launchWorker(request(), {
      shell: child.shell,
      registry,
      clock: () => 0,
    });
    child.emit(`${READY}\n`);
    await launched.ready;
    child.exit(6, 'no models available: register a provider first\n');
    const done = await launched.wait();
    expect(done.exitCode).toBe(6);
    // §13 (issue #151): the PROCESS exited and the AGENT failed — the row
    // never calls an exited process "crashed".
    expect(registry.get('worker-1')?.status).toBe('exiting');
    expect(registry.get('worker-1')?.agentStatus).toBe('failed');
    // Exit 6 is the §78 provider boundary: the §52 code names the
    // provider, not a generic crash — and a missing provider is a setup
    // failure (non-retryable), never provider_transient.
    expect(launched.failure()).toMatchObject({
      code: 'provider_auth',
      kind: 'provider',
    });
    expect(launched.failure()?.message).toMatch(/exited 6/);
  });

  it('lands the terminal status when a clean child exits', async () => {
    const child = controllable();
    const registry = new WorkerRegistry(() => 0);
    const launched = launchWorker(request(), {
      shell: child.shell,
      registry,
      clock: () => 0,
    });
    child.emit(`${READY}\n`);
    await launched.ready;
    child.exit(0);
    await launched.wait();
    // A clean exit is SETTLING, never COMPLETED: the §68 report has not been
    // checked yet (issue #151). The run path settles it.
    expect(registry.get('worker-1')?.status).toBe('exiting');
    expect(registry.get('worker-1')?.agentStatus).toBe('settling');
    expect(launched.failure()).toBeUndefined();
    expect(launched.settleAgent('completed')).toBe('completed');
    expect(registry.get('worker-1')?.agentStatus).toBe('completed');
    const report = await launched.reap();
    expect(report.kind).toBe('completed');
    expect(registry.get('worker-1')?.agentStatus).toBe('completed');
  });

  it('exits before readiness as SPAWN_FAILED, never a raw exit code', async () => {
    const child = controllable();
    const registry = new WorkerRegistry(() => 0);
    const launched = launchWorker(request(), {
      shell: child.shell,
      registry,
      clock: () => 0,
    });
    child.exit(1, 'crashed on boot\n');
    const done = await launched.wait();
    expect(done.exitCode).toBe(1);
    expect(
      await launched.ready.then(
        () => 'live',
        () => 'failed',
      ),
    ).toBe('failed');
    expect(registry.get('worker-1')?.status).toBe('exiting');
    expect(registry.get('worker-1')?.agentStatus).toBe('spawn_failed');
    expect(launched.failure()?.code).toBe('process_spawn_failed');
  });

  it('asserts the phase durations against LIFECYCLE_BUDGETS_MS', async () => {
    let now = 1_000;
    const child = controllable();
    const registry = new WorkerRegistry(() => now);
    const launched = launchWorker(request({ worktreeMs: 250, attachMs: 10 }), {
      shell: child.shell,
      registry,
      clock: () => now,
    });
    // Worktree 250ms is inside its budget; the spawn itself is not.
    now += LIFECYCLE_BUDGETS_MS.spawnMs + 50;
    child.emit(`${READY}\n`);
    await launched.ready;
    const perf = launched.perf();
    expect(perf.sample.spawnMs).toBeGreaterThan(LIFECYCLE_BUDGETS_MS.spawnMs);
    expect(perf.sample.worktreeMs).toBe(250);
    expect(perf.ok).toBe(false);
    expect(perf.breaches.join(' ')).toMatch(
      new RegExp(`spawn .*exceeds ${LIFECYCLE_BUDGETS_MS.spawnMs}ms`),
    );
    expect(perf.breaches).toHaveLength(1);
    expect(perf.sample.teardownSettledMs).toBe(0);
  });

  it('passes a launch inside every budget it can see', async () => {
    const child = controllable();
    const registry = new WorkerRegistry(() => 0);
    const launched = launchWorker(request({ worktreeMs: 12, attachMs: 5 }), {
      shell: child.shell,
      registry,
      clock: () => 0,
    });
    child.emit(`${READY}\n`);
    await launched.ready;
    expect(launched.perf()).toMatchObject({ ok: true, breaches: [] });
    expect(launched.perf().sample).toMatchObject({
      spawnMs: 0,
      startupMs: 0,
      attachMs: 5,
      worktreeMs: 12,
    });
  });

  it('spawns with the §3.8 allowlist and leaves the parent secret out', async () => {
    const child = controllable();
    const registry = new WorkerRegistry(() => 0);
    const launched = launchWorker(
      request({ credentials: { token: 'role-secret' } }),
      { shell: child.shell, registry, clock: () => 0 },
    );
    child.emit(`${READY}\n`);
    await launched.ready;
    const env = child.spawned[0]?.env as Record<string, string>;
    expect(env.PATH).toBe('/bin');
    expect(env.PARENT_ONLY_SECRET).toBeUndefined();
    expect(env.KUBIC_ROLE_WRITER_TOKEN).toBe('role-secret');
    expect(env.KUBIC_WORKER_ID).toBe('worker-1');
    // The handle never carries the plaintext grant either; the redacted
    // view keeps the keys (that is what the §50 debug line prints).
    expect(Object.values(launched.env)).not.toContain('role-secret');
    expect(launched.env.KUBIC_ROLE_WRITER_TOKEN).toBe('<redacted>');
    expect(launched.env.PATH).toBe('/bin');
  });

  it('mints the grant under the role the child was TOLD, not the launch role (issue #200)', async () => {
    const child = controllable();
    const registry = new WorkerRegistry(() => 0);
    // A resolver child runs the launch's registry role but is told a
    // different (or no) role; the grant namespace must follow what the
    // child can read itself, or the credential is invisible to it.
    const launched = launchWorker(
      request({
        role: 'implementer',
        grantRole: 'worker',
        credentials: { GW_API_KEY: 'granted-key' },
      }),
      { shell: child.shell, registry, clock: () => 0 },
    );
    child.emit(`${READY}\n`);
    await launched.ready;
    const env = child.spawned[0]?.env as Record<string, string>;
    expect(env.KUBIC_ROLE_WORKER_GW_API_KEY).toBe('granted-key');
    expect(env.KUBIC_ROLE_IMPLEMENTER_GW_API_KEY).toBeUndefined();
  });

  it('never lets a sibling grant or an unrelated parent secret into the child env (issue #200)', async () => {
    const child = controllable();
    const registry = new WorkerRegistry(() => 0);
    const launched = launchWorker(
      request({
        baseEnv: {
          PATH: '/bin',
          HOME: '/home/op',
          AWS_SECRET_ACCESS_KEY: 'aws-parent-secret',
          KUBIC_ROLE_PLANNER_GW_API_KEY: 'sibling-grant',
          KUBIC_ROLE_IMPLEMENTER_OPENAI_API_KEY: 'sibling-provider',
        },
        role: 'implementer',
        grantRole: 'worker',
        credentials: { GW_API_KEY: 'mine' },
      }),
      { shell: child.shell, registry, clock: () => 0 },
    );
    child.emit(`${READY}\n`);
    await launched.ready;
    const env = child.spawned[0]?.env as Record<string, string>;
    // Exactly the role's own provider key, under the grant namespace.
    expect(env.KUBIC_ROLE_WORKER_GW_API_KEY).toBe('mine');
    // Never the sibling role's grant, never a second provider's key, and
    // never an unrelated parent secret.
    expect(Object.keys(env)).not.toContain('KUBIC_ROLE_PLANNER_GW_API_KEY');
    expect(Object.keys(env)).not.toContain(
      'KUBIC_ROLE_IMPLEMENTER_OPENAI_API_KEY',
    );
    expect(JSON.stringify(env)).not.toContain('aws-parent-secret');
    expect(JSON.stringify(env)).not.toContain('sibling-grant');
    expect(JSON.stringify(env)).not.toContain('sibling-provider');
  });

  it('redacts the grant value on the spawn debug line while keeping its key (issue #200)', async () => {
    const child = controllable();
    const registry = new WorkerRegistry(() => 0);
    const lines: string[] = [];
    const launched = launchWorker(
      request({
        role: 'implementer',
        grantRole: 'worker',
        credentials: { GW_API_KEY: 'sk-grant-do-not-print' },
      }),
      {
        shell: child.shell,
        registry,
        clock: () => 0,
        debug: (line) => lines.push(line),
      },
    );
    child.emit(`${READY}\n`);
    await launched.ready;
    const line = lines.join('\n');
    // The key is visible for debugging; the value never is.
    expect(line).toContain('KUBIC_ROLE_WORKER_GW_API_KEY');
    expect(line).not.toContain('sk-grant-do-not-print');
  });

  it('keeps one generation per worker across a resumed relaunch', async () => {
    const registry = new WorkerRegistry(() => 0);
    const first = controllable();
    const one = launchWorker(request(), {
      shell: first.shell,
      registry,
      clock: () => 0,
    });
    first.emit(`${READY}\n`);
    await one.ready;
    expect(one.generation).toBe(1);
    first.exit(0);
    await one.wait();
    // A killed run re-spawns the same worker on resume: the row survives
    // with a bumped generation, never a silent reset to 1.
    const second = controllable(5151);
    const two = launchWorker(request(), {
      shell: second.shell,
      registry,
      clock: () => 0,
    });
    second.emit(`${READY}\n`);
    await two.ready;
    expect(two.generation).toBe(2);
    expect(registry.get('worker-1')?.generation).toBe(2);
    expect(registry.get('worker-1')?.status).toBe('ready');
    expect(registry.get('worker-1')?.agentStatus).toBe('running');
    expect(registry.get('worker-1')?.pid).toBe(5151);
    // Issue #383: each child is told the generation its row carries, so the
    // §46 trajectory it writes matches `kubic workers`.
    const envOf = (spawned: typeof first.spawned): Record<string, string> =>
      (spawned[0]?.env ?? {}) as Record<string, string>;
    expect(envOf(first.spawned).KUBIC_WORKER_GENERATION).toBe('1');
    expect(envOf(second.spawned).KUBIC_WORKER_GENERATION).toBe('2');
  });

  it('reaps through the teardown budget on demand', async () => {
    const child = controllable();
    const registry = new WorkerRegistry(() => 0);
    const launched = launchWorker(request(), {
      shell: child.shell,
      registry,
      clock: () => 0,
    });
    child.emit(`${READY}\n`);
    await launched.ready;
    const pending = launched.reap();
    // Non-blocking: the kill fires before the child settles.
    expect(child.killed()).toBe(1);
    child.exit(0);
    const report = await pending;
    // §51 (issue #151): a manager-initiated reap is a CANCELLATION, not a
    // crash — the agent settles CANCELLED even though the child exited 0.
    expect(report.kind).toBe('cancel');
    expect(report.status).toBe('cancelled');
    expect(registry.get('worker-1')?.agentStatus).toBe('cancelled');
    // Idempotent: a second reap reports the same exit, kills nothing more.
    expect((await launched.reap()).kind).toBe('cancel');
    expect(child.killed()).toBe(1);
  });

  it('never lets an unfinished launch claim a budget pass it did not measure', () => {
    const child = controllable();
    const registry = new WorkerRegistry(() => 0);
    const launched = launchWorker(request(), {
      shell: child.shell,
      registry,
      clock: () => 0,
    });
    // No exit yet: the teardown leg is unmeasured, and the sample says so
    // with 0 — a launch that has not torn down cannot report a pass on it.
    expect(launched.perf().sample.teardownSettledMs).toBe(0);
    expect(launched.perf().sample.teardownInitiateMs).toBe(0);
    expect(launched.processStatus()).toBe('ready');
  });

  it('builds the §68 worker result from what the child actually did', async () => {
    let now = 5_000;
    const child = controllable();
    const registry = new WorkerRegistry(() => now);
    const launched = launchWorker(request(), {
      shell: child.shell,
      registry,
      clock: () => now,
    });
    child.emit(`${READY}\n`);
    await launched.ready;
    now += 70;
    child.exit(0);
    await launched.wait();
    // §13 (issue #151): a clean exit leaves the agent SETTLING; the run path
    // settles it once the §68 report has been validated. A result read
    // before that settle reports the unsettled failure, so the test settles
    // it the way the run does.
    expect(launched.agentStatus()).toBe('settling');
    launched.settleAgent('completed');
    const result = launched.result();
    // Provenance is required on EVERY result, including failures (§68):
    // a failed agent that does not report how it ran cannot be replayed.
    expect(result.provenance.workerId).toBe('worker-1');
    expect(result.status).toBe<ResultStatus>('completed');
    expect(result.filesChanged).toEqual([]);
    // The result survives the contract's own validator — the worker
    // contract cannot drift from what the launch emits (§68 closed world).
    expect(validateAgentResult(result)).toMatchObject({ valid: true });
    // Wall time is the injected clock's span from spawn to exit.
    expect(result.metrics.wallMs).toBe(70);
  });

  it('reports a failed launch as a §68 result carrying the error kind', async () => {
    const child = controllable();
    const registry = new WorkerRegistry(() => 0);
    const launched = launchWorker(request(), {
      shell: child.shell,
      registry,
      clock: () => 0,
    });
    child.emit(`${READY}\n`);
    await launched.ready;
    child.exit(6, 'no models available: register a provider first\n');
    await launched.wait();
    const result = launched.result();
    expect(validateAgentResult(result)).toMatchObject({ valid: true });
    expect(result.status).toBe<ResultStatus>('failed');
    // §52/§78: the provider failure keeps its kind, so a failed worker is
    // diagnosable from the result alone.
    expect(result.error?.kind).toBe('provider');
    expect(result.error?.message).toMatch(/exited 6/);
  });

  it('reports a silent child as a spawn_failed §68 result, not a hang', async () => {
    const child = controllable();
    const registry = new WorkerRegistry(() => 0);
    const launched = launchWorker(request({ readyTimeoutMs: 5 }), {
      shell: child.shell,
      registry,
      clock: () => 0,
    });
    await expect(launched.ready).rejects.toThrow(/readiness/i);
    const result = launched.result();
    expect(validateAgentResult(result)).toMatchObject({ valid: true });
    expect(result.status).toBe<ResultStatus>('spawn_failed');
    expect(result.error?.kind).toBe('process');
  });

  it('summarizes the child session usage for the run readout (§39)', async () => {
    // The worker child leaves usage rows in its session; the launch
    // reports the rollup so an orchestrate run can print what the
    // workers actually spent. Summarizing is pure — the rows are
    // injected here, exactly as a fixture (no network, no paid tokens).
    const child = controllable();
    const registry = new WorkerRegistry(() => 0);
    const launched = launchWorker(request(), {
      shell: child.shell,
      registry,
      clock: () => 0,
      usageRows: () => [
        {
          model: 'faux-1',
          provider: 'faux',
          usage: {
            input: 100,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 120,
            cost: {
              total: 0.25,
              input: 0.2,
              output: 0.05,
              cacheRead: 0,
              cacheWrite: 0,
            },
          },
        },
      ],
    });
    child.emit(`${READY}\n`);
    await launched.ready;
    const summary = launched.usage();
    expect(summary.requests).toBe(1);
    expect(summary.input).toBe(100);
    expect(summary.output).toBe(20);
    expect(summary.costTotal).toBeCloseTo(0.25);
    expect(summary.byModel['faux-1']?.requests).toBe(1);
    // No rows wired (a worker whose session was not read) is an empty
    // rollup, never a crash.
    const bare = launchWorker(request(), {
      shell: controllable().shell,
      registry: new WorkerRegistry(() => 0),
      clock: () => 0,
    });
    expect(bare.usage().requests).toBe(0);
  });
});

describe('launchWorker §82 resource enforcement (issue #163)', () => {
  it('stops a worker whose RSS breaches the cap, with the named resource code', async () => {
    const child = controllable();
    const registry = new WorkerRegistry(() => 0);
    const debugLines: string[] = [];
    const launched = launchWorker(
      { ...request(), memoryLimitMb: 500 },
      {
        shell: child.shell,
        registry,
        clock: () => 0,
        resourceProbes: { memoryMb: () => 900 },
        debug: (line) => debugLines.push(line),
      },
    );
    child.emit(`${READY}\n`);
    await launched.ready;
    // Deterministic: poll the watchdog the way its interval does.
    expect(await launched.resources()?.poll()).toMatchObject({
      code: 'resource_memory_exceeded',
    });
    // The breach KILLS the child: the manager's stop reaches the process,
    // not just the bookkeeping (AC1's first half).
    await vi.waitFor(() => expect(child.killed()).toBeGreaterThan(0));
    child.exit(137, 'SIGKILL');
    await launched.reap('resource');
    expect(launched.failure()).toMatchObject({
      code: 'resource_memory_exceeded',
    });
    expect(launched.failure()?.message).toMatch(/500MB/);
    expect(launched.agentStatus()).toBe('failed');
    expect(registry.get('worker-1')?.agentStatus).toBe('failed');
    expect(debugLines.join('\n')).toMatch(/resource_memory_exceeded/);
  });

  it('stops a worker whose worktree breaches its quota', async () => {
    const child = controllable();
    const registry = new WorkerRegistry(() => 0);
    const launched = launchWorker(
      { ...request(), diskQuotaMb: 10 },
      {
        shell: child.shell,
        registry,
        clock: () => 0,
        resourceProbes: { diskMb: () => 900 },
      },
    );
    child.emit(`${READY}\n`);
    await launched.ready;
    expect(await launched.resources()?.poll()).toMatchObject({
      code: 'resource_disk_exceeded',
    });
    child.exit(137, 'SIGKILL');
    await launched.reap('resource');
    expect(launched.failure()).toMatchObject({
      code: 'resource_disk_exceeded',
    });
    expect(launched.agentStatus()).toBe('failed');
  });

  it('enforces nothing when no probe is wired (and says so)', async () => {
    const child = controllable();
    const registry = new WorkerRegistry(() => 0);
    const launched = launchWorker(
      { ...request(), memoryLimitMb: 1 },
      {
        shell: child.shell,
        registry,
        clock: () => 0,
      },
    );
    child.emit(`${READY}\n`);
    await launched.ready;
    // No probe: the limit cannot be enforced, so there is no watchdog and no
    // breach to report — the posture `kubic doctor` prints.
    expect(launched.resources()).toBeUndefined();
    child.exit(0);
    await launched.wait();
    expect(launched.failure()).toBeUndefined();
  });
});
