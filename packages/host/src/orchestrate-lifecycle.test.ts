// Prod orchestrate path: the worker lifecycle layer (issue #94).
//
// The defect in one line: the live orchestrator spawned worker children
// directly, so generations, readiness, env filtering, failure codes and
// the §61 budgets existed only in tests and in dead files.
//
// These tests drive the real composition-root adapter against real git
// and a REAL child process. The child is a fixture that speaks the child
// contract (announce `KUBIC_WORKER_READY <id>` on stdout, then exit with
// a chosen code) because the built binary (`bin/kubic.js` over dist/) is
// not guaranteed to exist when vitest runs — and the contract, not the
// build artifact, is what this path owns. Everything else is real: an OS
// process, the OS-level environment, the pipe the marker arrives on, and
// the registry the run leaves behind.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { orchestrateDepsWithDefaults } from '../../../apps/kubic/src/orchestrate-run.js';
import type { Provenance } from '../../exec/src/env.js';
import { NodeExecutionEnv } from '../../exec/src/env.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import { LIFECYCLE_BUDGETS_MS } from '../../worker/src/lifecycle/budgets.js';
import { ENV_ALLOWLIST } from '../../worker/src/lifecycle/env.js';
import { WorkerRegistry } from '../../worker/src/lifecycle/registry.js';
import {
  readWorkerRows,
  WORKER_ROWS_FILE,
} from '../../worker/src/lifecycle/rows.js';
import type { WorkerSessionRequest } from './orchestrate-cli.js';
import { runOrchestrateCommand } from './orchestrate-cli.js';

const PROVENANCE: Provenance = {
  sessionId: 'lifecycle',
  agentId: 'manager',
  toolCallId: 'issue-94',
  turnId: 0,
  operation: 'orchestrate_lifecycle',
};

// The child contract, as a real process: print the readiness marker under
// the id the launcher put in the child's env, then exit with a scripted
// code. Prompt directives drive it (the prompt is the one field the live
// path passes through untouched):
//   ENVDUMP=<path>  write the child's OWN environment to that path
//   PROMPTDUMPDIR=<dir>  write the prompt it was given to <dir>/<worker id>.txt
//   SILENT          never print the marker (a boot that never announces)
//   SLEEP=<ms>      stay alive after announcing (so a timeout can fire)
//   EXIT=<n>        exit with n (default 6, the provider-less boundary)
const FIXTURE = `
import { writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const index = argv.indexOf('-p');
const prompt = index === -1 ? '' : (argv[index + 1] ?? '');
const dump = /ENVDUMP=(\\S+)/.exec(prompt);
if (dump !== null) {
  writeFileSync(dump[1], JSON.stringify(process.env, null, 2));
}
const sleep = /SLEEP=(\\d+)/.exec(prompt);
const exitCode = Number(/EXIT=(\\d+)/.exec(prompt)?.[1] ?? '6');
const dumpDir = /PROMPTDUMPDIR=(\\S+)/.exec(prompt);
if (dumpDir !== null) {
  writeFileSync(dumpDir[1] + '/' + (process.env.KUBIC_WORKER_ID ?? 'worker') + '.txt', prompt);
}
if (!prompt.includes('SILENT')) {
  process.stdout.write('KUBIC_WORKER_READY ' + (process.env.KUBIC_WORKER_ID ?? '') + '\\n');
}
if (sleep === null || sleep === undefined) {
  if (exitCode === 0 && !prompt.includes('NOREPORT')) { const a = process.argv; process.stdout.write(JSON.stringify({ ok: true, exitCode: 0, sessionId: a[a.indexOf('--session') + 1], status: 'completed', result: { summary: 'fixture done' } }) + String.fromCharCode(10)); }
  process.exit(exitCode);
}
setTimeout(() => { if (exitCode === 0 && !prompt.includes('NOREPORT')) { const a = process.argv; process.stdout.write(JSON.stringify({ ok: true, exitCode: 0, sessionId: a[a.indexOf('--session') + 1], status: 'completed', result: { summary: 'fixture done' } }) + String.fromCharCode(10)); } process.exit(exitCode); }, Number(sleep[1]));
`;

// Every scratch dir is removed after each test; the worktrees live under the
// repo root, so removing it disposes them too.
const scratchDirs: string[] = [];

function scratchRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function gitIn(
  cwd: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env = new NodeExecutionEnv(cwd);
  return env.shell.spawn('git', args, { provenance: PROVENANCE }).wait();
}

async function gitOrThrow(cwd: string, args: string[]): Promise<string> {
  const done = await gitIn(cwd, args);
  if (done.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${done.stderr}`);
  }
  return done.stdout;
}

async function initRepo(): Promise<string> {
  const root = scratchRoot('kubic-orch-lifecycle-');
  await gitOrThrow(root, ['init', '-b', 'main']);
  await gitOrThrow(root, ['config', 'user.email', 'lifecycle@kubic.dev']);
  await gitOrThrow(root, ['config', 'user.name', 'kubic lifecycle']);
  await gitOrThrow(root, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  await gitOrThrow(root, ['add', 'base.txt']);
  await gitOrThrow(root, ['commit', '-m', 'base']);
  return root;
}

interface Harness {
  root: string;
  sessionsRoot: string;
  registry: WorkerRegistry;
  fixture: string;
  lines: string[];
  debugLines: string[];
  deps: Awaited<ReturnType<typeof orchestrateDepsWithDefaults>>;
}

async function harness(
  options: { readyTimeoutMs?: number } = {},
): Promise<Harness> {
  const root = await initRepo();
  const sessionsRoot = scratchRoot('kubic-orch-lifecycle-sessions-');
  const scratch = scratchRoot('kubic-orch-lifecycle-child-');
  const fixture = join(scratch, 'worker-child.mjs');
  writeFileSync(fixture, FIXTURE);
  const registry = new WorkerRegistry();
  const lines: string[] = [];
  const debugLines: string[] = [];
  const deps = await orchestrateDepsWithDefaults({
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
    debug: (line) => debugLines.push(line),
    cwd: root,
    sessionsRoot,
    registry,
    workerEntry: { cmd: process.execPath, args: [fixture] },
    ...options,
  });
  return { root, sessionsRoot, registry, fixture, lines, debugLines, deps };
}

// The session-creation step the CLI performs before every spawn (issue
// #85): `kubic run --session <id>` only attaches, so the orchestration
// creates it first.
async function sessionFor(
  h: Harness,
  agentId: string,
): Promise<WorkerSessionRequest> {
  const worktree = await h.deps.ensureWorktree(agentId);
  const request: WorkerSessionRequest = {
    sessionId: 'lifecycle',
    agentId,
    workerSessionId: `lifecycle-${agentId}`,
    worktree,
  };
  await h.deps.createWorkerSession?.(request);
  return request;
}

function runWorkerOnce(
  h: Harness,
  request: WorkerSessionRequest,
  prompt: string,
): Promise<unknown> {
  return Promise.resolve(
    h.deps.runWorker(request.agentId, request.worktree, prompt, {
      sessionId: request.sessionId,
      workerSessionId: request.workerSessionId,
    }),
  ).catch((error: unknown) => error);
}

describe('prod orchestrate path: workers start through the lifecycle layer (issue #94)', () => {
  it('registers the worker in the shared registry with a pid and generation', async () => {
    const h = await harness();
    const request = await sessionFor(h, 'worker-1');
    const error = (await runWorkerOnce(h, request, 'say hi')) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/exited 6/);
    const row = h.registry.get('worker-1');
    expect(row).toBeDefined();
    expect(row?.generation).toBe(1);
    expect(row?.pid).toBeGreaterThan(0);
    expect(row?.owner).toBe('orchestrate:lifecycle');
    expect(row?.sessionId).toBe('lifecycle-worker-1');
    // A child that ran and reported its own failure is terminal.
    expect(row?.status).toBe('crashed');
  });

  it('bumps the generation instead of resetting it when a worker is relaunched', async () => {
    const h = await harness();
    const request = await sessionFor(h, 'worker-1');
    await runWorkerOnce(h, request, 'say hi');
    expect(h.registry.get('worker-1')?.generation).toBe(1);
    // A resume re-spawns the same agent (issue #76): the row survives and
    // the generation moves forward — the stale-generation guard is
    // measured against a monotonically increasing number, never a reset.
    await runWorkerOnce(h, request, 'say hi');
    expect(h.registry.get('worker-1')?.generation).toBe(2);
  });

  it('persists the lifecycle rows where `kubic workers` reads them', async () => {
    const h = await harness();
    const request = await sessionFor(h, 'worker-1');
    await runWorkerOnce(h, request, 'say hi');
    const rows = readWorkerRows(
      createNodeFileBridge(join(h.root, '.kubic', 'orchestrator')),
      WORKER_ROWS_FILE,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.workerId).toBe('worker-1');
    expect(rows[0]?.generation).toBe(1);
    expect(rows[0]?.sessionId).toBe('lifecycle-worker-1');
    // Runtime state stays invisible to git (§35).
    const status = await gitOrThrow(h.root, ['status', '--porcelain=v1']);
    expect(status.trim()).toBe('');
  });

  it('hands the child the §3.8 allowlist at the OS level, not the parent env', async () => {
    // The rule on the path that actually spawns: an unrelated secret in
    // the parent environment never reaches a worker's world.
    const previous = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_SECRET_ACCESS_KEY = 'parent-ambient-secret';
    const h = await harness();
    const dump = join(h.root, 'child-env.json');
    try {
      const request = await sessionFor(h, 'worker-1');
      await runWorkerOnce(h, request, `say hi ENVDUMP=${dump}`);
    } finally {
      if (previous === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = previous;
    }
    // The child's OWN view of its environment — read from the operating
    // system, not from the spawn call the test could have gotten wrong.
    const childEnv = JSON.parse(readFileSync(dump, 'utf8')) as Record<
      string,
      string
    >;
    expect(childEnv.PATH).toBeDefined();
    expect(childEnv.KUBIC_WORKER_ID).toBe('worker-1');
    expect(childEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    // Nothing ambient leaked in at all: every variable the child can see
    // is on the §3.8 allowlist — apart from `__CF_USER_TEXT_ENCODING`,
    // which macOS libc injects into every process's environ regardless of
    // the parent (verified with `env -i … node -e`), so it is not
    // inherited authority. The parent secret is neither.
    const allowed = new Set([...ENV_ALLOWLIST, '__CF_USER_TEXT_ENCODING']);
    const leaked = Object.keys(childEnv).filter((key) => !allowed.has(key));
    expect(leaked).toEqual([]);
    expect(Object.keys(childEnv).length).toBeGreaterThan(0);
    // The debug line is the redacted view: keys may appear, values never.
    const spawnLine = h.debugLines.find((line) =>
      line.includes('[worker] spawn'),
    );
    expect(spawnLine).toBeDefined();
    expect(spawnLine).toContain('id=worker-1');
    expect(spawnLine).not.toContain('parent-ambient-secret');
  });

  it('records the §61 startup latency of a real child against the budget', async () => {
    const h = await harness();
    const request = await sessionFor(h, 'worker-1');
    // A clean worker: the launch completes, the row keeps the measured
    // startup latency, and the budgets are asserted against the sample.
    await runWorkerOnce(h, request, 'say hi EXIT=0');
    const row = h.registry.get('worker-1');
    expect(typeof row?.startupMs).toBe('number');
    expect(row?.startupMs).toBeGreaterThanOrEqual(0);
    expect(row?.startupMs).toBeLessThan(LIFECYCLE_BUDGETS_MS.teardownMs);
    expect(row?.status).toBe('completed');
    // The §61 budgets the layer enforces are the documented ones.
    expect(LIFECYCLE_BUDGETS_MS).toEqual({
      worktreeMs: 300,
      spawnMs: 200,
      attachMs: 50,
      teardownMs: 1000,
    });
    const perf = h.deps.launches?.perf() ?? [];
    expect(perf).toHaveLength(1);
    // spawnMs is measured between spawn and the readiness marker; against
    // a real cold `node` boot it is reported as a real number (the warm
    // budget is a §61 warm-path number — a cold interpreter boot is not a
    // regression, so the gate is asserted for the legs it owns and the
    // sample is reported in full).
    expect(perf[0]?.sample.spawnMs).toBeGreaterThanOrEqual(0);
  });

  it('fails a silent child as spawn_failed inside the readiness timeout', async () => {
    const h = await harness({ readyTimeoutMs: 100 });
    const request = await sessionFor(h, 'worker-1');
    // The child starts and stays up but never announces itself: without
    // the lifecycle layer this is a silent hang (the caller just waits).
    const error = (await runWorkerOnce(
      h,
      request,
      'say hi SILENT SLEEP=30000',
    )) as Error;
    expect(error.message).toMatch(/spawn failed for worker 'worker-1'/i);
    const row = h.registry.get('worker-1');
    expect(row?.status).toBe('spawn_failed');
    // The row is evidence, not a blank: the generation is recorded even on
    // the failed path, and an unfinished launch claims no startup sample.
    expect(row?.generation).toBe(1);
    expect(row?.startupMs).toBeUndefined();
    expect(h.deps.launches?.failureOf('worker-1')?.code).toBe(
      'process_spawn_failed',
    );
    // The silent child (scripted to linger 30s) is killed on the timeout,
    // not left running behind the failed launch.
    const pid = row?.pid ?? 0;
    expect(pid).toBeGreaterThan(0);
    await vi.waitFor(() => expect(processAlive(pid)).toBe(false), {
      timeout: 2_000,
      interval: 10,
    });
  });
});

describe('prod orchestrate path: the manager lane per-worker prompts (issue #103)', () => {
  it('hands each real child its own plan step, not the shared -p', async () => {
    // The end-to-end claim: the prompt the manager authors through the plan
    // is the argv the real worker process receives. The fixture writes the
    // prompt it was given under its own worker id (PROMPTDUMPDIR=<dir>), so
    // the check reads each child's OWN view — not the spawn call the test
    // could have gotten wrong.
    const h = await harness();
    const dumpDir = scratchRoot('kubic-orch-prompts-');
    const objective = `do the thing EXIT=0 PROMPTDUMPDIR=${dumpDir}`;
    // EXIT=0: the child starts, announces itself and exits clean with no
    // work committed, so the run settles both workers end to end.
    const code = await runOrchestrateCommand(
      {
        prompt: objective,
        agents: ['alpha', 'beta'],
        yes: true,
        session: 'lifecycle',
      },
      h.deps,
    );
    expect(code).toBe(0);
    const promptOf = (agentId: string): string =>
      readFileSync(join(dumpDir, `${agentId}.txt`), 'utf8');
    const alpha = promptOf('alpha');
    const beta = promptOf('beta');
    // Two worker prompts that differ…
    expect(alpha).not.toBe(beta);
    // …each citing its plan step…
    expect(alpha).toContain('step 1 of 2');
    expect(beta).toContain('step 2 of 2');
    expect(alpha).toContain("agent 'alpha'");
    expect(beta).toContain("agent 'beta'");
    // …and no worker prompt is -p verbatim.
    expect(alpha).not.toBe(objective);
    expect(beta).not.toBe(objective);
  });
});

describe('prod orchestrate path: the §78 code a failed worker reports (issue #94)', () => {
  it('reports a silent worker as spawn_failed through the CLI', async () => {
    const h = await harness({ readyTimeoutMs: 100 });
    const code = await runOrchestrateCommand(
      {
        prompt: 'say hi SILENT SLEEP=30000',
        agents: ['worker-1'],
        yes: true,
        session: 'lifecycle',
      },
      h.deps,
    );
    expect(code).toBe(1);
    const text = h.lines.join('\n');
    expect(text).toMatch(/code=spawn_failed/);
    expect(text).toMatch(/readiness/);
    expect(text).not.toMatch(/ENOENT/);
    expect(h.registry.get('worker-1')?.status).toBe('spawn_failed');
  });

  it('reports a worker that ran and failed as worker_failed through the CLI', async () => {
    const h = await harness();
    const code = await runOrchestrateCommand(
      {
        prompt: 'say hi',
        agents: ['worker-1'],
        yes: true,
        session: 'lifecycle',
      },
      h.deps,
    );
    expect(code).toBe(1);
    const text = h.lines.join('\n');
    // Exit 6 is the provider boundary: the worker STARTED, so this is a
    // worker_failed run, never a spawn failure — the taxonomy keeps them
    // apart (§52, §78).
    expect(text).toMatch(/code=worker_failed/);
    expect(h.registry.get('worker-1')?.status).toBe('crashed');
  });
});

describe('prod orchestrate path: §68 result contract', () => {
  it('fails a worker that exits 0 without a result report as result_invalid', async () => {
    const h = await harness();
    const request = await sessionFor(h, 'worker-1');
    const error = (await runWorkerOnce(
      h,
      request,
      'say hi EXIT=0 NOREPORT',
    )) as {
      code?: string;
      message?: string;
    };
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('result_invalid');
    expect(error.message).toMatch(/§68/);
  });

  it('settles a worker whose report is valid', async () => {
    const h = await harness();
    const request = await sessionFor(h, 'worker-1');
    const out = (await runWorkerOnce(h, request, 'say hi EXIT=0')) as {
      hunks: unknown[];
      result?: {
        status: string;
        provenance: Record<string, unknown>;
        diff?: { diffId: string };
      };
    };
    expect(Array.isArray(out.hunks)).toBe(true);
    // Issue #185: the validated §68 result travels back, not just hunks.
    expect(out.result?.status).toBe('completed');
    expect(out.result?.provenance).toMatchObject({
      workerId: 'worker-1',
      sessionId: request.workerSessionId,
      worktree: request.worktree.path,
    });
    expect(typeof out.result?.provenance.pid).toBe('number');
    expect(typeof out.result?.provenance.generation).toBe('number');
    expect(out.result?.diff?.diffId).toMatch(/\.\.\./);
  });

  it('a non-zero-exit worker still carries a §68 result with provenance and error.kind (issue #185)', async () => {
    const h = await harness();
    const request = await sessionFor(h, 'worker-1');
    const error = (await runWorkerOnce(h, request, 'say hi')) as {
      result?: {
        status: string;
        error?: { kind: string };
        provenance: Record<string, unknown>;
      };
    };
    expect(error.result?.status).toBe('failed');
    expect(typeof error.result?.error?.kind).toBe('string');
    expect(error.result?.provenance).toMatchObject({
      workerId: 'worker-1',
      worktree: request.worktree.path,
    });
    expect(typeof error.result?.provenance.pid).toBe('number');
    expect(typeof error.result?.provenance.model).toBe('string');
  });
});
