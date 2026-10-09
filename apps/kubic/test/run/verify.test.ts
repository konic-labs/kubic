// Gate signals have a producer on the live path: the
// configured `[verify]` commands run in the run's worktree after it settles,
// a baseline run at the base revision detects regressions, and the labels
// land in the trajectory — so the reference verifier and the
// preference builder work on run-produced files without hand-set labels.
// Faux provider only (scripted replies, a real bash tool call); a fixture
// git repo in a temp dir; zero network.

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from '@kubic/agent/pi-boundary';
import { fauxToolUse } from '@kubic/agent/test-support/lane-harness';
import { buildPreferencePair } from '@kubic/eval/rl/preference';
import { referenceVerifier } from '@kubic/eval/rl/verifier';
import { computeSignals } from '@kubic/eval/signals';
import { NodeExecutionEnv } from '@kubic/exec/env';
import {
  createGitSandbox,
  disposeAllGitSandboxes,
  type GitSandbox,
} from '@kubic/exec/test-support/git-sandbox';
import { loadRuntimeConfig, NO_PROJECT_TRUST } from '@kubic/host/config';
import {
  parseTrajectoryExportJSON,
  type TrajectoryExport,
} from '@kubic/trajectory/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeRunDeps } from '../../src/config/projections.js';
import { runHeadlessPrompt } from '../../src/run/command.js';
import type { HeadlessRunDeps } from '../../src/run/options.js';

const made: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  driver = undefined;
  disposeAllGitSandboxes();
  vi.unstubAllEnvs();
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The test's git driver: one injected sandbox per test, so
// the fixture setup and the baseline worktree git the verify path shells
// share the scrubbed view. The fixture keeps its own tmp dir.
let driver: GitSandbox | undefined;

function ensureDriver(): GitSandbox {
  driver ??= createGitSandbox({ injectProcessEnv: true });
  return driver;
}

// A one-commit repo whose "test suite" passes while ok.txt exists.
function fixtureRepo(): string {
  const dir = tmp('verify-repo-');
  const git = (args: string[]) => ensureDriver().git(args, { cwd: dir });
  git(['init', '-q']);
  git(['config', 'user.email', 'verify@example.com']);
  git(['config', 'user.name', 'verify']);
  writeFileSync(join(dir, 'ok.txt'), 'green\n');
  git(['add', 'ok.txt']);
  git([
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

const VERIFY = { commands: { tests: 'test -f ok.txt' }, timeoutMs: 30_000 };

// The same prompt either answers without touching the tree, or deletes the
// file the test gate needs (a real bash tool call through the lane).
function models(breakTheTree: boolean): MutableModels {
  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'small', contextWindow: 120000 }],
  });
  const registry = createModels();
  registry.setProvider(faux.provider);
  faux.setResponses(
    breakTheTree
      ? [
          fauxToolUse([fauxToolCall('bash', { command: 'rm ok.txt' })]),
          fauxAssistantMessage('removed the file'),
        ]
      : [fauxAssistantMessage('nothing to change')],
  );
  return registry;
}

async function run(
  repo: string,
  breakTheTree: boolean,
  // null: no [verify] configured at all.
  verify: typeof VERIFY | null = VERIFY,
  extra: Partial<HeadlessRunDeps> = {},
): Promise<TrajectoryExport> {
  const result = await runHeadlessPrompt(
    'fix the widget',
    {},
    {
      sessionsRoot: tmp('verify-sessions-'),
      models: models(breakTheTree),
      env: new NodeExecutionEnv(repo),
      ...(verify === null ? {} : { verify }),
      ...extra,
    },
  );
  expect(result.terminus).toBe('completed');
  return parseTrajectoryExportJSON(
    readFileSync(result.trajectoryRef as string, 'utf8'),
  );
}

describe('the run verifier writes gate signals', () => {
  it('a passing test command yields signal:tests=pass and no regression', {
    timeout: 30_000,
  }, async () => {
    const exported = await run(fixtureRepo(), false);
    expect(exported.eval.labels).toEqual({
      'signal:tests': 'pass',
      'signal:regression': 'pass',
    });
    const signals = computeSignals(exported);
    expect(signals.tests).toBe('pass');
    expect(signals.regressionFree).toBe(true);
    expect(signals.quality).toBe(1);
  });

  it('a failing test command yields signal:tests=fail; passing at base makes it a regression', {
    timeout: 30_000,
  }, async () => {
    const repo = fixtureRepo();
    const exported = await run(repo, true);
    expect(existsSync(join(repo, 'ok.txt'))).toBe(false);
    expect(exported.eval.labels).toEqual({
      'signal:tests': 'fail',
      'signal:regression': 'fail',
    });
    const signals = computeSignals(exported);
    expect(signals.tests).toBe('fail');
    expect(signals.regressionFree).toBe(false);
    // The baseline checkout is gone: only the fixture's own worktree left.
    const list = ensureDriver().git(['worktree', 'list', '--porcelain'], {
      cwd: repo,
    });
    expect(
      list.split('\n').filter((line) => line.startsWith('worktree ')),
    ).toHaveLength(1);
  });

  it('referenceVerifier and buildPreferencePair work on run-produced trajectories', {
    timeout: 60_000,
  }, async () => {
    const repo = fixtureRepo();
    const passing = await run(repo, false);
    const failing = await run(repo, true);
    expect(referenceVerifier(passing).verdict).toBe('pass');
    expect(referenceVerifier(failing).verdict).toBe('fail');
    const built = buildPreferencePair(passing, failing);
    expect(built.excluded).toBeNull();
    expect(built.pair?.boundary).toBe('within');
    expect(built.pair?.chosen.completion).toBe('nothing to change');
    expect(built.pair?.rejected.completion).toBe('removed the file');
  });

  it('with no commands configured every gate stays unknown, and nothing is verified', {
    timeout: 30_000,
  }, async () => {
    const warnings: string[] = [];
    const exported = await run(fixtureRepo(), true, null, {
      warn: (line) => warnings.push(line),
    });
    expect(exported.eval.labels).toEqual({});
    const signals = computeSignals(exported);
    expect([
      signals.tests,
      signals.build,
      signals.lint,
      signals.typecheck,
    ]).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
    expect(warnings).toEqual([]);
  });

  it('bounds each gate at the configured timeoutMs and records the failure', {
    timeout: 30_000,
  }, async () => {
    const repo = fixtureRepo();
    const exported = await run(repo, false, {
      commands: { tests: 'sleep 1' },
      timeoutMs: 100,
    });
    // Both the run and the baseline gate are killed at 100ms. Without the
    // configured bound `sleep 1` would exit 0 and both gates would pass, so
    // the failed gate is the proof — no wall-clock bound to flake under load.
    expect(exported.eval.labels).toEqual({
      'signal:tests': 'fail',
      'signal:regression': 'pass',
    });
  });

  it('a verifier failure is reported on the warning channel and never changes the run', {
    timeout: 30_000,
  }, async () => {
    const stderr: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => {
        stderr.push(String(chunk));
        return true;
      });
    let result: Awaited<ReturnType<typeof runHeadlessPrompt>>;
    try {
      result = await runHeadlessPrompt(
        'fix the widget',
        {},
        {
          sessionsRoot: tmp('verify-sessions-'),
          models: models(false),
          env: new NodeExecutionEnv(fixtureRepo()),
          // Reading `commands` throws: the verifier itself is broken.
          verify: {
            get commands(): Record<string, string> {
              throw new Error('verifier exploded');
            },
          },
        },
      );
    } finally {
      spy.mockRestore();
    }
    expect(result.terminus).toBe('completed');
    const exported = parseTrajectoryExportJSON(
      readFileSync(result.trajectoryRef as string, 'utf8'),
    );
    expect(exported.eval.labels).toEqual({});
    expect(stderr.join('')).toContain('verify: gates not recorded for session');
    expect(stderr.join('')).toContain('verifier exploded');
    expect(stderr.join('')).toMatch(/\n$/);
  });

  it('outside a git checkout the gates are verified but no regression is claimed', {
    timeout: 30_000,
  }, async () => {
    const dir = tmp('verify-plain-');
    writeFileSync(join(dir, 'ok.txt'), 'green\n');
    const exported = await run(dir, false);
    expect(exported.eval.labels).toEqual({ 'signal:tests': 'pass' });
    expect(exported.worktree.baseRevision).toBe('no-vcs');
  });
});

describe('[verify] config reaches the run', () => {
  it('projects the configured commands and timeout into the run deps', () => {
    const cwd = tmp('verify-config-');
    const configPath = `${cwd}/.kubic/config.toml`;
    const runtime = loadRuntimeConfig({
      bridge: {
        exists: (path: string): boolean => path === configPath,
        readTextFile: (): string =>
          '[verify]\ntests = "npm test"\ntypecheck = "npm run typecheck"\ntimeoutMs = 120000\n',
      },
      home: '/nonexistent-home',
      cwd,
      enterprisePath: '/nonexistent/config.toml',
      projectTrusted: true,
      env: {},
    });
    expect(runtime.verify).toEqual({
      commands: { tests: 'npm test', typecheck: 'npm run typecheck' },
      timeoutMs: 120000,
    });
    const deps = runtimeRunDeps({
      runtime,
      error: undefined,
      ignoreSplit: { missing: [], checked: [], applicable: false },
      trust: NO_PROJECT_TRUST,
    });
    expect(deps.verify).toEqual({
      commands: { tests: 'npm test', typecheck: 'npm run typecheck' },
      timeoutMs: 120000,
    });
  });

  it('no [verify] section projects nothing', () => {
    const runtime = loadRuntimeConfig({
      bridge: { exists: () => false, readTextFile: () => '' },
      home: '/nonexistent-home',
      cwd: tmp('verify-config-'),
      enterprisePath: '/nonexistent/config.toml',
      env: {},
    });
    expect(runtime.verify).toEqual({ commands: {} });
    const deps = runtimeRunDeps({
      runtime,
      error: undefined,
      ignoreSplit: { missing: [], checked: [], applicable: false },
      trust: NO_PROJECT_TRUST,
    });
    expect(deps.verify).toBeUndefined();
  });
});
