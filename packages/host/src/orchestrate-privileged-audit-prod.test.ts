// Privileged-action §60 rows on the prod orchestrate path (issue #284) —
// real git, real child processes, no provider. A faux run whose one worker
// edits a file and completes (merge approved by `--yes`) must leave one
// `worktree-create`, one `worker-spawn`, one `worker-terminate` and one
// `merge` row, each carrying the live provenance (real pid, generation,
// worktree path, base revision).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { orchestrateDepsWithDefaults } from '../../../apps/kubic/src/orchestrate-run.js';
import { runOrchestrateCommand } from './orchestrate-cli.js';
import { auditLedgerDirFor, readAuditLedger } from './policy/audit-ledger.js';

const fixture = `
import { writeFileSync } from 'node:fs';
writeFileSync('work.txt', 'work\\n');
process.stdout.write('KUBIC_WORKER_READY ' + (process.env.KUBIC_WORKER_ID ?? '') + '\\n');
const a = process.argv;
process.stdout.write(JSON.stringify({ ok: true, exitCode: 0, sessionId: a[a.indexOf('--session') + 1], status: 'completed', result: { summary: 'did X' }, model: 'faux/faux-1' }) + String.fromCharCode(10));
process.exit(0);
`;

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

// Hermetic git env (issue #284 review — same as the sibling #282 test):
// machine-global config (hooks, signing) must not flake the fixture.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
}

describe('privileged-action audit rows on the prod path (issue #284)', () => {
  it('a faux run that merges one worker records spawn, terminate, create and merge rows', async () => {
    const root = scratch('kubic-orch-284-');
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.email', 'issue284@kubic.dev']);
    git(root, ['config', 'user.name', 'kubic issue284']);
    git(root, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(root, 'base.txt'), 'base\n');
    git(root, ['add', 'base.txt']);
    git(root, ['commit', '-m', 'base']);
    const head = git(root, ['rev-parse', 'HEAD']).trim();
    const child = join(scratch('kubic-orch-284-child-'), 'worker.mjs');
    writeFileSync(child, fixture);
    const lines: string[] = [];
    const deps = await orchestrateDepsWithDefaults({
      out: (line) => lines.push(line),
      err: () => undefined,
      cwd: root,
      sessionsRoot: scratch('kubic-orch-284-sessions-'),
      workerEntry: { cmd: process.execPath, args: [child] },
    });
    const code = await runOrchestrateCommand(
      {
        prompt: 'work',
        agents: ['worker-1'],
        session: 'paudit284',
        yes: true,
      },
      deps,
    );
    expect(code, lines.join('\n')).toBe(0);

    const rows = readAuditLedger(auditLedgerDirFor(root));
    const byWhat = new Map(rows.map((row) => [row.what, row]));
    const branch = 'kubic/paudit284/worker-1';
    expect([...byWhat.keys()]).toEqual([
      `worktree-create:${branch}`,
      'worker-spawn:worker-1',
      'worker-terminate:worker-1',
      `merge:${branch}`,
    ]);

    const created = byWhat.get(`worktree-create:${branch}`);
    expect(created?.mode).toBe('orchestrator');
    expect(created?.workspace.base).toBe(head);

    const spawned = byWhat.get('worker-spawn:worker-1');
    expect(spawned?.mode).toBe('orchestrator');
    expect(spawned?.agent).toEqual({
      session: 'paudit284',
      role: 'manager',
    });
    expect(spawned?.worker.pid).toBeGreaterThan(0);
    // A fresh run registers at generation 1 (launch.ts) — the row carries
    // the live registry value, not an assumed 0.
    expect(spawned?.worker.generation).toBe(1);
    expect(spawned?.workspace.path).toContain('worker-1');
    expect(spawned?.workspace.base).toBe(head);

    const terminated = byWhat.get('worker-terminate:worker-1');
    expect(terminated?.result).toBe('ok');
    expect(terminated?.reason).toBe('ok');
    expect(terminated?.worker.pid).toBe(spawned?.worker.pid);

    const merged = byWhat.get(`merge:${branch}`);
    expect(merged?.mode).toBe('orchestrator');
    expect(merged?.who).toBe('agent:worker-1');
    expect(merged?.reason).toContain(spawned?.workspace.path as string);

    // The merged file is really in the repo.
    expect(readFileSync(join(root, 'work.txt'), 'utf8')).toBe('work\n');
  }, 60_000);
});
