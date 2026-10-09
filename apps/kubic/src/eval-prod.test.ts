// The live suite runner on the production path: `kubic eval --task` and `kubic
// benchmark` run each built-in suite's fixture through the real lane and
// score the trajectory it writes. Faux provider only (scripted fixture prompts,
// real tool calls); temp workspaces and a fixture git repo; zero network.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createGitSandbox,
  disposeAllGitSandboxes,
  type GitSandbox,
} from '@kubic/exec/test-support/git-sandbox';
import { loadRuntimeConfig, NO_PROJECT_TRUST } from '@kubic/host/config';
import { buildTrajectoryExport } from '@kubic/trajectory/export';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../test/temp-dir.js';
import type { CliConfigResult } from './config/load.js';
import { createProdRunners } from './prod-runners.js';

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  vi.stubEnv('NO_COLOR', '1');
  vi.stubEnv('KUBIC_PROVIDER', 'faux');
});

afterEach(() => {
  driver = undefined;
  disposeAllGitSandboxes();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// The test's git driver: one injected sandbox per test, so
// the fixture setup and the worktree git the benchmark path shells share
// the scrubbed view. The fixture keeps its own tmp dir.
let driver: GitSandbox | undefined;

function ensureDriver(): GitSandbox {
  driver ??= createGitSandbox({ injectProcessEnv: true });
  return driver;
}

// The effective config, from an optional global `config.toml` body.
function cliConfig(globalToml?: string): CliConfigResult {
  const globalPath = join('/nonexistent-home', '.kubic', 'config.toml');
  const runtime = loadRuntimeConfig({
    bridge: {
      exists: (path) => globalToml !== undefined && path === globalPath,
      readTextFile: () => globalToml ?? '',
    },
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

// Every trajectory a run wrote under the sessions root.
function trajectoryFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name === 'trajectory.json') {
        found.push(join(dir, entry.name));
      }
    }
  };
  const root = join(homedir(), '.kubic', 'sessions');
  if (existsSync(root)) walk(root);
  return found;
}

function git(dir: string, args: string[]): void {
  ensureDriver().git(args, { cwd: dir });
}

function fixtureRepo(): string {
  const dir = tempDir('kubic-eval-repo-');
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

describe('the live suite runner runs the built-in suites', () => {
  it('runs one suite end to end: a record, the eval fields and a trajectory file', {
    timeout: 60_000,
  }, async () => {
    const workspace = tempDir('kubic-eval-ws-');
    const { r, lines, errs } = runners(workspace);
    const code = (
      await r.eval(
        {
          task: 'fix it',
          suite: 'swe-bench-mini',
          model: 'faux/echo',
          worktree: workspace,
          size: 'smoke',
          json: true,
        },
        cliConfig(),
      )
    ).exitCode;
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
        caseId: string;
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
    expect(envelope.record.caseId).toBe('swe-bench-mini');
    expect(envelope.record.toolCalls).toBeGreaterThan(0);
    // The run wrote its trajectory under the sessions root (the score
    // is derived from it).
    expect(trajectoryFiles()).toHaveLength(1);
  });

  it('loads the configured settings skills into the suite lane', {
    timeout: 60_000,
  }, async () => {
    const workspace = tempDir('kubic-eval-ws-');
    const skill = join(tempDir('kubic-eval-skills-'), 'house-style');
    mkdirSync(skill);
    writeFileSync(
      join(skill, 'SKILL.md'),
      '---\nname: house-style\ndescription: The house style\n---\nUse tabs.\n',
    );
    const { r } = runners(workspace);
    // The sessions root is shared by every test in this file: this run's
    // trajectory is the one it adds.
    const before = new Set(trajectoryFiles());
    const code = (
      await r.eval(
        {
          task: 'fix it',
          suite: 'swe-bench-mini',
          model: 'faux/echo',
          worktree: workspace,
          size: 'smoke',
          json: true,
        },
        cliConfig(`skills = [${JSON.stringify(skill)}]\n`),
      )
    ).exitCode;
    expect(code).toBe(0);
    const [trajectory] = trajectoryFiles().filter((file) => !before.has(file));
    const exported = JSON.parse(readFileSync(trajectory ?? '', 'utf8')) as {
      resources: { skills: string[] };
    };
    expect(exported.resources.skills).toContain('house-style');
  });

  it('benchmark runs the matrix and exits 0 by verdict', {
    timeout: 120_000,
  }, async () => {
    const workspace = tempDir('kubic-eval-ws-');
    const { r, lines } = runners(workspace);
    const code = (
      await r.benchmark(
        {
          model: 'faux/echo',
          worktree: workspace,
          size: 'smoke',
          json: true,
        },
        cliConfig(),
      )
    ).exitCode;
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
        toolCalls?: number;
      }>;
    };
    expect(envelope.ok).toBe(true);
    const executed = envelope.results.filter((row) => !row.skipped);
    // Every built-in suite but the live-PTY stub executes.
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
      // Eval fields on every executed row.
      expect(row.model, row.suite).toBe('faux/echo');
      expect(row.worktree, row.suite).toBe(workspace);
      expect(row.toolCalls, row.suite).toBeGreaterThan(0);
    }
    expect(
      envelope.results.filter((row) => row.skipped).map((row) => row.suite),
    ).toEqual(['terminal-live']);
  });

  it('scores a --trajectory FILE through the prod reader', {
    timeout: 60_000,
  }, async () => {
    const workspace = tempDir('kubic-eval-ws-');
    const path = join(workspace, 'run.json');
    writeFileSync(
      path,
      JSON.stringify(
        buildTrajectoryExport({
          task: { taskId: 'task-1', objective: 'fix', role: 'writer' },
          identity: { sessionId: 'sess-1', agentId: 'agent-1' },
          model: {
            provider: 'faux',
            model: 'echo',
            thinking: null,
            escalations: [],
          },
          prompt: { text: 'fix' },
          resources: { skills: [] },
          actions: [],
          observations: [],
          state: { phase: 'done' },
          provenance: {
            sessionId: 'sess-1',
            agentId: 'agent-1',
            pid: null,
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
    const code = (
      await r.eval(
        {
          suite: 'swe-bench-mini',
          trajectory: path,
          worktree: workspace,
          size: 'smoke',
          json: true,
        },
        cliConfig(),
      )
    ).exitCode;
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
    const workspace = tempDir('kubic-eval-ws-');
    const { r, lines } = runners(workspace);
    const code = (
      await r.eval(
        {
          suite: 'swe-bench-mini',
          trajectory: join(workspace, 'missing.json'),
          worktree: workspace,
          size: 'smoke',
          json: true,
        },
        cliConfig(),
      )
    ).exitCode;
    expect(code).toBe(2);
    const envelope = JSON.parse(lines.join('\n')) as {
      ok: boolean;
      error: { code: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('trajectory-unreadable');
  });

  it('resolves the category alias (--suite swe)', {
    timeout: 60_000,
  }, async () => {
    const workspace = tempDir('kubic-eval-ws-');
    const { r, lines } = runners(workspace);
    const code = (
      await r.benchmark(
        {
          suite: 'swe',
          model: 'faux/echo',
          worktree: workspace,
          size: 'smoke',
          json: true,
        },
        cliConfig(),
      )
    ).exitCode;
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
    const code = (
      await r.benchmark(
        {
          suite: 'swe-bench-mini',
          model: 'faux/echo',
          worktree: repo,
          size: 'smoke',
          workspace: 'worktree',
          json: true,
        },
        cliConfig(),
      )
    ).exitCode;
    expect(code).toBe(0);
    // The throwaway checkout is gone: only the fixture's own worktree.
    const list = ensureDriver().git(['worktree', 'list', '--porcelain'], {
      cwd: repo,
    });
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
    const code = (
      await r.benchmark(
        {
          suite: 'swe-bench-mini',
          model: 'faux/echo',
          worktree: repo,
          size: 'smoke',
          workspace: 'worktree',
          json: true,
        },
        cliConfig(),
      )
    ).exitCode;
    expect(code).toBe(2);
    const envelope = JSON.parse(lines.join('\n')) as {
      ok: boolean;
      error: { code: string };
      results: unknown[];
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('dirty-worktree');
    // The refusal envelope carries the (empty) result set
    // rather than dropping the key.
    expect(envelope.results).toEqual([]);
    expect(errs).toEqual([]);
    expect(existsSync(join(repo, 'untracked.txt'))).toBe(true);
  });
});
