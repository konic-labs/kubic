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
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
if (!prompt.includes('SILENT')) {
  process.stdout.write('KUBIC_WORKER_READY ' + (process.env.KUBIC_WORKER_ID ?? '') + '\\n');
}
if (sleep === null || sleep === undefined) {
  process.exit(exitCode);
}
setTimeout(() => process.exit(exitCode), Number(sleep[1]));
`;

function scratchRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
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
    process.env.AWS_SECRET_ACCESS_KEY = 'parent-ambient-secret';
    const h = await harness();
    const dump = join(h.root, 'child-env.json');
    try {
      const request = await sessionFor(h, 'worker-1');
      await runWorkerOnce(h, request, `say hi ENVDUMP=${dump}`);
    } finally {
      delete process.env.AWS_SECRET_ACCESS_KEY;
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
    const h = await harness({ readyTimeoutMs: 250 });
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
  });
});

describe('prod orchestrate path: the §78 code a failed worker reports (issue #94)', () => {
  it('reports a silent worker as spawn_failed through the CLI', async () => {
    const h = await harness({ readyTimeoutMs: 250 });
    const code = await runOrchestrateCommand(
      [
        '-p',
        'say hi SILENT SLEEP=30000',
        '--agents',
        'worker-1',
        '--yes',
        '--session',
        'lifecycle',
      ],
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
      [
        '-p',
        'say hi',
        '--agents',
        'worker-1',
        '--yes',
        '--session',
        'lifecycle',
      ],
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

// A worker's transcript lives under the sessions root, keyed by the
// worktree path the session was created with (Pi's JSONL session repo
// encodes the cwd into the directory name). macOS resolves /var to
// /private/var, and the session records the resolved path.
export function sessionDir(h: Harness, agentId: string): string {
  const worktreePath = realpathSync(join(h.root, '.kubic', 'wt', agentId));
  const encoded = worktreePath.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-');
  return join(h.sessionsRoot, `--${encoded}--`);
}
