// The live suite runner on the production path (issue #262; design §48,
// §73): `kubic eval --task` and `kubic benchmark` run each built-in
// suite's fixture through the real solo lane and score the trajectory it
// writes. Faux provider only (scripted fixture prompts, real tool calls);
// temp workspaces and a fixture git repo; zero network.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRuntimeConfig } from '../../../packages/host/src/config/runtime.js';
import { NO_PROJECT_TRUST } from '../../../packages/host/src/config/trust-store.js';
import { buildTrajectoryExport } from '../../../packages/trajectory/src/export.js';
import type { CliConfigResult } from './config-runtime.js';
import { createProdRunners } from './prod-runners.js';

const made: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  vi.stubEnv('NO_COLOR', '1');
  vi.stubEnv('KUBIC_PROVIDER', 'faux');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function cliConfig(): CliConfigResult {
  const runtime = loadRuntimeConfig({
    bridge: { exists: () => false, readTextFile: () => '' },
    home: '/nonexistent-home',
    cwd: '/nonexistent-cwd',
    enterprisePath: '/nonexistent/enterprise.toml',
    projectTrusted: true,
    env: {},
  });
  return {
    runtime,
    error: undefined,
    ignoreSplit: { missing: [], checked: [], applicable: false },
    trust: NO_PROJECT_TRUST,
  };
}

function runners(workspace: string) {
  vi.spyOn(process, 'cwd').mockReturnValue(workspace);
  const lines: string[] = [];
  const errs: string[] = [];
  return {
    lines,
    errs,
    r: createProdRunners({
      out: (line) => lines.push(line),
      debug: (line) => errs.push(line),
    }),
  };
}

function git(dir: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  }
}

function fixtureRepo(): string {
  const dir = tmp('kubic-eval-repo-');
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'eval@example.com']);
  git(dir, ['config', 'user.name', 'eval']);
  writeFileSync(join(dir, 'README.md'), 'fixture\n');
  git(dir, ['add', 'README.md']);
  git(dir, [
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--no-verify',
    '-m',
    'base',
  ]);
  return dir;
}

describe('the live suite runner runs the built-in suites (issue #262)', () => {
  it('runs one suite end to end: a record, the §73 fields and a trajectory file', {
    timeout: 60_000,
  }, async () => {
    const workspace = tmp('kubic-eval-ws-');
    const { r, lines, errs } = runners(workspace);
    const code = await r.eval(
      {
        task: 'fix it',
        suite: 'swe-bench-mini',
        model: 'faux/echo',
        worktree: workspace,
        generation: '1',
        size: 'smoke',
        json: true,
      },
      cliConfig(),
    );
    expect(errs).toEqual([]);
    expect(code).toBe(0);
    const envelope = JSON.parse(lines.join('\n')) as {
      ok: boolean;
      record: {
        success: boolean;
        determinism: string;
        size: string;
        costUsd: number;
        tokens: number;
        latencyMs: number;
        toolCalls: number;
        model: string;
        thinking: string | null;
        worktree: string;
        generation: number;
        signals: { tests: string };
      };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.record.success).toBe(true);
    expect(envelope.record.determinism).toBe('live');
    expect(envelope.record.size).toBe('smoke');
    expect(envelope.record.signals.tests).toBe('pass');
    expect(envelope.record.model).toBe('faux/echo');
    expect(envelope.record.worktree).toBe(workspace);
    expect(envelope.record.generation).toBe(1);
    expect(envelope.record.toolCalls).toBeGreaterThan(0);
    // The run wrote its §46 trajectory under the sessions root (the score
    // is derived from it).
    const sessionsRoot = join(homedir(), '.kubic', 'sessions');
    const trajectories: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
        else if (entry.name === 'trajectory.json') {
          trajectories.push(join(dir, entry.name));
        }
      }
    };
    walk(sessionsRoot);
    expect(trajectories).toHaveLength(1);
  });

  it('benchmark runs the matrix and exits 0 by verdict', {
    timeout: 120_000,
  }, async () => {
    const workspace = tmp('kubic-eval-ws-');
    const { r, lines } = runners(workspace);
    const code = await r.benchmark(
      {
        model: 'faux/echo',
        worktree: workspace,
        generation: '1',
        size: 'smoke',
        json: true,
      },
      cliConfig(),
    );
    expect(code).toBe(0);
    const envelope = JSON.parse(lines.join('\n')) as {
      ok: boolean;
      results: Array<{
        suite: string;
        skipped: boolean;
        success: boolean;
        determinism: string;
        model?: string;
        worktree?: string;
        generation?: number;
        toolCalls?: number;
      }>;
    };
    expect(envelope.ok).toBe(true);
    const executed = envelope.results.filter((row) => !row.skipped);
    // Every built-in suite but the live-PTY stub executes (issue #262).
    expect(executed.map((row) => row.suite)).toEqual([
      'swe-bench-mini',
      'repo-mod-rename',
      'bugfix-repro',
      'refactor-extract',
      'testgen-cover',
      'review-diff',
      'agentic-live',
    ]);
    for (const row of executed) {
      expect(row.success, row.suite).toBe(true);
      expect(row.determinism).toBe('live');
      // §73 fields on every executed row.
      expect(row.model, row.suite).toBe('faux/echo');
      expect(row.worktree, row.suite).toBe(workspace);
      expect(row.generation, row.suite).toBe(1);
      expect(row.toolCalls, row.suite).toBeGreaterThan(0);
    }
    expect(
      envelope.results.filter((row) => row.skipped).map((row) => row.suite),
    ).toEqual(['terminal-live']);
  });

  it('scores a --trajectory FILE through the prod reader (issue #258)', {
    timeout: 60_000,
  }, async () => {
    const workspace = tmp('kubic-eval-ws-');
    const path = join(workspace, 'run.json');
    writeFileSync(
      path,
      JSON.stringify(
        buildTrajectoryExport({
          task: { taskId: 'task-1', objective: 'fix', role: 'writer' },
          identity: { sessionId: 'sess-1', agentId: 'agent-1', workerId: null },
          model: {
            provider: 'faux',
            model: 'echo',
            thinking: null,
            escalations: [],
          },
          prompt: { text: 'fix', constraints: [] },
          resources: { skills: [], promptTemplates: [] },
          transfer: null,
          actions: [],
          observations: [],
          state: { phase: 'done', snapshot: null },
          provenance: {
            sessionId: 'sess-1',
            agentId: 'agent-1',
            pid: null,
            generation: 0,
            worktree: workspace,
            model: 'faux/echo',
          },
          environment: { capturedFrom: 'used', cwd: workspace, env: {} },
          worktree: { path: workspace, baseRevision: 'abc', branch: null },
          diff: { filesChanged: [], files: [] },
          approvals: [],
          timestamps: {
            startedAt: '2026-09-23T10:00:00.000Z',
            endedAt: '2026-09-23T10:01:00.000Z',
          },
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cachedTokens: 0,
            requests: 1,
            costUsd: 0.01,
            byModel: {},
          },
          result: {
            status: 'completed',
            summary: 'done',
            failureCategory: null,
            error: null,
          },
        }),
      ),
    );
    const { r, lines, errs } = runners(workspace);
    const code = await r.eval(
      {
        suite: 'swe-bench-mini',
        trajectory: path,
        worktree: workspace,
        generation: '0',
        size: 'smoke',
        json: true,
      },
      cliConfig(),
    );
    expect(errs).toEqual([]);
    expect(code).toBe(0);
    const envelope = JSON.parse(lines.join('\n')) as {
      ok: boolean;
      record: { determinism: string; worktree: string };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.record.determinism).toBe('recorded');
    expect(envelope.record.worktree).toBe(workspace);
  });

  it('names an unreadable trajectory file (exit 2, trajectory-unreadable)', {
    timeout: 60_000,
  }, async () => {
    const workspace = tmp('kubic-eval-ws-');
    const { r, lines } = runners(workspace);
    const code = await r.eval(
      {
        suite: 'swe-bench-mini',
        trajectory: join(workspace, 'missing.json'),
        worktree: workspace,
        generation: '0',
        size: 'smoke',
        json: true,
      },
      cliConfig(),
    );
    expect(code).toBe(2);
    const envelope = JSON.parse(lines.join('\n')) as {
      ok: boolean;
      error: { code: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('trajectory-unreadable');
  });

  it('resolves the §73 category alias (--suite swe)', {
    timeout: 60_000,
  }, async () => {
    const workspace = tmp('kubic-eval-ws-');
    const { r, lines } = runners(workspace);
    const code = await r.benchmark(
      {
        suite: 'swe',
        model: 'faux/echo',
        worktree: workspace,
        generation: '1',
        size: 'smoke',
        json: true,
      },
      cliConfig(),
    );
    expect(code).toBe(0);
    const envelope = JSON.parse(lines.join('\n')) as {
      results: Array<{ suite: string }>;
    };
    expect(envelope.results.map((row) => row.suite)).toEqual([
      'swe-bench-mini',
    ]);
  });

  it('--workspace worktree creates and removes a checkout per suite', {
    timeout: 120_000,
  }, async () => {
    const repo = fixtureRepo();
    const { r } = runners(repo);
    const code = await r.benchmark(
      {
        suite: 'swe-bench-mini',
        model: 'faux/echo',
        worktree: repo,
        generation: '1',
        size: 'smoke',
        workspace: 'worktree',
        json: true,
      },
      cliConfig(),
    );
    expect(code).toBe(0);
    // The throwaway checkout is gone: only the fixture's own worktree.
    const list = spawnSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repo,
      encoding: 'utf8',
    }).stdout;
    expect(
      list.split('\n').filter((line) => line.startsWith('worktree ')),
    ).toHaveLength(1);
  });

  it('still refuses a dirty worktree (exit 2)', {
    timeout: 60_000,
  }, async () => {
    const repo = fixtureRepo();
    writeFileSync(join(repo, 'untracked.txt'), 'dirty\n');
    const { r, lines, errs } = runners(repo);
    const code = await r.benchmark(
      {
        suite: 'swe-bench-mini',
        model: 'faux/echo',
        worktree: repo,
        generation: '1',
        size: 'smoke',
        workspace: 'worktree',
        json: true,
      },
      cliConfig(),
    );
    expect(code).toBe(2);
    const envelope = JSON.parse(lines.join('\n')) as {
      ok: boolean;
      error: { code: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('dirty-worktree');
    expect(errs).toEqual([]);
    expect(existsSync(join(repo, 'untracked.txt'))).toBe(true);
  });
});
