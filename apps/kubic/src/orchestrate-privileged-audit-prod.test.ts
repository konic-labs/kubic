// Privileged-action §60 rows on the prod orchestrate path (issue #284) —
// real git, real child processes, no provider. A faux run whose one worker
// edits a file and completes (merge approved by `--yes`) must leave one
// `worktree-create`, one `worker-spawn`, one `worker-terminate` and one
// `merge` row, each carrying the live provenance (real pid, generation,
// worktree path, base revision).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createGitSandbox,
  disposeAllGitSandboxes,
  type GitSandbox,
} from '../../../packages/exec/src/test-support/git-sandbox.js';
import { runOrchestrateCommand } from '../../../packages/host/src/orchestrate-cli.js';
import {
  auditLedgerDirFor,
  readAuditLedger,
} from '../../../packages/host/src/policy/audit-ledger.js';
import { orchestrateDepsWithDefaults } from './orchestrate-run.js';

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
  driver = undefined;
  disposeAllGitSandboxes();
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The test's git driver (issue #420): one injected sandbox per test, so the
// fixture setup and the production git the merge path shells share the
// scrubbed view. Repos keep their own scratch dirs; only the env is shared.
let driver: GitSandbox | undefined;

function git(cwd: string, args: string[]): string {
  driver ??= createGitSandbox({ injectProcessEnv: true });
  return driver.git(args, { cwd });
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
      // Issue #278 (§19): the run opens with its §19 mode (`--yes` is
      // the standing answer, so this run is autonomous).
      'run:start',
      `worktree-create:${branch}`,
      'worker-spawn:worker-1',
      'worker-terminate:worker-1',
      `merge:${branch}`,
    ]);
    expect(byWhat.get('run:start')).toMatchObject({
      mode: 'orchestrator',
      result: 'ok',
    });
    expect(byWhat.get('run:start')?.reason).toContain('autonomous');

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
