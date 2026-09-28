// §68 worker results on the prod orchestrate path (issue #185) — real git,
// real child processes, no provider. The fixture child prints the report
// `kubic run --json` prints (summary, usage rollup, model); the manager must
// surface it per worker instead of keeping only hunk counts.
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { orchestrateDepsWithDefaults } from '../../../apps/kubic/src/orchestrate-run.js';
import { runOrchestrateCommand } from './orchestrate-cli.js';

const fixture = (exit: number) => `
import { writeFileSync } from 'node:fs';
writeFileSync('work.txt', 'work\\n');
process.stdout.write('KUBIC_WORKER_READY ' + (process.env.KUBIC_WORKER_ID ?? '') + '\\n');
const a = process.argv;
process.stdout.write(JSON.stringify({ ok: ${exit === 0}, exitCode: ${exit}, sessionId: a[a.indexOf('--session') + 1], status: ${exit === 0 ? "'completed'" : "'failed'"}, result: { summary: 'did X' }, model: 'faux/faux-1', usage: { ref: 'usage:x', input: 120, output: 30, cacheRead: 7, cacheWrite: 0, costUsd: 0.25, toolCalls: 3 } }) + String.fromCharCode(10));
process.exit(${exit});
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

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function run(exit: number, json: boolean) {
  const root = realpathSync(scratch('kubic-orch-185-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'issue185@kubic.dev']);
  git(root, ['config', 'user.name', 'kubic issue185']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  git(root, ['add', 'base.txt']);
  git(root, ['commit', '-m', 'base']);
  const child = join(scratch('kubic-orch-185-child-'), 'worker.mjs');
  writeFileSync(child, fixture(exit));
  const lines: string[] = [];
  const deps = await orchestrateDepsWithDefaults({
    out: (line) => lines.push(line),
    err: () => undefined,
    cwd: root,
    sessionsRoot: scratch('kubic-orch-185-sessions-'),
    workerEntry: { cmd: process.execPath, args: [child] },
  });
  const code = await runOrchestrateCommand(
    { prompt: 'work', agents: ['worker-1'], session: 'r185', yes: true, json },
    deps,
  );
  return { code, lines, root };
}

describe('§68 worker results on the prod path (issue #185)', () => {
  it('prints the worker summary line and carries usage from the child report', async () => {
    const text = await run(0, false);
    expect(text.code, text.lines.join('\n')).toBe(0);
    expect(text.lines).toContain('worker-1 (worker): did X');

    const json = await run(0, true);
    const envelope = JSON.parse(json.lines.join('\n')) as {
      workers: {
        summary: string;
        status: string;
        role: string;
        usage: Record<string, number>;
        provenance: Record<string, unknown>;
      }[];
    };
    const worker = envelope.workers[0];
    expect(worker?.summary).toBe('did X');
    expect(worker?.status).toBe('completed');
    expect(worker?.role).toBe('worker');
    expect(worker?.usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 30,
      cachedTokens: 7,
      toolCalls: 3,
      costUsd: 0.25,
    });
    expect(worker?.provenance).toMatchObject({
      workerId: 'worker-1',
      sessionId: 'r185-worker-1',
      generation: 1,
      worktree: join(json.root, '.kubic', 'wt', 'r185', 'worker-1'),
      model: 'faux/faux-1',
    });
    expect(typeof worker?.provenance.pid).toBe('number');
    // The result is persisted with the run state.
    const state = JSON.parse(
      readFileSync(
        join(json.root, '.kubic', 'orchestrator', 'r185.json'),
        'utf8',
      ),
    ) as { records: { result?: { summary: string } }[] };
    expect(state.records[0]?.result?.summary).toBe('did X');
  });

  it('a failing worker still reports a result with provenance and error.kind', async () => {
    const failed = await run(6, true);
    expect(failed.code).toBe(1);
    const envelope = JSON.parse(failed.lines.join('\n')) as {
      workers: {
        status?: string;
        error?: { kind: string };
        provenance?: Record<string, unknown>;
      }[];
    };
    expect(envelope.workers[0]?.status).toBe('failed');
    expect(typeof envelope.workers[0]?.error?.kind).toBe('string');
    expect(envelope.workers[0]?.provenance).toMatchObject({
      workerId: 'worker-1',
      model: 'faux/faux-1',
    });
  });
});
