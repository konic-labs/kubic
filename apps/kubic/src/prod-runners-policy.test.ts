// The enterprise policy and the model-pin semantics on the PRODUCTION
// runners. Every case builds its deps through
// `createProdRunners` / `prodRunDeps` — the functions the binary calls — over
// a real `loadRuntimeConfig`, never a hand-spread dep: a test that spreads the
// deps itself cannot notice when the production spread is dropped.
//
// Faux provider only (`KUBIC_PROVIDER=faux` or injected faux catalogs): zero
// network, zero paid tokens. Temp workspace, `process.cwd()` mocked, temp HOME
// from the hermetic vitest env.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import { disposeAllGitSandboxes } from '../../../packages/exec/src/test-support/git-sandbox.js';
import { loadRuntimeConfig } from '../../../packages/host/src/config/runtime.js';
import { NO_PROJECT_TRUST } from '../../../packages/host/src/config/trust-store.js';
import { buildTrajectoryExport } from '../../../packages/trajectory/src/export.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '../../../packages/worker/src/pi-boundary.js';
import {
  type CliConfigResult,
  runtimeApprovalDeps,
  runtimeModelPin,
  runtimeRunDeps,
} from './config-runtime.js';
import { runHeadlessPrompt } from './headless-run.js';
import { createProdRunners, prodRunDeps } from './prod-runners.js';

const tempDirs: string[] = [];

function tmpRoot(prefix = 'kubic-prod-policy-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  vi.stubEnv('NO_COLOR', '1');
});

afterEach(() => {
  disposeAllGitSandboxes();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ENTERPRISE = '/etc/kubic-test/enterprise.toml';

const PROJECT = '/nonexistent-cwd/.kubic/config.toml';

// The tests below load workspace role documents, so they run
// under the trusted report — the `KUBIC_TRUST_PROJECT=1` equivalent. Trust
// behavior itself stays pinned by the trust-store and skills suites.
const TRUSTED = {
  ...NO_PROJECT_TRUST,
  envTrust: true,
  trusted: true,
} as CliConfigResult['trust'];

function cliConfig(
  files: Record<string, string>,
  options: {
    env?: Record<string, string>;
    cliModel?: { provider: string; id: string };
    // Role documents resolve under project trust — tests that
    // load workspace role docs opt into the trusted report.
    trust?: CliConfigResult['trust'];
  } = {},
): CliConfigResult {
  const runtime = loadRuntimeConfig({
    bridge: {
      exists: (path: string): boolean => path in files,
      readTextFile: (path: string): string => files[path] as string,
    },
    home: '/nonexistent-home',
    cwd: '/nonexistent-cwd',
    enterprisePath: ENTERPRISE,
    productPath: '/nonexistent/product.toml',
    projectTrusted: true,
    env: options.env ?? {},
    ...(options.cliModel === undefined
      ? {}
      : { cli: { model: options.cliModel } }),
  });
  return {
    runtime,
    error: undefined,
    ignoreSplit: { missing: [], checked: [], applicable: false },
    trust: options.trust ?? NO_PROJECT_TRUST,
  };
}

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

function providers(
  spec: { provider: string; models: string[] }[],
): MutableModels {
  const models = createModels();
  for (const entry of spec) {
    const faux = fauxProvider({
      provider: entry.provider,
      models: entry.models.map((id) => ({ id })),
    });
    faux.setResponses([fauxAssistantMessage('ok')]);
    models.setProvider(faux.provider);
  }
  return models;
}

describe('prodRunDeps hands the headless runner every config seam', () => {
  it('forwards the enterprise policy, the model pin, the approvals and the run projections', () => {
    const cfg = cliConfig({
      [ENTERPRISE]:
        '[policy]\nallowed_models = ["corp/approved"]\ndenied_tools = ["bash"]\n',
      [PROJECT]:
        '[agent]\nname = "alice"\n[model]\nprovider = "corp"\nid = "approved"\n[approvals]\nroute = "deny"\nmaxPendingMs = 4321\n[journal]\nretentionDays = 3\noutOfScope = ["dist"]\n[permissions]\nshell = false\n[roles.implementer]\ntools = ["read"]\n',
    });
    const deps = prodRunDeps(cfg);
    expect(deps.modelPolicy).toBe(cfg.runtime?.policy);
    expect(deps.modelPolicy?.tools.deny).toEqual(['bash']);
    expect(deps.model).toEqual({ provider: 'corp', id: 'approved' });
    expect(deps.model).toEqual(runtimeModelPin(cfg));
    expect(deps.approvals).toEqual(runtimeApprovalDeps(cfg));
    expect(deps.approvals?.route).toBe('deny');
    expect(deps.approvals?.maxPendingMs).toBe(4321);
    // The remaining runtimeRunDeps projections travel with it.
    const run = runtimeRunDeps(cfg);
    expect(deps.policyClasses).toEqual(run.policyClasses);
    expect(deps.policyClasses?.shell).toBe(false);
    expect(deps.policySource).toBe('config');
    expect(deps.journalRetention).toEqual({ maxAgeMs: 3 * 86_400_000 });
    expect(deps.reconcileOutOfScope).toEqual(['dist']);
    // The lane projections and the per-path trust check.
    expect(deps.agentId).toBe('alice');
    expect(deps.roles?.layers).toHaveLength(1);
    expect(typeof deps.trustProject).toBe('function');
  });

  it('forwards the empty policy and no pin when the config declares nothing to gate on (control)', () => {
    const cfg = cliConfig({});
    const deps = prodRunDeps(cfg);
    // An empty [policy] still travels: hasModelPolicy/hasToolPolicy decide
    // whether any gate applies, so it gates nothing.
    expect(deps.modelPolicy).toBe(cfg.runtime?.policy);
    expect(deps.model).toBeUndefined();
    expect(deps.agentId).toBeUndefined();
  });
});

describe('`kubic run` through the prod runner enforces the config', () => {
  beforeEach(() => {
    vi.stubEnv('KUBIC_PROVIDER', 'faux');
  });

  it('refuses a model outside allowed_models with the named policy refusal (exit 6)', async () => {
    const { r, lines } = runners(tmpRoot());
    const code = (
      await r.run(
        { prompt: 'hello', json: true },
        cliConfig({
          [ENTERPRISE]: '[policy]\nallowed_models = ["corp/approved"]\n',
        }),
      )
    ).exitCode;
    expect(code).toBe(6);
    expect(lines.join('\n')).toContain(
      "model 'faux/echo' refused by enterprise policy (allowed_models/allowed_providers): no provider call was made",
    );
  });

  it('runs a model the policy allows (control)', async () => {
    const { r, lines } = runners(tmpRoot());
    const code = (
      await r.run(
        { prompt: 'hello', json: true },
        cliConfig({ [ENTERPRISE]: '[policy]\nallowed_models = ["faux/*"]\n' }),
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('faux echo: hello');
  });

  it('installs the config approvals route: route = "deny" refuses a challenged call by policy', async () => {
    const workspace = tmpRoot();
    const { r, lines } = runners(workspace);
    const code = (
      await r.run(
        {
          prompt: 'faux:tool bash {"command":"rm -rf gone"}',
          json: true,
        },
        cliConfig({ [PROJECT]: '[approvals]\nroute = "deny"\n' }),
      )
    ).exitCode;
    expect(lines.join('\n')).toContain('denied by policy route');
    expect(code).toBe(4);
  });
});

// A disableModelInvocation skill is reachable only
// through explicit invocation — `--invoke-skill` expands the skill content
// against the booted (gated-visible, hidden included) skills and runs it
// as the turn prompt; an unknown name fails the run closed.
describe('explicit skill invocation reaches hidden skills', () => {
  beforeEach(() => {
    vi.stubEnv('KUBIC_PROVIDER', 'faux');
  });

  function hiddenSkillWorkspace(): { workspace: string; marker: string } {
    const workspace = tmpRoot('kubic-prod-183-');
    const marker = join(workspace, 'invoked');
    // Project skills load inside a repository (the walk stops
    // at the git top level), so mark the workspace root.
    mkdirSync(join(workspace, '.git'), { recursive: true });
    mkdirSync(join(workspace, '.agents', 'skills', 'secret'), {
      recursive: true,
    });
    writeFileSync(
      join(workspace, '.agents', 'skills', 'secret', 'SKILL.md'),
      '---\nname: secret\ndescription: Hidden helper\ndisableModelInvocation: true\n---\n\n' +
        `faux:tool write {"path":${JSON.stringify(marker)},"content":"invoked"}`,
    );
    return { workspace, marker };
  }

  it('invokes a hidden skill: the faux provider sees the skill content', async () => {
    const { workspace, marker } = hiddenSkillWorkspace();
    const { r } = runners(workspace);
    const code = (
      await r.run(
        { prompt: 'do x', invokeSkill: 'secret', json: true },
        cliConfig({}, { trust: TRUSTED }),
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  it('an unknown skill name fails the run with the named error', async () => {
    const { workspace } = hiddenSkillWorkspace();
    const { r, lines } = runners(workspace);
    const code = (
      await r.run(
        { prompt: 'do x', invokeSkill: 'ghost', json: true },
        cliConfig({}, { trust: TRUSTED }),
      )
    ).exitCode;
    expect(code).not.toBe(0);
    expect(lines.join('\n')).toContain("unknown skill 'ghost'");
  });

  it('a role-withheld skill resolves as unknown on the invoke path', async () => {
    const { workspace, marker } = hiddenSkillWorkspace();
    mkdirSync(join(workspace, '.kubic', 'roles'), { recursive: true });
    writeFileSync(
      join(workspace, '.kubic', 'roles', 'narrow.md'),
      '---\nrole: narrow\ntools: [read, ls]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\nskills: [open]\n---\n# Narrow\n\n## Prompt\n\nBe narrow.\n',
    );
    const { r, lines } = runners(workspace);
    const code = (
      await r.run(
        { prompt: 'do x', invokeSkill: 'secret', role: 'narrow', json: true },
        cliConfig({}, { trust: TRUSTED }),
      )
    ).exitCode;
    expect(code).not.toBe(0);
    expect(lines.join('\n')).toContain("unknown skill 'secret'");
    expect(existsSync(marker)).toBe(false);
  });
});
// The lane installs the most restrictive merge
// of the config classes and the role's, and the role's approval obligations
// challenge on the installed triggers.
describe('role classes and approval requires reach the installed policy', () => {
  beforeEach(() => {
    vi.stubEnv('KUBIC_PROVIDER', 'faux');
  });

  const roleDoc = (network: string): string =>
    `---\nrole: reviewer\ntools: [read, bash]\nfilesystem: read\nshell: true\nnetwork: ${network}\ngit: false\ncredentials: none\n---\n\n# reviewer\n\n## Prompt\n\nReview.\n`;

  function reviewerWorkspace(network: string): string {
    const workspace = tmpRoot('kubic-prod-196-');
    mkdirSync(join(workspace, '.kubic', 'roles'), { recursive: true });
    writeFileSync(
      join(workspace, '.kubic', 'roles', 'reviewer.md'),
      roleDoc(network),
    );
    return workspace;
  }

  it('a role declaring network:none runs under it even when config allows full', async () => {
    const workspace = reviewerWorkspace('none');
    const { r, lines } = runners(workspace);
    const code = (
      await r.run(
        {
          prompt: 'faux:tool bash {"command":"curl https://example.com"}',
          role: 'reviewer',
          json: true,
        },
        cliConfig(
          {
            [PROJECT]:
              '[permissions]\nnetwork = "full"\n[approvals]\nroute = "deny"\n',
          },
          { trust: TRUSTED },
        ),
      )
    ).exitCode;
    expect(lines.join('\n')).toContain('denied by policy route');
    expect(code).toBe(4);
  });

  it('a config declaring network:none holds even when the role allows full', async () => {
    const workspace = reviewerWorkspace('full');
    const { r, lines } = runners(workspace);
    const code = (
      await r.run(
        {
          prompt: 'faux:tool bash {"command":"curl https://example.com"}',
          role: 'reviewer',
          json: true,
        },
        cliConfig(
          {
            [PROJECT]:
              '[permissions]\nnetwork = "none"\n[approvals]\nroute = "deny"\n',
          },
          { trust: TRUSTED },
        ),
      )
    ).exitCode;
    expect(lines.join('\n')).toContain('denied by policy route');
    expect(code).toBe(4);
  });

  it("the role document's requires challenge an otherwise-allowed tool", async () => {
    const workspace = tmpRoot('kubic-prod-196-');
    mkdirSync(join(workspace, '.kubic', 'roles'), { recursive: true });
    writeFileSync(
      join(workspace, '.kubic', 'roles', 'reviewer.md'),
      '---\nrole: reviewer\ntools: [read, write]\nfilesystem: workspace-write\nshell: false\nnetwork: none\ngit: false\ncredentials: none\nrequires: [write]\n---\n\n# reviewer\n\n## Prompt\n\nReview.\n',
    );
    const { r, lines } = runners(workspace);
    const code = (
      await r.run(
        {
          prompt: `faux:tool write {"path":${JSON.stringify(join(workspace, 'note'))},"content":"hi"}`,
          role: 'reviewer',
          json: true,
        },
        cliConfig(
          { [PROJECT]: '[approvals]\nroute = "deny"\n' },
          { trust: TRUSTED },
        ),
      )
    ).exitCode;
    expect(lines.join('\n')).toContain('denied by policy route');
    expect(code).toBe(4);
  });

  it('a [roles.<name>] requires layer challenges like the document list', async () => {
    const workspace = tmpRoot('kubic-prod-196-');
    mkdirSync(join(workspace, '.kubic', 'roles'), { recursive: true });
    writeFileSync(
      join(workspace, '.kubic', 'roles', 'reviewer.md'),
      '---\nrole: reviewer\ntools: [read, write]\nfilesystem: workspace-write\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n---\n\n# reviewer\n\n## Prompt\n\nReview.\n',
    );
    const { r, lines } = runners(workspace);
    const code = (
      await r.run(
        {
          prompt: `faux:tool write {"path":${JSON.stringify(join(workspace, 'note'))},"content":"hi"}`,
          role: 'reviewer',
          json: true,
        },
        cliConfig(
          {
            [PROJECT]:
              '[approvals]\nroute = "deny"\n[roles.reviewer]\nrequires = ["write"]\n',
          },
          { trust: TRUSTED },
        ),
      )
    ).exitCode;
    expect(lines.join('\n')).toContain('denied by policy route');
    expect(code).toBe(4);
  });
});

describe('a frozen enterprise model pin announces the flag or env pin it overrides', () => {
  const FROZEN = '[model]\nprovider = "corp"\nid = "approved"\n';
  const NOTE_CLI =
    'note: --model evil/other ignored: model pinned by enterprise policy (corp/approved)';
  const NOTE_ENV =
    'note: KUBIC_MODEL=evil/other ignored: model pinned by enterprise policy (corp/approved)';

  beforeEach(() => {
    vi.stubEnv('KUBIC_PROVIDER', 'faux');
  });

  it('kubic run: one stderr note naming the ignored --model, stdout untouched', async () => {
    const { r, lines, errs } = runners(tmpRoot());
    const code = (
      await r.run(
        { prompt: 'hello', json: true },
        cliConfig(
          { [ENTERPRISE]: FROZEN },
          { cliModel: { provider: 'evil', id: 'other' } },
        ),
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(errs.filter((line) => line.startsWith('note:'))).toEqual([NOTE_CLI]);
    // The --json envelope stays exactly one valid document.
    const doc = JSON.parse(lines.join('\n')) as { status: string };
    expect(doc.status).toBe('completed');
  });

  it('kubic run: names an ignored KUBIC_MODEL by its env spelling', async () => {
    const { r, errs } = runners(tmpRoot());
    await r.run(
      { prompt: 'hello', json: true },
      cliConfig(
        { [ENTERPRISE]: FROZEN },
        { env: { KUBIC_MODEL: 'evil/other' } },
      ),
    );
    expect(errs.filter((line) => line.startsWith('note:'))).toEqual([NOTE_ENV]);
  });

  it('kubic run: one note per overridden pin when both the flag and the env pin are ignored', async () => {
    const { r, errs } = runners(tmpRoot());
    await r.run(
      { prompt: 'hello', json: true },
      cliConfig(
        { [ENTERPRISE]: FROZEN },
        {
          env: { KUBIC_MODEL: 'evil/other' },
          cliModel: { provider: 'evil', id: 'other' },
        },
      ),
    );
    expect(errs.filter((line) => line.startsWith('note:'))).toEqual([
      NOTE_CLI,
      NOTE_ENV,
    ]);
  });

  it('says nothing when nothing was overridden (no pin, the same pin, or no freeze)', async () => {
    // No pin given against a frozen model.
    const none = runners(tmpRoot());
    await none.r.run(
      { prompt: 'hello', json: true },
      cliConfig({ [ENTERPRISE]: FROZEN }),
    );
    expect(none.errs.filter((line) => line.startsWith('note:'))).toEqual([]);
    // The flag names the very model the enterprise layer pinned.
    const same = runners(tmpRoot());
    await same.r.run(
      { prompt: 'hello', json: true },
      cliConfig(
        { [ENTERPRISE]: FROZEN },
        { cliModel: { provider: 'corp', id: 'approved' } },
      ),
    );
    expect(same.errs.filter((line) => line.startsWith('note:'))).toEqual([]);
    // No enterprise freeze: the flag simply wins, nothing to announce.
    const free = runners(tmpRoot());
    await free.r.run(
      { prompt: 'hello', json: true },
      cliConfig({}, { cliModel: { provider: 'evil', id: 'other' } }),
    );
    expect(free.errs.filter((line) => line.startsWith('note:'))).toEqual([]);
  });

  it('kubic tui: the note lands before the boot (exit 6 on the unknown pinned model, no terminal)', async () => {
    const { r, errs } = runners(tmpRoot());
    // The frozen pin names a provider this catalog lacks, so the boot stops
    // at model selection — before any terminal opens.
    vi.stubEnv('KUBIC_PROVIDER', '');
    const code = (
      await r.tui(
        {},
        cliConfig(
          { [ENTERPRISE]: FROZEN },
          { cliModel: { provider: 'evil', id: 'other' } },
        ),
      )
    ).exitCode;
    expect(code).toBe(6);
    expect(errs.filter((line) => line.startsWith('note:'))).toEqual([NOTE_CLI]);
  });
});

describe('a model refusal names the real source of the pin', () => {
  // A catalog whose `anthropic` provider exists but lacks the pinned id, so
  // the refusal is the "unknown model" one — no network, no key.
  const catalog = (): MutableModels =>
    providers([{ provider: 'anthropic', models: ['claude-x'] }]);

  async function refusal(cfg: CliConfigResult): Promise<string> {
    const result = await runHeadlessPrompt(
      'hello',
      {},
      {
        ...prodRunDeps(cfg),
        sessionsRoot: tmpRoot(),
        models: catalog(),
        env: new NodeExecutionEnv(tmpRoot()),
        warn: () => undefined,
      },
    );
    expect(result.terminus).toBe('provider_probe_failed');
    return result.error?.message ?? '';
  }

  it('labels a KUBIC_MODEL pin (KUBIC_MODEL), not --model', async () => {
    expect(
      await refusal(cliConfig({}, { env: { KUBIC_MODEL: 'anthropic/zzz-1' } })),
    ).toBe("unknown model 'zzz-1' on provider 'anthropic' (KUBIC_MODEL)");
  });

  it('labels a --model pin (--model)', async () => {
    expect(
      await refusal(
        cliConfig({}, { cliModel: { provider: 'anthropic', id: 'zzz-1' } }),
      ),
    ).toBe("unknown model 'zzz-1' on provider 'anthropic' (--model)");
  });

  it('labels a config [model] pin by the layer that set it', async () => {
    expect(
      await refusal(
        cliConfig({
          [PROJECT]: '[model]\nprovider = "anthropic"\nid = "zzz-1"\n',
        }),
      ),
    ).toBe(
      "unknown model 'zzz-1' on provider 'anthropic' ([model] in project config)",
    );
  });

  it('labels an unknown provider the same way', async () => {
    expect(
      await refusal(cliConfig({}, { env: { KUBIC_MODEL: 'nope/zzz-1' } })),
    ).toBe("unknown provider 'nope' (KUBIC_MODEL)");
  });

  it('labels a role-layer model pin (role model)', async () => {
    const workspace = tmpRoot();
    mkdirSync(join(workspace, '.kubic', 'roles'), { recursive: true });
    writeFileSync(
      join(workspace, '.kubic', 'roles', 'implementer.md'),
      '---\nrole: implementer\ntools: [read]\n---\n## Prompt\n\nImplement the step.\n',
    );
    const cfg = cliConfig(
      {
        [PROJECT]: '[roles.implementer]\nmodel = "anthropic/zzz-1"\n',
      },
      { trust: TRUSTED },
    );
    const result = await runHeadlessPrompt(
      'hello',
      { role: 'implementer' },
      {
        ...prodRunDeps(cfg),
        sessionsRoot: tmpRoot(),
        models: catalog(),
        env: new NodeExecutionEnv(workspace),
        roles: { ...prodRunDeps(cfg).roles, cwd: workspace },
        warn: () => undefined,
      },
    );
    expect(result.terminus).toBe('provider_probe_failed');
    expect(result.error?.message).toBe(
      "unknown model 'zzz-1' on provider 'anthropic' (role model)",
    );
  });

  it('keeps the flag label for a genuine --model that a stale env pin sits under', async () => {
    // cli beats env: the pin in force IS the flag, whatever KUBIC_MODEL says.
    expect(
      await refusal(
        cliConfig(
          {},
          {
            env: { KUBIC_MODEL: 'anthropic/from-env' },
            cliModel: { provider: 'anthropic', id: 'zzz-1' },
          },
        ),
      ),
    ).toBe("unknown model 'zzz-1' on provider 'anthropic' (--model)");
  });
});

describe('`kubic replay --tier live` re-executes under the enterprise policy', () => {
  function replayFixture(objective = 'say hi'): {
    trajectory: string;
    lockfile: string;
  } {
    const dir = tmpRoot('kubic-replay-policy-');
    const trajectory = join(dir, 't.json');
    writeFileSync(
      trajectory,
      JSON.stringify(
        buildTrajectoryExport({
          task: { taskId: 'task-1', objective, role: 'writer' },
          identity: { sessionId: 'sess-1', agentId: 'agent-1', workerId: null },
          model: {
            provider: 'faux',
            model: 'echo',
            thinking: null,
            escalations: [],
          },
          prompt: { text: 'say hi', constraints: [] },
          resources: { skills: [], promptTemplates: [] },
          transfer: null,
          actions: [],
          observations: [],
          state: { phase: 'done', snapshot: null },
          provenance: {
            sessionId: 'sess-1',
            agentId: 'agent-1',
            pid: null,
            generation: 1,
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
    const { r, lines, errs } = runners(tmpRoot());
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
    const roleConfig = join(tmpRoot('kubic-replay-role-'), 'role.json');
    writeFileSync(roleConfig, '{"role":"writer"}\n');
    // The role config names the role; the document it pins
    // must exist in the re-execution's worktree (the mocked workspace).
    const workspace = tmpRoot();
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
      const workspace = tmpRoot('kubic-replay-role-tools-');
      mkdirSync(join(workspace, '.kubic', 'roles'), { recursive: true });
      writeFileSync(
        join(workspace, '.kubic', 'roles', 'reader.md'),
        roleDoc(tools, shell),
      );
      const roleConfig = join(tmpRoot('kubic-replay-role-pin-'), 'role.json');
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
    const workspace = tmpRoot('kubic-replay-cwd-');
    const worktree = tmpRoot('kubic-replay-wt-');
    mkdirSync(join(worktree, '.kubic', 'roles'), { recursive: true });
    writeFileSync(
      join(worktree, '.kubic', 'roles', 'reader.md'),
      '---\nrole: reader\ntools: [read, bash]\nfilesystem: workspace-write\nshell: true\nnetwork: none\ngit: false\ncredentials: none\n---\n\n# reader\n\n## Prompt\n\nRead.\n',
    );
    const roleConfig = join(tmpRoot('kubic-replay-role-pin-'), 'role.json');
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
    const { r, lines } = runners(tmpRoot());
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
    const { r, errs } = runners(tmpRoot());
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
    const workspace = tmpRoot();
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
