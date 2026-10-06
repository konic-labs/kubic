// Manager-side worker spans on the prod orchestrate path (issue #290): one
// kubic.worker.start span per launch with a nested kubic.worker.startup span
// whose duration equals the registry startupMs, written to
// <root>/.kubic/orchestrator/<session>.spans.jsonl. Real git, a real child
// process, no provider.

import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGitSandbox,
  disposeAllGitSandboxes,
  type GitSandbox,
} from '../../../packages/exec/src/test-support/git-sandbox.js';
import { runOrchestrateCommand } from '../../../packages/host/src/orchestrate-cli.js';
import { WorkerRegistry } from '../../../packages/worker/src/lifecycle/registry.js';
import { orchestrateDepsWithDefaults } from './orchestrate-run.js';

// The child contract as a real process: announce readiness, report the §68
// result shape, write one file so the branch has a hunk to merge, exit 0.
const FIXTURE = `
import { writeFileSync } from 'node:fs';
const id = process.env.KUBIC_WORKER_ID ?? 'worker';
process.stdout.write('KUBIC_WORKER_READY ' + id + '\\n');
writeFileSync(id + '.txt', 'work by ' + id + '\\n');
const a = process.argv;
process.stdout.write(JSON.stringify({ ok: true, exitCode: 0, sessionId: a[a.indexOf('--session') + 1], status: 'completed', result: { summary: 'fixture done' } }) + String.fromCharCode(10));
process.exit(0);
`;

const scratchDirs: string[] = [];

function scratch(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratchDirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  vi.stubEnv('KUBIC_PROVIDER', '');
  vi.stubEnv('KUBIC_MODEL', undefined);
});

afterEach(() => {
  driver = undefined;
  disposeAllGitSandboxes();
  vi.unstubAllEnvs();
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The test's git driver (issue #420): one injected sandbox per test, so
// the setup spawns and the production git the run shells share the
// scrubbed view. Repos keep their own scratch dirs; only the env is shared.
let driver: GitSandbox | undefined;

function git(cwd: string, args: string[]): string {
  driver ??= createGitSandbox({ injectProcessEnv: true });
  return driver.git(args, { cwd });
}

function initRepo(): string {
  const repo = scratch('kubic-spans-');
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'spans@kubic.dev']);
  git(repo, ['config', 'user.name', 'kubic spans']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, ['add', 'base.txt']);
  git(repo, ['commit', '-m', 'base']);
  return repo;
}

function fixtureEntry(): { cmd: string; args: string[] } {
  const dir = scratch('kubic-spans-child-');
  const fixture = join(dir, 'worker-child.mjs');
  writeFileSync(fixture, FIXTURE);
  return { cmd: process.execPath, args: [fixture] };
}

describe('manager-side worker spans (issue #290)', () => {
  it('writes one startup span per worker with the registry startupMs', async () => {
    const repo = initRepo();
    const lines: string[] = [];
    const deps = await orchestrateDepsWithDefaults({
      out: (line) => lines.push(line),
      err: () => undefined,
      debug: () => undefined,
      cwd: repo,
      sessionsRoot: scratch('kubic-spans-sessions-'),
      registry: new WorkerRegistry(),
      workerEntry: fixtureEntry(),
      signals: { install: () => () => undefined, reraise: () => undefined },
    });
    const code = await runOrchestrateCommand(
      {
        prompt: 'go',
        agents: ['worker-1'],
        yes: true,
        json: true,
        session: 'spans',
      },
      deps,
    );
    expect(code).toBe(0);
    const startupMs = deps.launches?.perf()[0]?.sample.startupMs;
    expect(typeof startupMs).toBe('number');
    const raw = readFileSync(
      join(repo, '.kubic', 'orchestrator', 'spans.spans.jsonl'),
      'utf8',
    );
    const spans = raw
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            id: string;
            name: string;
            sessionId: string;
            parentId: string | null;
            startMs: number;
            endMs: number;
          },
      );
    expect(spans.map((span) => span.name).sort()).toEqual([
      'kubic.worker.start',
      'kubic.worker.startup',
    ]);
    const startup = spans.find((span) => span.name === 'kubic.worker.startup');
    const start = spans.find((span) => span.name === 'kubic.worker.start');
    // The startup duration IS the registry's number (pinned by endAt).
    expect(startup?.endMs).not.toBeNull();
    expect((startup?.endMs ?? 0) - (startup?.startMs ?? 0)).toBe(startupMs);
    expect(startup?.parentId).toBe(start?.id);
    // Manager and worker traces join on the worker session id.
    expect(start?.sessionId).toBe('spans-worker-1');
    expect(startup?.sessionId).toBe('spans-worker-1');
  }, 30_000);

  it('routes worker span lines to the run debug channel (issue #246)', async () => {
    const repo = initRepo();
    const lines: string[] = [];
    const debugLines: string[] = [];
    const deps = await orchestrateDepsWithDefaults({
      out: (line) => lines.push(line),
      err: () => undefined,
      debug: (line) => debugLines.push(line),
      cwd: repo,
      sessionsRoot: scratch('kubic-spans-sessions-'),
      registry: new WorkerRegistry(),
      workerEntry: fixtureEntry(),
      signals: { install: () => () => undefined, reraise: () => undefined },
    });
    const code = await runOrchestrateCommand(
      {
        prompt: 'go',
        agents: ['worker-1'],
        yes: true,
        json: true,
        session: 'spans-debug',
      },
      deps,
    );
    expect(code).toBe(0);
    // The manager's worker.start span opens and closes on the debug
    // channel, so `kubic orchestrate --debug` names each worker.
    expect(
      debugLines.some((line) =>
        line.includes('[agent] worker start session=spans-debug-worker-1'),
      ),
    ).toBe(true);
    expect(
      debugLines.some((line) => line.includes('[agent] worker end ms=')),
    ).toBe(true);
  }, 30_000);
});
