// The interactive lane under the enterprise policy, built through the REAL
// production deps builder. The enterprise model/tool/role gates must reach
// `kubic tui` and bare `kubic`: `modelPolicy` is forwarded through the projection's
// table, and a test that hand-spreads the deps cannot catch a dropped production
// spread. These tests build
// the deps with `prodTuiDeps(io, cliConfig)` (the function the runner calls)
// and boot the real `bootTuiLane`.
//
// Faux provider only: zero network, zero paid tokens.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelSelectError } from '@kubic/agent/model-select';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from '@kubic/agent/pi-boundary';
import { fauxToolUse } from '@kubic/agent/test-support/lane-harness';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { disposeAllGitSandboxes } from '@kubic/exec/test-support/git-sandbox';
import { loadRuntimeConfig, NO_PROJECT_TRUST } from '@kubic/host/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { terminalRig } from '../../../test/fake-terminal.js';
import {
  type CliConfigResult,
  runtimeApprovalDeps,
  runtimeModelPin,
} from './config-runtime.js';
import { prodTuiDeps } from './prod-runners.js';
import { bootTuiLane } from './tui/boot.js';
import { tuiBootOptions, tuiDepsWithDefaults } from './tui/deps.js';
import type { TuiBootFlags, TuiRunOptions } from './tui/options.js';
import { runTuiCommand } from './tui/run.js';

const tempDirs: string[] = [];

function tmpRoot(prefix = 'kubic-tui-policy-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
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

// The effective config exactly as the composition root wraps it: a real
// `loadRuntimeConfig` over in-memory layer files (the enterprise layer at a
// fake path, so nothing reads /etc).
function cliConfig(
  files: Record<string, string>,
  options: {
    env?: Record<string, string>;
    cliModel?: { provider: string; id: string };
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
    trust: NO_PROJECT_TRUST,
  };
}

function providers(
  spec: { provider: string; models: string[] }[],
  captured: CapturedRequest[] = [],
): MutableModels {
  const models = createModels();
  for (const entry of spec) {
    const faux = fauxProvider({
      provider: entry.provider,
      models: entry.models.map((id) => ({ id })),
    });
    faux.setResponses([
      (context: unknown) => {
        captured.push(capturedRequestOf(context));
        return fauxAssistantMessage('ok');
      },
    ]);
    models.setProvider(faux.provider);
  }
  return models;
}

// The prod boot, re-rooted onto temp state: whatever the production deps
// builder forwards reaches the real bootTuiLane unchanged.
function rerooted(
  workspace: string,
  sessionsRoot: string,
  models: MutableModels,
): typeof bootTuiLane {
  return (sessionId?: string, options: TuiRunOptions = {}) =>
    bootTuiLane(sessionId, {
      ...options,
      sessionsRoot,
      models,
      env: new NodeExecutionEnv(workspace),
      skills: { homeDir: workspace, cwd: workspace, trusted: false },
      roles: { ...options.roles, cwd: workspace },
    });
}

const IO = { out: (): void => {}, debug: (): void => {} };

// One request's model-visible facts. The durable lane materializes the
// assembled prompt and the offered tool set at REQUEST time (a positional
// prompt section, not a boot argument), so the faux provider's own request
// context is where the enterprise gates can be observed end to end.
interface CapturedRequest {
  prompt: string;
  tools: string[];
}

function capturedRequestOf(context: unknown): CapturedRequest {
  const messages = (
    context as {
      messages?: readonly {
        role?: unknown;
        content?: unknown;
        sections?: Record<string, unknown>;
        toolsAdded?: readonly { name?: unknown }[];
      }[];
    }
  ).messages;
  const system = messages?.find((message) => message.role === 'system');
  const parts: string[] = [];
  if (typeof system?.content === 'string' && system.content !== '') {
    parts.push(system.content);
  }
  for (const section of Object.values(system?.sections ?? {})) {
    if (typeof section === 'string' && section !== '') parts.push(section);
  }
  return {
    prompt: parts.join('\n\n'),
    tools: (system?.toolsAdded ?? []).map((tool) => String(tool.name)),
  };
}

// The offered tools of the last request, in the order the prompt advertises
// them (`tools:` line) — the same set the conversation configured.
function advertisedTools(prompt: string): string[] {
  return (/^tools: (.*)$/m.exec(prompt)?.[1] ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
}

describe('prodTuiDeps hands bootTuiLane every config seam', () => {
  it('forwards the enterprise policy, the model pin, the approvals and the journal projections', async () => {
    const cfg = cliConfig({
      [ENTERPRISE]:
        '[policy]\nallowed_models = ["corp/approved"]\ndenied_tools = ["bash"]\n',
      [PROJECT]:
        '[model]\nprovider = "corp"\nid = "approved"\n[approvals]\nroute = "deny"\nmaxPendingMs = 1234\n[journal]\nretentionDays = 2\noutOfScope = ["dist"]\n[ui]\ntheme = "light"\n',
    });
    let seen: TuiRunOptions | undefined;
    const deps = tuiDepsWithDefaults(
      prodTuiDeps(IO, cfg),
      async (_id, opts) => {
        seen = opts;
        return { sessionId: 's', model: 'corp/approved' };
      },
    );
    await deps.bootLane();
    // The SAME resolved object the headless runner gates with (identity, not
    // a copy that could drift).
    expect(seen?.modelPolicy).toBe(cfg.runtime?.policy);
    expect(seen?.modelPolicy?.tools.deny).toEqual(['bash']);
    expect(seen?.model).toEqual({ provider: 'corp', id: 'approved' });
    expect(seen?.model).toEqual(runtimeModelPin(cfg));
    expect(seen?.approvals).toEqual(runtimeApprovalDeps(cfg));
    expect(seen?.approvals?.route).toBe('deny');
    expect(seen?.approvals?.maxPendingMs).toBe(1234);
    expect(seen?.journalRetention).toEqual({ maxAgeMs: 2 * 86_400_000 });
    expect(seen?.reconcileOutOfScope).toEqual(['dist']);
    // The `[ui] theme` reference reaches the deps the runner
    // reads (dropping the prod spread must not stay green).
    expect(seen?.theme).toBe('light');
  });

  it('forwards the empty policy and no pin when the config declares none (control)', async () => {
    const cfg = cliConfig({});
    let seen: TuiRunOptions | undefined;
    const deps = tuiDepsWithDefaults(
      prodTuiDeps(IO, cfg),
      async (_id, opts) => {
        seen = opts;
        return { sessionId: 's', model: 'x/y' };
      },
    );
    await deps.bootLane();
    // An empty [policy] resolves to an empty effective policy, which still
    // travels (hasModelPolicy/hasToolPolicy decide whether any gate applies).
    expect(seen?.modelPolicy).toBe(cfg.runtime?.policy);
    expect(seen?.model).toBeUndefined();
  });
});

describe('the prod tui builder enforces the enterprise gates on the real boot', () => {
  it('refuses a pinned model outside allowed_models before any provider call', async () => {
    const cfg = cliConfig({
      [ENTERPRISE]: '[policy]\nallowed_models = ["corp/approved"]\n',
      [PROJECT]: '[model]\nprovider = "fx"\nid = "a"\n',
    });
    const deps = tuiDepsWithDefaults(
      prodTuiDeps(IO, cfg),
      rerooted(
        tmpRoot(),
        tmpRoot(),
        providers([{ provider: 'fx', models: ['a', 'b'] }]),
      ),
    );
    await expect(deps.bootLane()).rejects.toThrow(
      "model 'fx/a' refused by enterprise policy (allowed_models/allowed_providers): no provider call was made",
    );
  });

  it('does not pick an implicit provider the policy disallows', async () => {
    const cfg = cliConfig({
      [ENTERPRISE]: '[policy]\nallowed_models = ["corp/approved"]\n',
    });
    const models = providers([{ provider: 'fx', models: ['a', 'b'] }]);
    const gated = tuiDepsWithDefaults(
      prodTuiDeps(IO, cfg),
      rerooted(tmpRoot(), tmpRoot(), models),
    );
    // With no explicit pin the pool of implicit providers is empty under the
    // policy, so the boot refuses with the named no-models error (the
    // implicit pick never falls back to a disallowed provider).
    await expect(gated.bootLane()).rejects.toThrow(
      /no models available: register a provider first/,
    );
    // Control: with no policy the same catalog boots on the first provider.
    const open = tuiDepsWithDefaults(
      prodTuiDeps(IO, cliConfig({})),
      rerooted(tmpRoot(), tmpRoot(), models),
    );
    const boot = await open.bootLane();
    await boot.close?.();
    expect(boot.model).toBe('fx/a');
  });

  it('activates only the tools the enterprise deny list leaves (active tools and prompt line)', async () => {
    const cfg = cliConfig({
      [ENTERPRISE]: '[policy]\ndenied_tools = ["bash"]\n',
    });
    const captured: CapturedRequest[] = [];
    const deps = tuiDepsWithDefaults(
      prodTuiDeps(IO, cfg),
      rerooted(
        tmpRoot(),
        tmpRoot(),
        providers([{ provider: 'fx', models: ['a'] }], captured),
      ),
    );
    const boot = await deps.bootLane();
    const loop = boot.loop;
    if (loop === undefined) throw new Error('the prod boot returned no loop');
    await loop.runTurn('hi', {
      requestId: 'enterprise-tools',
      context: loop.context,
      whenBusy: 'reject',
    });
    await boot.close?.();
    const request = captured.at(-1);
    expect(request?.tools).not.toContain('bash');
    expect(request?.tools).toContain('read');
    // The prompt advertises exactly the set the conversation offers: the
    // model is told the truth about its own tools.
    const advertised = advertisedTools(request?.prompt ?? '');
    expect(advertised).not.toContain('bash');
    expect(advertised).toContain('read');
  });

  it('leaves the tool set alone when no tool policy is configured (control)', async () => {
    const captured: CapturedRequest[] = [];
    const deps = tuiDepsWithDefaults(
      prodTuiDeps(IO, cliConfig({})),
      rerooted(
        tmpRoot(),
        tmpRoot(),
        providers([{ provider: 'fx', models: ['a'] }], captured),
      ),
    );
    const boot = await deps.bootLane();
    const loop = boot.loop;
    if (loop === undefined) throw new Error('the prod boot returned no loop');
    await loop.runTurn('hi', {
      requestId: 'no-policy-tools',
      context: loop.context,
      whenBusy: 'reject',
    });
    await boot.close?.();
    expect(captured.at(-1)?.tools).toContain('bash');
  });

  it('refuses a --role that declares an enterprise-denied tool', async () => {
    const workspace = tmpRoot();
    mkdirSync(join(workspace, '.kubic', 'roles'), { recursive: true });
    writeFileSync(
      join(workspace, '.kubic', 'roles', 'implementer.md'),
      '---\nrole: implementer\ntools: [read, ls, write, bash]\nfilesystem: workspace-write\nshell: true\nnetwork: none\ngit: false\ncredentials: none\n---\n## Prompt\n\nImplement the step.\n',
    );
    const cfg = cliConfig({
      [ENTERPRISE]: '[policy]\ndenied_tools = ["bash"]\n',
    });
    const deps = tuiDepsWithDefaults(
      prodTuiDeps(IO, cfg),
      rerooted(
        workspace,
        tmpRoot(),
        providers([{ provider: 'fx', models: ['a'] }]),
      ),
    );
    await expect(
      deps.bootLane(undefined, undefined, { role: 'implementer' }),
    ).rejects.toThrow(/role 'implementer'.*'bash' denied/);
  });
});

describe('`kubic tui --model` cannot bypass the projected pin', () => {
  // What runTuiCommand really builds from commander's parsed options, with a
  // boot that stops right after capturing the flags (exit 6, no terminal).
  async function flagsFor(model: {
    provider: string;
    id: string;
  }): Promise<TuiBootFlags | undefined> {
    let seen: TuiBootFlags | undefined;
    const code = (
      await runTuiCommand(
        { model },
        {
          out: () => {},
          err: () => {},
          createTerminal: () => {
            throw new Error('the boot stops before a terminal opens');
          },
          bootLane: async (_sid, _answer, flags) => {
            seen = flags;
            throw new ModelSelectError('stop after capturing the flags');
          },
        },
      )
    ).exitCode;
    expect(code).toBe(6);
    return seen;
  }

  it('a frozen enterprise pin holds against --model: the projected value wins', async () => {
    // Dispatch pre-scans `--model` into the config load (the cli layer); the
    // enterprise freeze keeps its own pin, and that projection is the pin the
    // boot must use — a flag patched over it afterwards would bypass the
    // freeze that `kubic run` honours.
    const cfg = cliConfig(
      { [ENTERPRISE]: '[model]\nprovider = "corp"\nid = "approved"\n' },
      { cliModel: { provider: 'evil', id: 'other' } },
    );
    expect(runtimeModelPin(cfg)).toEqual({ provider: 'corp', id: 'approved' });
    const flags = await flagsFor({ provider: 'evil', id: 'other' });
    const options = tuiBootOptions(prodTuiDeps(IO, cfg), flags, undefined);
    expect(options.model).toEqual({ provider: 'corp', id: 'approved' });
  });

  it('an unfrozen --model still selects through the config load (cli above env and file)', async () => {
    const cfg = cliConfig(
      { [PROJECT]: '[model]\nprovider = "fx"\nid = "a"\n' },
      { cliModel: { provider: 'fx', id: 'b' } },
    );
    const flags = await flagsFor({ provider: 'fx', id: 'b' });
    const options = tuiBootOptions(prodTuiDeps(IO, cfg), flags, undefined);
    expect(options.model).toEqual({ provider: 'fx', id: 'b' });
  });
});

describe('/model switch under the enterprise policy', () => {
  const POLICY = { [ENTERPRISE]: '[policy]\nallowed_models = ["faux/*"]\n' };
  const twoProviders = (): MutableModels =>
    providers([
      { provider: 'faux', models: ['big', 'small'] },
      { provider: 'other', models: ['m1'] },
    ]);

  it('refuses a switch outside allowed_models, naming the boot-time refusal, and keeps the live model', async () => {
    const cfg = cliConfig({
      ...POLICY,
      [PROJECT]: '[model]\nprovider = "faux"\nid = "big"\n',
    });
    const deps = tuiDepsWithDefaults(
      prodTuiDeps(IO, cfg),
      rerooted(tmpRoot(), tmpRoot(), twoProviders()),
    );
    const boot = await deps.bootLane();
    const loop = boot.loop;
    if (loop?.switchModel === undefined) {
      throw new Error('the prod boot returned no switchable loop');
    }
    expect(boot.model).toBe('faux/big');
    await expect(
      loop.switchModel({ provider: 'other', modelId: 'm1' }, loop.context),
    ).rejects.toThrow(
      "model 'other/m1' refused by enterprise policy (allowed_models/allowed_providers): no provider call was made",
    );
    // The lane kept the model it had.
    expect(await loop.model?.(loop.context)).toBe('faux/big');
    // A switch the policy allows still works (the gate is not a blanket block).
    await expect(
      loop.switchModel({ provider: 'faux', modelId: 'small' }, loop.context),
    ).resolves.toBe('faux/small');
    expect(await loop.model?.(loop.context)).toBe('faux/small');
    await boot.close?.();
  });

  it('switches freely when the config declares no model policy (control)', async () => {
    const deps = tuiDepsWithDefaults(
      prodTuiDeps(IO, cliConfig({})),
      rerooted(tmpRoot(), tmpRoot(), twoProviders()),
    );
    const boot = await deps.bootLane();
    const loop = boot.loop;
    if (loop?.switchModel === undefined) {
      throw new Error('the prod boot returned no switchable loop');
    }
    await expect(
      loop.switchModel({ provider: 'other', modelId: 'm1' }, loop.context),
    ).resolves.toBe('other/m1');
    await boot.close?.();
  });

  it('still names an unknown model on an allowed provider (the catalog check stands)', async () => {
    const deps = tuiDepsWithDefaults(
      prodTuiDeps(IO, cliConfig(POLICY)),
      rerooted(tmpRoot(), tmpRoot(), twoProviders()),
    );
    const boot = await deps.bootLane();
    const loop = boot.loop;
    if (loop?.switchModel === undefined) {
      throw new Error('the prod boot returned no switchable loop');
    }
    await expect(
      loop.switchModel({ provider: 'faux', modelId: 'nope' }, loop.context),
    ).rejects.toThrow("unknown model 'nope' on provider 'faux'");
    await boot.close?.();
  });
});

// `--model` and `/model` are the one "session override" level,
// and enterprise restrictions cannot be overridden by any lower layer — so a
// frozen enterprise `[model]` binds the live switch exactly as it binds the
// flag (a `/model` away from it would be the bypass the freeze exists to stop).
describe('/model cannot leave a frozen enterprise model pin', () => {
  const twoProviders = (): MutableModels =>
    providers([
      { provider: 'faux', models: ['big', 'small'] },
      { provider: 'other', models: ['m1'] },
    ]);
  const FROZEN = '[model]\nprovider = "faux"\nid = "big"\n';

  it('refuses a switch away from the frozen pin by name and keeps the live model', async () => {
    const deps = tuiDepsWithDefaults(
      prodTuiDeps(IO, cliConfig({ [ENTERPRISE]: FROZEN })),
      rerooted(tmpRoot(), tmpRoot(), twoProviders()),
    );
    const boot = await deps.bootLane();
    const loop = boot.loop;
    if (loop?.switchModel === undefined) {
      throw new Error('the prod boot returned no switchable loop');
    }
    expect(boot.model).toBe('faux/big');
    for (const target of [
      { provider: 'faux', modelId: 'small' },
      { provider: 'other', modelId: 'm1' },
    ]) {
      await expect(loop.switchModel(target, loop.context)).rejects.toThrow(
        `model '${target.provider}/${target.modelId}' refused: the model is pinned by enterprise policy (faux/big); /model cannot change it`,
      );
    }
    expect(await loop.model?.(loop.context)).toBe('faux/big');
    // Naming the pin itself changes nothing, so it is not refused.
    await expect(
      loop.switchModel({ provider: 'faux', modelId: 'big' }, loop.context),
    ).resolves.toBe('faux/big');
    await boot.close?.();
  });

  it('keeps `/model` free under a pin nobody froze (control)', async () => {
    const deps = tuiDepsWithDefaults(
      prodTuiDeps(IO, cliConfig({ [PROJECT]: FROZEN })),
      rerooted(tmpRoot(), tmpRoot(), twoProviders()),
    );
    const boot = await deps.bootLane();
    const loop = boot.loop;
    if (loop?.switchModel === undefined) {
      throw new Error('the prod boot returned no switchable loop');
    }
    await expect(
      loop.switchModel({ provider: 'faux', modelId: 'small' }, loop.context),
    ).resolves.toBe('faux/small');
    await boot.close?.();
  });

  it('a flag or env pin that the freeze dropped does not unfreeze the switch', async () => {
    const deps = tuiDepsWithDefaults(
      prodTuiDeps(
        IO,
        cliConfig(
          { [ENTERPRISE]: FROZEN },
          { cliModel: { provider: 'other', id: 'm1' } },
        ),
      ),
      rerooted(tmpRoot(), tmpRoot(), twoProviders()),
    );
    const boot = await deps.bootLane();
    const loop = boot.loop;
    if (loop?.switchModel === undefined) {
      throw new Error('the prod boot returned no switchable loop');
    }
    expect(boot.model).toBe('faux/big');
    await expect(
      loop.switchModel({ provider: 'other', modelId: 'm1' }, loop.context),
    ).rejects.toThrow(/pinned by enterprise policy \(faux\/big\)/);
    await boot.close?.();
  });
});

describe('advertised skills outside the workspace stay readable on the tui lane', () => {
  function writeSkill(root: string, name: string): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'SKILL.md');
    writeFileSync(
      file,
      `---\nname: ${name}\ndescription: Skill ${name}\n---\n\nBody for ${name}.\n`,
    );
    return file;
  }

  it('reads a user skill by its absolute path; an unrelated outside read stays re-rooted', async () => {
    const home = tmpRoot('kubic-tui-skill-home-');
    const workspace = tmpRoot('kubic-tui-skill-ws-');
    const skillFile = writeSkill(join(home, '.agents', 'skills'), 'a');
    writeFileSync(join(home, 'secret.txt'), 'top secret\n');
    const faux = fauxProvider({ provider: 'fx', models: [{ id: 'a' }] });
    faux.setResponses([
      fauxToolUse([
        fauxToolCall('read', { path: skillFile }),
        fauxToolCall('read', { path: join(home, 'secret.txt') }),
      ]),
      fauxAssistantMessage('done'),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const boot = await bootTuiLane(undefined, {
      sessionsRoot: tmpRoot(),
      models,
      env: new NodeExecutionEnv(workspace),
      skills: { homeDir: home, cwd: workspace, trusted: false },
    });
    const loop = boot.loop;
    if (loop === undefined) throw new Error('the prod boot returned no loop');
    const turn = await loop.runTurn('load the skill', {
      requestId: 'skill-read',
      context: loop.context,
      whenBusy: 'reject',
    });
    expect(turn.kind).toBe('completed');
    // The durable transcript: tool results are pi.tool-result entries whose
    // one message carries isError and the rendered content.
    const entries = await loop.entries(loop.context);
    await boot.close?.();
    const results = entries
      .filter((entry) => entry.kind === 'pi.tool-result')
      .map((entry) => {
        const message = entry.model?.[0] as
          | { isError?: boolean; content?: unknown }
          | undefined;
        return {
          isError: message?.isError,
          text: JSON.stringify(message?.content ?? []),
        };
      });
    expect(results).toHaveLength(2);
    const skillRead = results.find((r) => r.text.includes('Body for a.'));
    expect(skillRead?.isError, JSON.stringify(results)).toBe(false);
    expect(results.some((r) => r.text.includes('top secret'))).toBe(false);
    expect(results.some((r) => r.text.includes('not_found'))).toBe(true);
  });
});

// A recording terminal, as tui-model-switch-prod.test.ts drives the alt-screen
// key path: the frame text is everything the app wrote.
function fakeTerminal() {
  return terminalRig(240, 30);
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

describe('a refused /model switch is named in the footer and the lane keeps its model', () => {
  it('prints the boot-time refusal text and answers the next prompt on the original model', async () => {
    const cfg = cliConfig({
      [ENTERPRISE]: '[policy]\nallowed_models = ["faux/*"]\n',
      [PROJECT]: '[model]\nprovider = "faux"\nid = "big"\n',
    });
    const models = createModels();
    const faux = fauxProvider({
      provider: 'faux',
      models: [{ id: 'big' }, { id: 'small' }],
    });
    faux.setResponses([fauxAssistantMessage('from faux')]);
    models.setProvider(faux.provider);
    const other = fauxProvider({ provider: 'other', models: [{ id: 'm1' }] });
    other.setResponses([fauxAssistantMessage('from other')]);
    models.setProvider(other.provider);
    const deps = tuiDepsWithDefaults(
      prodTuiDeps(IO, cfg),
      rerooted(tmpRoot(), tmpRoot(), models),
    );
    const fake = fakeTerminal();
    const pending = runTuiCommand(
      {},
      { ...deps, createTerminal: () => fake.terminal },
    );
    await waitFor(() => fake.counts.started === 1);

    for (const ch of '/model other/m1') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() =>
      fake.frame.includes(
        "model switch failed: model 'other/m1' refused by enterprise policy (allowed_models/allowed_providers): no provider call was made",
      ),
    );
    // The lane never moved: the next prompt is answered by the pinned model,
    // and the refused provider was never called.
    for (const ch of 'hello') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.frame.includes('from faux'));
    expect(other.state.callCount).toBe(0);
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
  });
});

describe('a resumed TUI session never keeps a model the enterprise gate refuses', () => {
  it('boots the resumed session on the gated selection, not its stored provider', async () => {
    const workspace = tmpRoot();
    const sessionsRoot = tmpRoot();
    const models = providers([
      { provider: 'faux', models: ['a'] },
      { provider: 'other', models: ['m1'] },
    ]);
    // Session created on `other/m1` (an explicit pin, no policy yet).
    const created = await rerooted(
      workspace,
      sessionsRoot,
      models,
    )(undefined, { model: { provider: 'other', id: 'm1' } });
    await created.close?.();
    expect(created.model).toBe('other/m1');

    // Resumed under an enterprise allowlist that only admits `faux/*`, with
    // no pin: the stored `other/m1` must not survive the gate.
    const cfg = cliConfig({
      [ENTERPRISE]: '[policy]\nallowed_models = ["faux/*"]\n',
    });
    const resumed = await rerooted(
      workspace,
      sessionsRoot,
      models,
    )(created.sessionId, { modelPolicy: cfg.runtime?.policy });
    const loop = resumed.loop;
    if (loop === undefined) throw new Error('the prod boot returned no loop');
    const live = await loop.model?.(loop.context);
    await resumed.close?.();
    expect(live).toBe('faux/a');
    expect(resumed.model).toBe('faux/a');
  });

  it('keeps the stored model when it is allowed (control)', async () => {
    const workspace = tmpRoot();
    const sessionsRoot = tmpRoot();
    const models = providers([
      { provider: 'faux', models: ['a'] },
      { provider: 'other', models: ['m1'] },
    ]);
    const created = await rerooted(
      workspace,
      sessionsRoot,
      models,
    )(undefined, { model: { provider: 'other', id: 'm1' } });
    await created.close?.();
    const cfg = cliConfig({
      [ENTERPRISE]: '[policy]\nallowed_models = ["faux/*", "other/*"]\n',
    });
    const resumed = await rerooted(
      workspace,
      sessionsRoot,
      models,
    )(created.sessionId, { modelPolicy: cfg.runtime?.policy });
    const loop = resumed.loop;
    if (loop === undefined) throw new Error('the prod boot returned no loop');
    const live = await loop.model?.(loop.context);
    await resumed.close?.();
    expect(live).toBe('other/m1');
  });
});
