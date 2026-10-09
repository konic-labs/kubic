// The enterprise policy and the model-pin semantics on the PRODUCTION
// runners. Every case builds its deps through
// `createProdRunners` / `prodRunDeps` — the functions the binary calls — over
// a real `loadRuntimeConfig`, never a hand-spread dep: a test that spreads the
// deps itself cannot notice when the production spread is dropped.
//
// Faux provider only (`KUBIC_PROVIDER=faux` or injected faux catalogs): zero
// network, zero paid tokens. Temp workspace, `process.cwd()` mocked, temp HOME
// from the hermetic vitest env.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { disposeAllGitSandboxes } from '@kubic/exec/test-support/git-sandbox';
import { NO_PROJECT_TRUST } from '@kubic/host/config';
import { buildTrajectoryExport } from '@kubic/trajectory/export';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import type { CliConfigResult } from '../../src/config/load.js';
import { createProdRunners } from '../../src/prod-runners.js';
import { cliConfig, ENTERPRISE } from '../fixtures/cli-config.js';

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  vi.stubEnv('NO_COLOR', '1');
});

afterEach(() => {
  disposeAllGitSandboxes();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const PROJECT = '/nonexistent-cwd/.kubic/config.toml';

// The tests below load workspace role documents, so they run
// under the trusted report — the `KUBIC_TRUST_PROJECT=1` equivalent. Trust
// behavior itself stays pinned by the trust-store and skills suites.
const TRUSTED = {
  ...NO_PROJECT_TRUST,
  envTrust: true,
  trusted: true,
} as CliConfigResult['trust'];

// The prod runners over a temp workspace: cwd is the workspace, stdout and the
// diagnostics channel are captured, and the faux notice the run path writes to
// the real stderr is swallowed.
function runners(workspace: string) {
  vi.spyOn(process, 'cwd').mockReturnValue(workspace);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
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

describe('`kubic replay --tier live` re-executes under the enterprise policy', () => {
  function replayFixture(objective = 'say hi'): {
    trajectory: string;
    lockfile: string;
  } {
    const dir = tempDir('kubic-replay-policy-');
    const trajectory = join(dir, 't.json');
    writeFileSync(
      trajectory,
      JSON.stringify(
        buildTrajectoryExport({
          task: { taskId: 'task-1', objective, role: 'writer' },
          identity: { sessionId: 'sess-1', agentId: 'agent-1' },
          model: {
            provider: 'faux',
            model: 'echo',
            thinking: null,
            escalations: [],
          },
          prompt: { text: 'say hi' },
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
    return { trajectory, lockfile };
  }

  beforeEach(() => {
    vi.stubEnv('KUBIC_PROVIDER', 'faux');
  });

  it('refuses a re-execution model the enterprise policy disallows (exit 6, named refusal)', async () => {
    const { trajectory, lockfile } = replayFixture();
    const { r, lines, errs } = runners(tempDir());
    const code = (
      await r.replay(
        {
          trajectory,
          tier: 'deterministic',
          model: 'faux/echo',
          lockfile,
          json: true,
        },
        cliConfig({
          [ENTERPRISE]: '[policy]\nallowed_models = ["corp/approved"]\n',
        }),
      )
    ).exitCode;
    const text = [...lines, ...errs].join('\n');
    expect(text).toContain(
      "model 'faux/echo' refused by enterprise policy (allowed_models/allowed_providers): no provider call was made",
    );
    expect(code).toBe(6);
  });

  it('gates the live tier too: the recorded model is refused when the policy disallows it', async () => {
    const { trajectory } = replayFixture();
    const roleConfig = join(tempDir('kubic-replay-role-'), 'role.json');
    writeFileSync(roleConfig, '{"role":"writer"}\n');
    // The role config names the role; the document it pins
    // must exist in the re-execution's worktree (the mocked workspace).
    const workspace = tempDir();
    mkdirSync(join(workspace, '.kubic', 'roles'), { recursive: true });
    writeFileSync(
      join(workspace, '.kubic', 'roles', 'writer.md'),
      '---\nrole: writer\ntools: [read]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n---\n\n# writer\n\n## Prompt\n\nWrite.\n',
    );
    const { r, lines, errs } = runners(workspace);
    const code = (
      await r.replay(
        { trajectory, tier: 'live', roleConfig, json: true },
        cliConfig(
          {
            [ENTERPRISE]: '[policy]\nallowed_models = ["corp/approved"]\n',
          },
          { trust: TRUSTED },
        ),
      )
    ).exitCode;
    expect([...lines, ...errs].join('\n')).toContain(
      "model 'faux/echo' refused by enterprise policy (allowed_models/allowed_providers): no provider call was made",
    );
    expect(code).toBe(6);
  });

  it('applies the pinned role: a tool outside its allowlist is not registered', async () => {
    // The re-execution prompt asks for bash. Under a role whose tools are
    // [read] the bash tool is never registered, so the marker cannot be
    // created; under a role that allows bash it is. That is the difference
    // the pin must make — checked-then-ignored role configs produced the
    // same run either way.
    const objective = 'faux:tool bash {"command":"touch marker"}';
    const { trajectory } = replayFixture(objective);
    const marker = (workspace: string): string => join(workspace, 'marker');
    const roleDoc = (tools: string, shell: boolean): string =>
      `---\nrole: reader\ntools: [${tools}]\nfilesystem: workspace-write\nshell: ${String(shell)}\nnetwork: none\ngit: false\ncredentials: none\n---\n\n# reader\n\n## Prompt\n\nRead.\n`;

    for (const [tools, shell, expected] of [
      ['read', false, false],
      ['read, bash', true, true],
    ] as const) {
      const workspace = tempDir('kubic-replay-role-tools-');
      mkdirSync(join(workspace, '.kubic', 'roles'), { recursive: true });
      writeFileSync(
        join(workspace, '.kubic', 'roles', 'reader.md'),
        roleDoc(tools, shell),
      );
      const roleConfig = join(tempDir('kubic-replay-role-pin-'), 'role.json');
      writeFileSync(roleConfig, '{"role":"reader"}');
      const { r } = runners(workspace);
      await r.replay(
        { trajectory, tier: 'live', roleConfig, json: true },
        cliConfig({}, { trust: TRUSTED }),
      );
      expect(
        existsSync(marker(workspace)),
        `tools=[${tools}] must ${expected ? '' : 'not '}register bash`,
      ).toBe(expected);
    }
  });

  it('runs the re-execution in the pinned worktree', async () => {
    // The lane's cwd is the pin: a bash write lands in the worktree the
    // request names, not in the process working directory. The role
    // document is loaded from that same tree.
    const { trajectory } = replayFixture(
      'faux:tool bash {"command":"touch marker"}',
    );
    const workspace = tempDir('kubic-replay-cwd-');
    const worktree = tempDir('kubic-replay-wt-');
    mkdirSync(join(worktree, '.kubic', 'roles'), { recursive: true });
    writeFileSync(
      join(worktree, '.kubic', 'roles', 'reader.md'),
      '---\nrole: reader\ntools: [read, bash]\nfilesystem: workspace-write\nshell: true\nnetwork: none\ngit: false\ncredentials: none\n---\n\n# reader\n\n## Prompt\n\nRead.\n',
    );
    const roleConfig = join(tempDir('kubic-replay-role-pin-'), 'role.json');
    writeFileSync(roleConfig, '{"role":"reader"}');
    const { r } = runners(workspace);
    await r.replay(
      { trajectory, tier: 'live', roleConfig, worktree, json: true },
      cliConfig({}, { trust: TRUSTED }),
    );
    expect(existsSync(join(worktree, 'marker'))).toBe(true);
    expect(existsSync(join(workspace, 'marker'))).toBe(false);
  });

  it('re-executes a model the policy allows (control)', async () => {
    const { trajectory, lockfile } = replayFixture();
    const { r, lines } = runners(tempDir());
    const code = (
      await r.replay(
        {
          trajectory,
          tier: 'deterministic',
          model: 'faux/echo',
          lockfile,
          json: true,
        },
        cliConfig({ [ENTERPRISE]: '[policy]\nallowed_models = ["faux/*"]\n' }),
      )
    ).exitCode;
    expect(lines.join('\n')).toContain('faux echo: say hi');
    expect(code).toBe(0);
  });
});

describe('`kubic tui` through the prod runner enforces the enterprise model gate', () => {
  it('refuses a model outside allowed_models with the named refusal, before any terminal opens (exit 6)', async () => {
    // The gate must apply on the interactive runner: the policy reaches the boot.
    // `r.tui` builds its deps with
    // prodTuiDeps and boots the real lane; a refusal here happens before the
    // alt-screen (no terminal is created in this test).
    vi.stubEnv('KUBIC_PROVIDER', 'faux');
    const { r, errs } = runners(tempDir());
    const code = (
      await r.tui(
        {},
        cliConfig({
          [ENTERPRISE]: '[policy]\nallowed_models = ["corp/approved"]\n',
        }),
      )
    ).exitCode;
    expect(code).toBe(6);
    expect(errs.join('\n')).toContain(
      "model 'faux/echo' refused by enterprise policy (allowed_models/allowed_providers): no provider call was made",
    );
  });
});

// Enterprise tool policy on role documents: a role declaring a denied tool is
// refused by `kubic run --role`, so doctor must not show it green — through
// the production runners.
describe('role documents under the enterprise tool policy on the doctor runner', () => {
  const DENY_BASH = '[policy]\ndenied_tools = ["bash"]\n';

  function workspaceWithRoles(): string {
    const workspace = tempDir();
    mkdirSync(join(workspace, '.kubic', 'roles'), { recursive: true });
    writeFileSync(
      join(workspace, '.kubic', 'roles', 'planner.md'),
      '---\nrole: planner\ntools: [read, ls, find, grep]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n---\n\n# planner\n\n## Prompt\n\nPlan it.\n',
    );
    writeFileSync(
      join(workspace, '.kubic', 'roles', 'implementer.md'),
      '---\nrole: implementer\ntools: [read, ls, find, grep, write, edit, bash]\nfilesystem: workspace-write\nshell: true\nnetwork: none\ngit: false\ncredentials: none\n---\n\n# implementer\n\n## Prompt\n\nBuild it.\n',
    );
    return workspace;
  }

  it('kubic doctor shows a role declaring a denied tool red, and the innocuous one green', async () => {
    const workspace = workspaceWithRoles();
    const { r, lines } = runners(workspace);
    const code = (
      await r.doctor(
        { json: true },
        cliConfig({ [ENTERPRISE]: DENY_BASH }, { trust: TRUSTED }),
      )
    ).exitCode;
    const report = JSON.parse(lines.join('\n')) as {
      checks: { id: string; status: string; detail: string }[];
    };
    const roles = report.checks.filter((c) => /(^|:)role:/.test(c.id));
    // Every role declaring `bash` is refused by name — the workspace's implementer
    // override and the four embedded presets that run a shell.
    // The built-in planner declares no bash, so it stays green.
    const failed = roles
      .filter((c) => c.status === 'fail')
      .map((c) => c.id.replace(/^.*role:/, 'role:'));
    expect(failed).toEqual([
      'role:debugger',
      'role:implementer',
      'role:reviewer',
      'role:tester',
    ]);
    expect(
      roles.find((c) => c.id.endsWith('role:implementer'))?.detail,
    ).toMatch(/role 'implementer'.*'bash' denied.*enterprise denial holds/);
    expect(roles.find((c) => c.id.endsWith('role:planner'))?.status).toBe(
      'pass',
    );
    expect(code).not.toBe(0);
  });

  it('kubic doctor keeps the same role tree green without a tool policy (control)', async () => {
    const { r, lines } = runners(workspaceWithRoles());
    await r.doctor({ json: true }, cliConfig({}));
    const report = JSON.parse(lines.join('\n')) as {
      checks: { id: string; status: string }[];
    };
    expect(
      report.checks.filter((c) => /role:/.test(c.id) && c.status === 'fail'),
    ).toEqual([]);
  });

  // The config `[roles.<name>]` layers narrow a role exactly as `kubic run
  // --role` applies them, so doctor judges the role AFTER them.
  const NARROWED = {
    [ENTERPRISE]: DENY_BASH,
    [PROJECT]: '[roles.implementer]\ntools = ["read"]\n',
  };

  it('kubic doctor judges a role after the config [roles.<name>] layers (a layer narrowing the denied tool away is green)', async () => {
    const { r, lines } = runners(workspaceWithRoles());
    await r.doctor({ json: true }, cliConfig(NARROWED, { trust: TRUSTED }));
    const report = JSON.parse(lines.join('\n')) as {
      checks: { id: string; status: string }[];
    };
    const roles = report.checks.filter((c) => /role:/.test(c.id));
    // The layer narrows the implementer below the deny, so that role is green
    // — while the roles the layer does NOT cover still declare bash and are
    // still refused.
    expect(roles.find((c) => c.id.endsWith('role:implementer'))?.status).toBe(
      'pass',
    );
    const failed = roles
      .filter((c) => c.status === 'fail')
      .map((c) => c.id.replace(/^.*role:/, 'role:'));
    expect(failed).toEqual(['role:debugger', 'role:reviewer', 'role:tester']);
  });

  // The doctor runner judges roles AFTER the config
  // `[roles.<name>]` layers `kubic run --role` merges — a layer that
  // contradicts the document fails the role here with the run's refusal,
  // and with no `[roles]` section the document alone decides.
  it('kubic doctor fails a role its config [roles.<name>] layer contradicts, and passes it without the layer', async () => {
    const contradict = cliConfig(
      { [PROJECT]: '[roles.planner]\ntools = ["read", "write"]\n' },
      { trust: TRUSTED },
    );
    const layered = runners(workspaceWithRoles());
    await layered.r.doctor({ json: true }, contradict);
    const layeredReport = JSON.parse(layered.lines.join('\n')) as {
      checks: { id: string; status: string; detail: string }[];
    };
    const refused = layeredReport.checks.find((c) => c.id === 'role:planner');
    expect(refused?.status).toBe('fail');
    expect(refused?.detail).toMatch(/filesystem.*read.*write/i);
    // Control: the same workspace with no `[roles]` section judges the
    // document alone — the planner passes, so no phantom layers leak in.
    const plain = runners(workspaceWithRoles());
    await plain.r.doctor({ json: true }, cliConfig({}, { trust: TRUSTED }));
    const plainReport = JSON.parse(plain.lines.join('\n')) as {
      checks: { id: string; status: string }[];
    };
    expect(
      plainReport.checks.find((c) => c.id === 'role:planner')?.status,
    ).toBe('pass');
  });
});
