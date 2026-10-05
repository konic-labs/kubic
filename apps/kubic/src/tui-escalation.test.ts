// The configured escalation ladder on `kubic tui` (issue #210; §38.4):
// a `/model` switch to an off-ladder model refuses by name with the live
// model untouched, an on-ladder climb switches, a down-step refuses
// one-way, and naming the live model still passes. Drives the real
// `bootTuiLane` through the production deps builder with faux providers:
// zero network, zero paid tokens.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import { loadRuntimeConfig } from '../../../packages/host/src/config/runtime.js';
import { NO_PROJECT_TRUST } from '../../../packages/host/src/config/trust-store.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '../../../packages/worker/src/pi-boundary.js';
import type { CliConfigResult } from './config-runtime.js';
import { prodTuiDeps } from './prod-runners.js';
import { bootTuiLane, tuiDepsWithDefaults } from './tui-run.js';

const tempDirs: string[] = [];

function tmpRoot(prefix = 'kubic-tui-escalation-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function twoProviders(): MutableModels {
  const models = createModels();
  for (const entry of [
    { provider: 'local', models: ['a', 'b'] },
    { provider: 'anthropic', models: ['x'] },
  ]) {
    const faux = fauxProvider({
      provider: entry.provider,
      models: entry.models.map((id) => ({ id })),
    });
    faux.setResponses([fauxAssistantMessage('ok')]);
    models.setProvider(faux.provider);
  }
  return models;
}

// The prod boot, re-rooted onto temp state (mirrors tui-scoped-models):
// whatever the production deps builder forwards reaches bootTuiLane.
function rerooted(
  workspace: string,
  sessionsRoot: string,
  models: MutableModels,
): typeof bootTuiLane {
  return (
    sessionId?: string,
    options: Parameters<typeof bootTuiLane>[1] = {},
  ) =>
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

const PROJECT = '/nonexistent-cwd/.kubic/config.toml';

// The effective config exactly as the composition root wraps it (mirrors
// tui-scoped-models): a real `loadRuntimeConfig` over an in-memory project
// layer, so the ladder travels the production path — config file →
// runtimeLaneDeps → bootTuiLane — instead of being hand-injected.
function cliConfig(files: Record<string, string>): CliConfigResult {
  const runtime = loadRuntimeConfig({
    bridge: {
      exists: (path: string): boolean => path in files,
      readTextFile: (path: string): string => files[path] as string,
    },
    home: '/nonexistent-home',
    cwd: '/nonexistent-cwd',
    enterprisePath: '/etc/kubic-test/enterprise.toml',
    productPath: '/nonexistent/product.toml',
    projectTrusted: true,
    env: {},
  });
  if (runtime === undefined) throw new Error('refused test config');
  return {
    runtime,
    error: undefined,
    ignoreSplit: { missing: [], checked: [], applicable: false },
    trust: NO_PROJECT_TRUST,
  };
}

const LADDER =
  '[model]\nprovider = "local"\nid = "a"\n' +
  'escalate = ["local/a", "local/b"]\n';

describe('configured ladder on the TUI lane (issue #210)', () => {
  it('refuses an off-ladder switch, climbs on-ladder, refuses down-steps', async () => {
    const workspace = tmpRoot();
    const cfg = cliConfig({ [PROJECT]: LADDER });
    const deps = tuiDepsWithDefaults(
      prodTuiDeps(IO, cfg),
      rerooted(workspace, tmpRoot(), twoProviders()),
    );
    const boot = await deps.bootLane(undefined, undefined, {});
    const loop = boot.loop;
    if (loop?.switchModel === undefined) {
      throw new Error('the prod boot returned no switchable loop');
    }
    expect(boot.model).toBe('local/a');
    // Off-ladder: refused by name, live model untouched.
    await expect(
      loop.switchModel({ provider: 'anthropic', modelId: 'x' }, loop.context),
    ).rejects.toThrow(/escalation off-ladder refused/);
    expect(await loop.model?.(loop.context)).toBe('local/a');
    // On-ladder: the climb switches the live model.
    await expect(
      loop.switchModel({ provider: 'local', modelId: 'b' }, loop.context),
    ).resolves.toBe('local/b');
    // Down-step: one-way, refused with the live model untouched.
    await expect(
      loop.switchModel({ provider: 'local', modelId: 'a' }, loop.context),
    ).rejects.toThrow(/escalation is one-way/);
    expect(await loop.model?.(loop.context)).toBe('local/b');
    // Naming the live model is a no-op pass, not a refusal.
    await expect(
      loop.switchModel({ provider: 'local', modelId: 'b' }, loop.context),
    ).resolves.toBe('local/b');
    await boot.close?.();
  });

  it('climbs with an explicit reason on the /escalate path', async () => {
    const workspace = tmpRoot();
    const cfg = cliConfig({ [PROJECT]: LADDER });
    const deps = tuiDepsWithDefaults(
      prodTuiDeps(IO, cfg),
      rerooted(workspace, tmpRoot(), twoProviders()),
    );
    const boot = await deps.bootLane(undefined, undefined, {});
    const loop = boot.loop;
    if (loop?.switchModel === undefined) {
      throw new Error('the prod boot returned no switchable loop');
    }
    // The reason rides the same ladder gate as `/model` — the climb
    // resolves (the event naming it is slice 5's assertion).
    await expect(
      loop.switchModel(
        { provider: 'local', modelId: 'b' },
        loop.context,
        'for speed',
      ),
    ).resolves.toBe('local/b');
    await boot.close?.();
  });

  it('refuses the second climb past maxEscalations', async () => {
    const workspace = tmpRoot();
    const cfg = cliConfig({
      [PROJECT]:
        '[model]\nprovider = "local"\nid = "a"\n' +
        'escalate = ["local/a", "local/b", "anthropic/x"]\n' +
        'maxEscalations = 1\n',
    });
    const deps = tuiDepsWithDefaults(
      prodTuiDeps(IO, cfg),
      rerooted(workspace, tmpRoot(), twoProviders()),
    );
    const boot = await deps.bootLane(undefined, undefined, {});
    const loop = boot.loop;
    if (loop?.switchModel === undefined) {
      throw new Error('the prod boot returned no switchable loop');
    }
    await expect(
      loop.switchModel({ provider: 'local', modelId: 'b' }, loop.context),
    ).resolves.toBe('local/b');
    await expect(
      loop.switchModel({ provider: 'anthropic', modelId: 'x' }, loop.context),
    ).rejects.toThrow(/escalation bounded: 1 steps already \(max 1\)/);
    expect(await loop.model?.(loop.context)).toBe('local/b');
    await boot.close?.();
  });
});
