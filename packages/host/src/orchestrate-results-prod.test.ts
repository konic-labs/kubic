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
import { NodeExecutionEnv } from '../../exec/src/env.js';
import { runOrchestrateCommand } from './orchestrate-cli.js';
import { addWorktree } from './orchestrator/worktree/add.js';

const fixture = (exit: number) => `
import { writeFileSync } from 'node:fs';
writeFileSync('work.txt', 'work\\n');
process.stdout.write('KUBIC_WORKER_READY ' + (process.env.KUBIC_WORKER_ID ?? '') + '\\n');
const a = process.argv;
process.stdout.write(JSON.stringify({ ok: ${exit === 0}, exitCode: ${exit}, sessionId: a[a.indexOf('--session') + 1], status: ${exit === 0 ? "'completed'" : "'failed'"}, result: { summary: 'did X' }, model: 'faux/faux-1', usage: { ref: 'usage:x', input: 120, output: 30, cacheRead: 7, cacheWrite: 0, costUsd: 0.25, toolCalls: 3 } }) + String.fromCharCode(10));
process.exit(${exit});
`;

// Issue #280: the exact envelope a `kubic run` that hit its own wall-clock
// bound prints — status timeout, exit 1 (never the budget code).
const timeoutFixture = `
import { writeFileSync } from 'node:fs';
writeFileSync('work.txt', 'work\\n');
process.stdout.write('KUBIC_WORKER_READY ' + (process.env.KUBIC_WORKER_ID ?? '') + '\\n');
const a = process.argv;
process.stdout.write(JSON.stringify({ ok: false, exitCode: 1, sessionId: a[a.indexOf('--session') + 1], status: 'timeout', result: { summary: 'run timed out after 50ms' }, error: { kind: 'timeout', message: 'run timed out after 50ms' }, model: 'faux/faux-1' }) + String.fromCharCode(10));
process.exit(1);
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

  it('a worker that timed out reports status timeout, never budget_exhausted (issue #280)', async () => {
    const root = initRepo185();
    const child = join(scratch('kubic-orch-280-child-'), 'worker-timeout.mjs');
    writeFileSync(child, timeoutFixture);
    const lines: string[] = [];
    const deps = await orchestrateDepsWithDefaults({
      out: (line) => lines.push(line),
      err: () => undefined,
      cwd: root,
      sessionsRoot: scratch('kubic-orch-280-sessions-'),
      workerEntry: { cmd: process.execPath, args: [child] },
    });
    const code = await runOrchestrateCommand(
      {
        prompt: 'work',
        agents: ['worker-1'],
        session: 'r280',
        yes: true,
        json: true,
      },
      deps,
    );
    expect(code).toBe(1);
    const envelope = JSON.parse(lines.join('\n')) as {
      workers: { status?: string }[];
    };
    // The child's own terminus survives the manager: a wall-clock bound is
    // not a configured budget (§71, issue #280).
    expect(envelope.workers[0]?.status).toBe('timeout');
    expect(savedState(root, 'r280').records[0]?.result?.status).toBe('timeout');
  });
});

// Issue #185: every terminus carries its §68 result — and the SAVED state
// does too. A failure used to reach only the run's envelope: a failing
// worker left `records: 0`, and a worker that never launched (the worktree
// stage) had no result at all.
interface SavedState {
  pending: string[];
  merged: string[];
  records: {
    agentId: string;
    branch: string;
    hunks: unknown[];
    result?: {
      status: string;
      summary: string;
      error?: { kind: string; message: string; details?: { code?: string } };
      provenance: Record<string, unknown>;
      metrics: Record<string, number>;
    };
  }[];
}

function initRepo185(): string {
  const root = realpathSync(scratch('kubic-orch-185-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'issue185@kubic.dev']);
  git(root, ['config', 'user.name', 'kubic issue185']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  git(root, ['add', 'base.txt']);
  git(root, ['commit', '-m', 'base']);
  return root;
}

async function depsWith(root: string, exit: number, lines: string[]) {
  const child = join(scratch('kubic-orch-185-child-'), 'worker.mjs');
  writeFileSync(child, fixture(exit));
  return orchestrateDepsWithDefaults({
    out: (line) => lines.push(line),
    err: () => undefined,
    cwd: root,
    sessionsRoot: scratch('kubic-orch-185-sessions-'),
    workerEntry: { cmd: process.execPath, args: [child] },
  });
}

function savedState(root: string, session: string): SavedState {
  return JSON.parse(
    readFileSync(
      join(root, '.kubic', 'orchestrator', `${session}.json`),
      'utf8',
    ),
  ) as SavedState;
}

describe('failure results persist with the run state (issue #185)', () => {
  it('a failing worker leaves its §68 failure result in the saved records, still pending for resume', async () => {
    const root = initRepo185();
    const lines: string[] = [];
    const code = await runOrchestrateCommand(
      { prompt: 'work', agents: ['worker-1'], session: 'f185', yes: true },
      await depsWith(root, 6, lines),
    );
    expect(code).toBe(1);
    const state = savedState(root, 'f185');
    expect(state.records).toHaveLength(1);
    const record = state.records[0];
    expect(record?.agentId).toBe('worker-1');
    expect(record?.branch).toBe('kubic/f185/worker-1');
    expect(record?.hunks).toEqual([]);
    expect(record?.result?.status).toBe('failed');
    expect(typeof record?.result?.error?.kind).toBe('string');
    expect(record?.result?.provenance).toMatchObject({
      workerId: 'worker-1',
      sessionId: 'f185-worker-1',
      model: 'faux/faux-1',
    });
    // The failed worker was NOT merged: resume retries it.
    expect(state.pending).toEqual(['worker-1']);
    expect(state.merged).toEqual([]);
  });

  it('a failed worker retried under --resume replaces its failure record — one record, the completed result', async () => {
    const root = initRepo185();
    const first: string[] = [];
    expect(
      await runOrchestrateCommand(
        { prompt: 'work', agents: ['worker-1'], session: 'g185', yes: true },
        await depsWith(root, 6, first),
      ),
    ).toBe(1);
    const second: string[] = [];
    const code = await runOrchestrateCommand(
      { resume: true, session: 'g185', yes: true },
      await depsWith(root, 0, second),
    );
    expect(code, second.join('\n')).toBe(0);
    const state = savedState(root, 'g185');
    expect(state.records).toHaveLength(1);
    expect(state.records[0]?.result?.status).toBe('completed');
    expect(state.merged).toEqual(['worker-1']);
    expect(state.pending).toEqual([]);
    expect(second.join('\n')).toContain('orchestrated 1 worker(s), merged 1');
  });

  it('a worker that never launched (worktree stage) gets a synthesized spawn_failed result in the envelope and the state', async () => {
    const root = initRepo185();
    await addWorktree(new NodeExecutionEnv(root), root, 'worker-1', {
      sessionId: 'w185',
      ownerSession: 'w185',
    });
    const lines: string[] = [];
    const code = await runOrchestrateCommand(
      {
        prompt: 'work',
        agents: ['worker-1'],
        session: 'w185',
        yes: true,
        json: true,
      },
      await depsWith(root, 0, lines),
    );
    expect(code).toBe(1);
    const envelope = JSON.parse(lines.join('\n')) as {
      error: { code: string };
      workers: {
        agentId: string;
        status?: string;
        summary?: string;
        error?: { kind: string; message: string; details?: { code?: string } };
        provenance?: Record<string, unknown>;
      }[];
    };
    expect(envelope.error.code).toBe('worktree_exists');
    const worker = envelope.workers[0];
    expect(worker?.status).toBe('spawn_failed');
    expect(worker?.error?.kind).toBe('workspace');
    expect(worker?.error?.details?.code).toBe('worktree_exists');
    expect(worker?.summary).toContain("spawn failed for worker 'worker-1'");
    expect(worker?.summary).toContain('retained from an earlier run');
    expect(worker?.provenance).toMatchObject({
      workerId: 'worker-1',
      sessionId: 'w185-worker-1',
      pid: null,
      generation: 0,
      model: 'unresolved',
    });
    // Saved too, so `--resume` and any reader of the state see the failure.
    const record = savedState(root, 'w185').records[0];
    expect(record?.agentId).toBe('worker-1');
    expect(record?.result?.status).toBe('spawn_failed');
    expect(record?.result?.error?.details?.code).toBe('worktree_exists');
  });
});

// A failing worker's own words are untrusted text: its stderr / error message
// ends up in the failure message the manager prints as an `error:` line and
// stores as the failure result's summary. Nothing in it may drive the
// operator's terminal.
// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none survive.
const ANY_CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

async function runFailingChild(script: string) {
  const root = initRepo185();
  const child = join(scratch('kubic-orch-185-child-'), 'worker.mjs');
  writeFileSync(child, script);
  const lines: string[] = [];
  const errs: string[] = [];
  const deps = await orchestrateDepsWithDefaults({
    out: (line) => lines.push(line),
    err: (line) => errs.push(line),
    cwd: root,
    sessionsRoot: scratch('kubic-orch-185-sessions-'),
    workerEntry: { cmd: process.execPath, args: [child] },
  });
  const code = await runOrchestrateCommand(
    {
      prompt: 'work',
      agents: ['worker-1'],
      session: 'x185',
      yes: true,
      json: true,
    },
    deps,
  );
  const envelope = JSON.parse(lines.join('\n')) as {
    workers: {
      summary?: string;
      error?: { message: string };
    }[];
  };
  return { code, errs: errs.join('\n'), envelope, root };
}

const READY =
  "process.stdout.write('KUBIC_WORKER_READY ' + (process.env.KUBIC_WORKER_ID ?? '') + '\\n');";

describe('untrusted worker output in failure messages (issue #185)', () => {
  it('strips control characters from a failing child’s stderr in the printed error and the stored result', async () => {
    const run = await runFailingChild(`
${READY}
process.stderr.write('evil \\u001b[2J\\u001b[31m red\\rFAKE: all merged\\u0007\\nsecond line');
process.exit(6);
`);
    expect(run.code).toBe(1);
    const expected =
      'worker run exited 6: evil [2J[31m redFAKE: all merged second line';
    expect(run.errs).toContain(expected);
    expect(run.errs).toMatch(/code=worker_failed/);
    expect(ANY_CONTROL.test(run.errs.replace(/\n/g, ' '))).toBe(false);
    const worker = run.envelope.workers[0];
    expect(worker?.summary).toContain(expected);
    expect(ANY_CONTROL.test(worker?.summary ?? '')).toBe(false);
    expect(ANY_CONTROL.test(worker?.error?.message ?? '')).toBe(false);
    // The saved state carries the same clean text.
    const state = savedState(run.root, 'x185');
    const saved = state.records[0]?.result?.summary ?? '';
    expect(saved).toContain(expected);
    expect(ANY_CONTROL.test(saved)).toBe(false);
  });

  it('strips control characters from the error message of a child’s JSON report', async () => {
    const run = await runFailingChild(`
${READY}
process.stdout.write(JSON.stringify({ ok: false, exitCode: 6, status: 'failed', error: { message: 'bad\\u001b[2J\\u009bmsg\\u202e' } }) + '\\n');
process.exit(6);
`);
    expect(run.code).toBe(1);
    expect(run.errs).toContain('worker run exited 6: bad[2Jmsg');
    expect(ANY_CONTROL.test(run.errs.replace(/\n/g, ' '))).toBe(false);
    expect(run.envelope.workers[0]?.summary).toContain(
      'worker run exited 6: bad[2Jmsg',
    );
  });

  it('strips ESC / OSC / BEL / CR from a report that fails the contract: the raw last line never reaches the error or the stored result', async () => {
    const run = await runFailingChild(`
${READY}
process.stdout.write('evil\\u001b[2J\\u001b]0;pwned\\u0007 \\rFAKE\\n');
process.exit(0);
`);
    expect(run.code).toBe(1);
    const expected =
      'the last output line is not a JSON report object: evil[2J]0;pwned FAKE';
    expect(run.errs).toContain(expected);
    expect(ANY_CONTROL.test(run.errs.replace(/\n/g, ' '))).toBe(false);
    const summary = run.envelope.workers[0]?.summary ?? '';
    expect(summary).toContain(expected);
    expect(ANY_CONTROL.test(summary)).toBe(false);
    const saved = savedState(run.root, 'x185').records[0]?.result?.summary;
    expect(saved).toContain(expected);
    expect(ANY_CONTROL.test(saved ?? '')).toBe(false);
  });

  it('strips controls from the session id and status a JSON report claims', async () => {
    const session = await runFailingChild(`
${READY}
process.stdout.write(JSON.stringify({ ok: true, exitCode: 0, status: 'completed', sessionId: 'x\\u001b[2J\\u0007', result: { summary: 's' } }) + '\\n');
process.exit(0);
`);
    expect(session.errs).toContain("the report names session 'x[2J', not '");
    expect(ANY_CONTROL.test(session.errs.replace(/\n/g, ' '))).toBe(false);
    const status = await runFailingChild(`
${READY}
process.stdout.write(JSON.stringify({ ok: true, exitCode: 0, status: 'done\\u001b[31m', sessionId: 'x' }) + '\\n');
process.exit(0);
`);
    expect(status.errs).toContain(
      'the report is not a completed run (status done[31m)',
    );
    expect(ANY_CONTROL.test(status.errs.replace(/\n/g, ' '))).toBe(false);
  });

  it('caps the quoted last line at 120 characters over what is drawn', async () => {
    const run = await runFailingChild(`
${READY}
process.stdout.write('y\\u001b'.repeat(200) + '\\n');
process.exit(0);
`);
    expect(run.errs).toContain(
      `is not a JSON report object: ${'y'.repeat(120)}`,
    );
    expect(run.errs).not.toContain('y'.repeat(121));
  });

  it('keeps the 300-character cap over what is drawn, not over the stripped controls', async () => {
    const run = await runFailingChild(`
${READY}
process.stderr.write('x\\u001b'.repeat(400));
process.exit(6);
`);
    expect(run.errs).toContain(`worker run exited 6: ${'x'.repeat(300)}`);
    expect(run.errs).not.toContain('x'.repeat(301));
  });
});
