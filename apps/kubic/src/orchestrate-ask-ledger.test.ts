// Audit provenance on the live orchestrate path (issue #282): a worker ask
// record's worker.pid/generation come from the run's worker registry (the
// spawned child's pid, the generation after a respawn), workspace.base is
// the worktree's base revision captured at creation, and model.thinking is
// the run's resolved level — never a hard-coded 0/unknown.
//
// Real git fixture repos (hermetic global config), a real WorkerRegistry,
// the prod deps factory; only the worker CHILD is absent (its registry row
// is written directly, the same row a spawn would record). Temp HOME keeps
// the approvals state out of the real home; every temp dir is removed in
// afterEach. No network, no model.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  auditLedgerDirFor,
  readAuditLedger,
} from '../../../packages/host/src/policy/audit-ledger.js';
import { WorkerRegistry } from '../../../packages/worker/src/lifecycle/registry.js';
import { orchestrateDepsWithDefaults } from './orchestrate-run.js';

const made: string[] = [];

function scratch(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args],
    { cwd, env: GIT_ENV, encoding: 'utf8' },
  );
}

function fixtureRepo(): string {
  const repo = scratch('kubic-282-');
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'init']);
  return repo;
}

function askInput(worktree: string, command: string) {
  return {
    trigger: 'network',
    toolName: 'bash',
    args: { command },
    justification: 'fetch the fixture',
    sessionId: 'orch-282-worker-1',
    agentId: 'worker-1',
    role: 'implementer',
    worktree,
    provenance: { parentSessionId: 'orch-282' },
  };
}

describe('ask ledger provenance on the live orchestrate path (issue #282)', () => {
  it("records the registry pid/generation, the worktree base and the run's thinking level", async () => {
    const repo = fixtureRepo();
    vi.stubEnv('KUBIC_MODEL_THINKING', 'high');
    const registry = new WorkerRegistry(() => 1700000000000);
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      err: () => undefined,
      cwd: repo,
      sessionsRoot: join(repo, 'sessions'),
      registry,
    });
    const worktree = await deps.ensureWorktree('worker-1', {
      sessionId: 'orch-282',
      resume: false,
    });
    // The row a spawn records: the child's pid at generation 0.
    registry.register({
      workerId: 'worker-1',
      sessionId: 'orch-282-worker-1',
      generation: 0,
      owner: 'cli',
      pid: 4242,
    });
    const approvals = deps.approvals;
    if (approvals === undefined) throw new Error('approvals layer missing');
    const run = approvals({
      sessionId: 'orch-282',
      maxPendingMs: 1_000,
    });
    await run.decisions.ask(
      askInput(worktree.path, 'curl https://example.com/a.tgz'),
      { autoApprove: true },
    );
    const [record] = readAuditLedger(auditLedgerDirFor(repo));
    expect(record?.worker).toMatchObject({ pid: 4242, generation: 0 });
    expect(record?.workspace.base).toBe(
      git(worktree.path, ['rev-parse', 'HEAD']).trim(),
    );
    expect(record?.model.thinking).toBe('high');
  });

  it('a respawned worker records its new pid and generation', async () => {
    const repo = fixtureRepo();
    const registry = new WorkerRegistry(() => 1700000000000);
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      err: () => undefined,
      cwd: repo,
      sessionsRoot: join(repo, 'sessions'),
      registry,
    });
    const worktree = await deps.ensureWorktree('worker-1', {
      sessionId: 'orch-282',
      resume: false,
    });
    registry.register({
      workerId: 'worker-1',
      sessionId: 'orch-282-worker-1',
      generation: 0,
      owner: 'cli',
      pid: 4242,
    });
    const approvals = deps.approvals;
    if (approvals === undefined) throw new Error('approvals layer missing');
    const run = approvals({
      sessionId: 'orch-282',
      maxPendingMs: 1_000,
    });
    await run.decisions.ask(
      askInput(worktree.path, 'curl https://example.com/a.tgz'),
      { autoApprove: true },
    );
    // The replacement's row: generation 1, the new child's pid.
    registry.replace('worker-1', 0);
    registry.recordSpawn('worker-1', 9876);
    await run.decisions.ask(
      askInput(worktree.path, 'curl https://example.com/b.tgz'),
      { autoApprove: true },
    );
    const records = readAuditLedger(auditLedgerDirFor(repo));
    expect(records.map((record) => record.worker)).toMatchObject([
      { pid: 4242, generation: 0 },
      { pid: 9876, generation: 1 },
    ]);
  });
});
