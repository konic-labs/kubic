import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXIT_OK } from '@kubic/core/cli/exit-codes';
import { FileJournalStore } from '@kubic/exec/journal';
import {
  createGitSandbox,
  disposeAllGitSandboxes,
} from '@kubic/exec/test-support/git-sandbox';
import {
  NO_PROJECT_TRUST,
  ProjectTrustStore,
  projectTrustStorePath,
} from '@kubic/host/config';
import { defaultSessionsRoot } from '@kubic/host/sessions';
import { buildTrajectoryExport } from '@kubic/trajectory/export';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliConfigResult } from './config/load.js';
import { loadCliConfig } from './config/load.js';
import { createProdRunners, prodTuiDeps } from './prod-runners.js';
import { tuiDepsWithDefaults } from './tui/deps.js';

const roots: string[] = [];

afterEach(() => {
  disposeAllGitSandboxes();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  // The default sessions root lives under the temp HOME: runs and
  // retention tests seed it, so sweep it too (nothing in this file
  // carries a session across tests).
  rmSync(defaultSessionsRoot(), { recursive: true, force: true });
});

const noConfig: CliConfigResult = {
  runtime: undefined,
  error: undefined,
  ignoreSplit: { missing: [], checked: [], applicable: false },
  trust: NO_PROJECT_TRUST,
};

// The prod runners colour from the real stdout; NO_COLOR pins plain text
// whatever terminal the test runner has.
function runners(): {
  lines: string[];
  errs: string[];
  r: ReturnType<typeof createProdRunners>;
} {
  vi.stubEnv('NO_COLOR', '1');
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

// run/tui config projections through createProdRunners: the
// `[journal] outOfScope` exclusion and the `[agent] name` attribution the
// deleted source-regex pins stood in for — observed in the journal the
// lane writes, not in the composition root's source text.
describe('kubic run projections (prod wiring)', () => {
  function trustedProjectConfig(toml: string): {
    config: CliConfigResult;
    project: string;
  } {
    const home = mkdtempSync(join(tmpdir(), 'prod-run-home-'));
    roots.push(home);
    const project = mkdtempSync(join(tmpdir(), 'prod-run-project-'));
    roots.push(project);
    mkdirSync(join(project, '.kubic'), { recursive: true });
    writeFileSync(join(project, '.kubic', 'config.toml'), toml);
    new ProjectTrustStore(projectTrustStorePath(home)).set(project, true);
    vi.stubEnv('KUBIC_TRUST_PROJECT', '1');
    const loaded = loadCliConfig({
      cwd: project,
      home,
      env: { ...process.env, KUBIC_TRUST_PROJECT: '1' },
    });
    expect(loaded.error).toBeUndefined();
    expect(loaded.runtime).toBeDefined();
    return { config: loaded, project };
  }

  function journalEntries(sessionId: string): Array<{
    path?: string;
    source?: string;
  }> {
    return new FileJournalStore(
      join(defaultSessionsRoot(), sessionId, 'journal'),
    ).entries() as Array<{ path?: string; source?: string }>;
  }

  // The `journal:<id>` ref the run envelope prints (no explicit --session
  // was passed, so the run created its own).
  function journalIdOf(lines: string[]): string {
    const match = lines.join('\n').match(/journal:([A-Za-z0-9_-]+)/);
    expect(match?.[1]).toBeDefined();
    return match?.[1] as string;
  }

  it('excludes a configured out-of-scope path from the run journal', async () => {
    const { config, project } = trustedProjectConfig(
      '[journal]\noutOfScope = ["vendor"]\n',
    );
    mkdirSync(join(project, 'vendor'), { recursive: true });
    vi.stubEnv('KUBIC_PROVIDER', 'faux');
    vi.stubEnv('KUBIC_NO_NOTICE', '1');
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    const { lines, r } = runners();
    const code = (
      await r.run(
        {
          prompt:
            'faux:tool bash {"command":"echo v2 > in-scope.txt && echo gen > vendor/out.js"}',
          json: true,
        },
        config,
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(existsSync(join(project, 'in-scope.txt'))).toBe(true);
    expect(existsSync(join(project, 'vendor', 'out.js'))).toBe(true);
    // Both files changed on disk; only the in-scope one was journaled.
    expect(
      journalEntries(journalIdOf(lines)).map((entry) => entry.path),
    ).toEqual(['in-scope.txt']);
  });

  it("journals the run's bash change as a sweep entry", async () => {
    const { config, project } = trustedProjectConfig(
      '[agent]\nname = "alice"\n',
    );
    vi.stubEnv('KUBIC_PROVIDER', 'faux');
    vi.stubEnv('KUBIC_NO_NOTICE', '1');
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    const { lines, r } = runners();
    const code = (
      await r.run(
        {
          prompt: 'faux:tool bash {"command":"touch marker"}',
          json: true,
        },
        config,
      )
    ).exitCode;
    expect(code).toBe(0);
    const entries = journalEntries(journalIdOf(lines));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.source).toBe('sweep');
  });
});

// The tui wiring through createProdRunners: the lane projection the
// interactive boot consumes names the configured agent (the run side is
// behavioural above; the interactive lane itself boots only on a TTY).
describe('kubic tui (prod wiring)', () => {
  it('threads the configured agent id to the interactive lane deps', async () => {
    const home = mkdtempSync(join(tmpdir(), 'prod-tui-home-'));
    roots.push(home);
    const project = mkdtempSync(join(tmpdir(), 'prod-tui-project-'));
    roots.push(project);
    mkdirSync(join(project, '.kubic'), { recursive: true });
    writeFileSync(
      join(project, '.kubic', 'config.toml'),
      '[agent]\nname = "alice"\n',
    );
    new ProjectTrustStore(projectTrustStorePath(home)).set(project, true);
    const loaded = loadCliConfig({ cwd: project, home, env: {} });
    expect(loaded.error).toBeUndefined();
    expect(
      prodTuiDeps({ out: () => undefined, debug: () => undefined }, loaded)
        .agentId,
    ).toBe('alice');
  });

  // The first screen's version and trust row reach the run deps
  // through the real builders (a field the defaults drop stays green
  // otherwise).
  it('threads the version and the project trust to the first screen', () => {
    const home = mkdtempSync(join(tmpdir(), 'prod-tui-home-'));
    roots.push(home);
    const project = mkdtempSync(join(tmpdir(), 'prod-tui-project-'));
    roots.push(project);
    mkdirSync(join(project, '.kubic'), { recursive: true });
    writeFileSync(join(project, '.kubic', 'config.toml'), '[journal]\n');
    new ProjectTrustStore(projectTrustStorePath(home)).set(project, true);
    const loaded = loadCliConfig({ cwd: project, home, env: {} });
    const deps = tuiDepsWithDefaults(
      prodTuiDeps(
        {
          out: () => undefined,
          debug: () => undefined,
          version: () => '1.2.3',
        },
        loaded,
      ),
    );
    expect(deps.version).toBe('1.2.3');
    expect(deps.projectTrust).toBe('loaded');
    const bare = mkdtempSync(join(tmpdir(), 'prod-tui-bare-'));
    roots.push(bare);
    const none = tuiDepsWithDefaults(
      prodTuiDeps(
        { out: () => undefined, debug: () => undefined },
        loadCliConfig({ cwd: bare, home, env: {} }),
      ),
    );
    expect('projectTrust' in none).toBe(false);
    expect('version' in none).toBe(false);
  });
});

// One positive smoke per remaining runner key through createProdRunners
// (acceptance "every key invoked"): each asserts an
// observable effect of the composed deps, never the composition source.
describe('remaining runners (prod wiring smokes)', () => {
  it('git status names the branch of the working repo', async () => {
    const sandbox = createGitSandbox({ injectProcessEnv: true });
    writeFileSync(join(sandbox.path, 'base.txt'), 'base\n');
    sandbox.git(['add', '-A']);
    sandbox.git(['commit', '-qm', 'base']);
    vi.spyOn(process, 'cwd').mockReturnValue(sandbox.path);
    const { lines, r } = runners();
    expect((await r.git({ command: 'status' }, noConfig)).exitCode).toBe(0);
    expect(lines.join('\n')).toContain('branch main');
  });

  it('skills lists nothing discovered over an empty tree', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'prod-skills-'));
    roots.push(bare);
    vi.spyOn(process, 'cwd').mockReturnValue(bare);
    // The empty-discovery note is diagnostics (log.info), not stdout.
    const { lines, errs, r } = runners();
    expect((await r.skills({}, noConfig)).exitCode).toBe(0);
    expect([...lines, ...errs].join('\n')).toContain('no skills discovered');
  });

  it('config prints the effective configuration as one JSON document', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'prod-config-'));
    roots.push(empty);
    const loaded = loadCliConfig({ cwd: empty, home: empty, env: {} });
    expect(loaded.error).toBeUndefined();
    const { lines, r } = runners();
    expect((await r.config({ json: true }, loaded)).exitCode).toBe(0);
    const parsed = JSON.parse(lines.join('\n')) as { layers?: unknown };
    expect(parsed).toHaveProperty('layers');
  });

  it('trust --list reports an empty store by name', async () => {
    const home = mkdtempSync(join(tmpdir(), 'prod-trust-home-'));
    roots.push(home);
    const { lines, r } = runners();
    expect(
      (
        await r.trust(
          { list: true },
          { ...noConfig, trust: { ...NO_PROJECT_TRUST, home } },
        )
      ).exitCode,
    ).toBe(0);
    expect(lines.join('\n')).toContain('no project trust decisions recorded');
  });

  it('cost reports no rows for a workspace with no usage', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'prod-cost-'));
    roots.push(ws);
    vi.spyOn(process, 'cwd').mockReturnValue(ws);
    const { lines, r } = runners();
    expect((await r.cost({}, noConfig)).exitCode).toBe(EXIT_OK);
    expect(lines.join('\n')).toContain('no cost rows');
  });
});

// The replay third of the lane projection: a deterministic
// re-execution runs the recorded objective through the lane under the
// config's projections — the journal it writes carries the configured
// agent id, exactly as `kubic run` attributes its own.
describe('kubic replay lane projection (prod wiring)', () => {
  it("journals the re-executed lane's bash change as a sweep entry", async () => {
    const { config, project } = (() => {
      const home = mkdtempSync(join(tmpdir(), 'prod-replay-home-'));
      roots.push(home);
      const plan = mkdtempSync(join(tmpdir(), 'prod-replay-project-'));
      roots.push(plan);
      mkdirSync(join(plan, '.kubic'), { recursive: true });
      writeFileSync(
        join(plan, '.kubic', 'config.toml'),
        '[agent]\nname = "alice"\n',
      );
      new ProjectTrustStore(projectTrustStorePath(home)).set(plan, true);
      mkdirSync(join(plan, '.kubic', 'roles'), { recursive: true });
      writeFileSync(
        join(plan, '.kubic', 'roles', 'writer.md'),
        '---\nrole: writer\ntools: [read, bash]\nfilesystem: workspace-write\nshell: true\nnetwork: none\ngit: false\ncredentials: none\n---\n\n# writer\n\n## Prompt\n\nWrite.\n',
      );
      const loaded = loadCliConfig({
        cwd: plan,
        home,
        env: { ...process.env, KUBIC_TRUST_PROJECT: '1' },
      });
      expect(loaded.error).toBeUndefined();
      return { config: loaded, project: plan };
    })();
    const dir = mkdtempSync(join(tmpdir(), 'prod-replay-traj-'));
    roots.push(dir);
    const trajectory = join(dir, 't.json');
    writeFileSync(
      trajectory,
      JSON.stringify(
        buildTrajectoryExport({
          task: {
            taskId: 'task-1',
            objective: 'faux:tool bash {"command":"touch replay-marker"}',
            role: 'writer',
          },
          identity: {
            sessionId: 'sess-1',
            agentId: 'agent-1',
          },
          model: {
            provider: 'faux',
            model: 'echo',
            thinking: null,
            escalations: [],
          },
          prompt: { text: 'touch the marker' },
          resources: { skills: [] },
          actions: [],
          observations: [],
          state: { phase: 'done' },
          provenance: {
            sessionId: 'sess-1',
            agentId: 'agent-1',
            pid: null,
            worktree: '/repo',
            model: 'faux/echo',
          },
          environment: {
            capturedFrom: 'used',
            cwd: '/repo',
            env: {},
          },
          worktree: {
            path: '/repo',
            baseRevision: 'abc123',
            branch: null,
          },
          diff: { filesChanged: [], files: [] },
          approvals: [],
          timestamps: {
            startedAt: '2026-09-23T10:00:00.000Z',
            endedAt: '2026-09-23T10:01:00.000Z',
          },
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cachedTokens: 0,
            requests: 1,
            costUsd: 0,
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
    const lockfile = join(dir, 'pins.json');
    writeFileSync(lockfile, JSON.stringify({ models: { faux: ['echo'] } }));
    vi.stubEnv('KUBIC_PROVIDER', 'faux');
    vi.stubEnv('KUBIC_NO_NOTICE', '1');
    vi.stubEnv('KUBIC_TRUST_PROJECT', '1');
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    const { lines, errs, r } = runners();
    const code = (
      await r.replay(
        { trajectory, tier: 'deterministic', model: 'faux/echo', lockfile },
        config,
      )
    ).exitCode;
    expect(code, [...lines, ...errs].join('\n')).toBe(0);
    expect(existsSync(join(project, 'replay-marker'))).toBe(true);
    // The marker is a bash write, which the end-of-run sweep journals — scan
    // the default sessions root for it (the replay mints its own session, so
    // the id is discovered, not assumed).
    const { readdirSync } = await import('node:fs');
    const found: Array<{ path?: string; source?: string }> = [];
    for (const id of readdirSync(defaultSessionsRoot())) {
      const journalDir = join(defaultSessionsRoot(), id, 'journal');
      if (!existsSync(join(journalDir, 'index.jsonl'))) continue;
      for (const entry of new FileJournalStore(journalDir).entries() as Array<{
        path?: string;
        source?: string;
      }>) {
        if (entry.path === 'replay-marker') found.push(entry);
      }
    }
    expect(found.length).toBeGreaterThan(0);
    for (const entry of found) expect(entry.source).toBe('sweep');
  });
});
