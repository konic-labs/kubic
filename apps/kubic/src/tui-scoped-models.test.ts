// The role's allowed set on `kubic tui`: the boot
// selects in-set, and a `/model` switch outside the set refuses by name
// with the live model untouched. Drives the real `bootTuiLane` through
// the production deps builder with faux providers: zero network, zero
// paid tokens.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { terminalRig } from '../../../test/fake-terminal.js';
import type { CliConfigResult } from './config-runtime.js';
import { prodTuiDeps } from './prod-runners.js';
import { bootTuiLane, runTuiCommand, tuiDepsWithDefaults } from './tui-run.js';

const tempDirs: string[] = [];

function tmpRoot(prefix = 'kubic-tui-scoped-'): string {
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

function writeRole(root: string, name: string): void {
  const dir = join(root, '.kubic', 'roles');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nrole: ${name}\ntools: [read]\n---\n\n# ${name}\n\n## Prompt\n\nReview.\n`,
  );
}

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

// The prod boot, re-rooted onto temp state (mirrors tui-policy-prod):
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

async function waitFor(
  condition: () => boolean,
  deadlineMs = 10_000,
): Promise<void> {
  // Deadline-based: a tick count is a latency assertion in
  // disguise — under contention a fixed poll lapses before the frame
  // lands. A generous deadline only fails a true hang, never a slow
  // scheduler.
  const start = Date.now();
  while (!condition() && Date.now() - start < deadlineMs) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

const PROJECT = '/nonexistent-cwd/.kubic/config.toml';

// The effective config exactly as the composition root wraps it (mirrors
// tui-policy-prod): a real `loadRuntimeConfig` over an in-memory project
// layer, so the role's `models` set travels the production path — config
// file → runtimeLaneDeps layers → bootTuiLane — instead of being
// hand-injected at the boot.
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

describe('scoped role set on the TUI lane', () => {
  it('refuses a /model switch outside the set, keeping the live model', async () => {
    const workspace = tmpRoot();
    writeRole(workspace, 'reviewer');
    const cfg = cliConfig({
      [PROJECT]:
        '[model]\nprovider = "local"\nid = "a"\n' +
        '[roles.reviewer]\nmodels = ["local/*"]\n',
    });
    const deps = tuiDepsWithDefaults(
      prodTuiDeps(IO, cfg),
      rerooted(workspace, tmpRoot(), twoProviders()),
    );
    const boot = await deps.bootLane(undefined, undefined, {
      role: 'reviewer',
    });
    const loop = boot.loop;
    if (loop?.switchModel === undefined) {
      throw new Error('the prod boot returned no switchable loop');
    }
    // Registration order boots local/a — in-set.
    expect(boot.model).toBe('local/a');
    // The resolved set travels on the boot for `/scoped-models`.
    expect(boot.scopedModels).toEqual({
      role: 'reviewer',
      models: [{ id: 'local/*' }],
    });
    await expect(
      loop.switchModel({ provider: 'anthropic', modelId: 'x' }, loop.context),
    ).rejects.toThrow(
      /model 'anthropic\/x' refused: role 'reviewer' allows local\/\* only/,
    );
    // The lane kept the model it had; an in-set switch still works.
    expect(await loop.model?.(loop.context)).toBe('local/a');
    await expect(
      loop.switchModel({ provider: 'local', modelId: 'b' }, loop.context),
    ).resolves.toBe('local/b');
    await boot.close?.();
  });

  it('reports the resolved set through the /scoped-models loop case', async () => {
    // Review (low, carried): the loop case had no loop-level test —
    // only the pure helper and the help count were pinned. Dispatch
    // `/scoped-models` through the real loop (fake terminal, prod boot)
    // and assert the transcript carries the report, scoped and roleless.
    const workspace = tmpRoot();
    writeRole(workspace, 'reviewer');
    const cfg = cliConfig({
      [PROJECT]:
        '[model]\nprovider = "local"\nid = "a"\n' +
        '[roles.reviewer]\nmodels = ["local/*"]\n',
    });
    const deps = tuiDepsWithDefaults(
      prodTuiDeps(IO, cfg),
      rerooted(workspace, tmpRoot(), twoProviders()),
    );
    const fake = terminalRig(100);
    const pending = runTuiCommand(
      { role: 'reviewer' },
      { ...deps, createTerminal: () => fake.terminal, colorLevel: 'none' },
    );
    await waitFor(() => fake.counts.started === 1);
    const run = (command: string): void => {
      fake.feed('\x15');
      for (const ch of command) fake.feed(ch);
      fake.feed('\r');
    };
    run('/scoped-models');
    await waitFor(() =>
      fake.writes.join('').includes("role 'reviewer' allows local/* only"),
    );
    fake.feed('\x03');
    fake.feed('\x03');
    expect(await pending).toBe(0);
  });

  it('reports the allow-all set when the lane has no role', async () => {
    const workspace = tmpRoot();
    const cfg = cliConfig({
      [PROJECT]: '[model]\nprovider = "local"\nid = "a"\n',
    });
    const deps = tuiDepsWithDefaults(
      prodTuiDeps(IO, cfg),
      rerooted(workspace, tmpRoot(), twoProviders()),
    );
    const fake = terminalRig(100);
    const pending = runTuiCommand(
      {},
      { ...deps, createTerminal: () => fake.terminal, colorLevel: 'none' },
    );
    await waitFor(() => fake.counts.started === 1);
    fake.feed('\x15');
    for (const ch of '/scoped-models') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() =>
      fake.writes
        .join('')
        .includes('no role on this lane — every registered model is allowed'),
    );
    fake.feed('\x03');
    fake.feed('\x03');
    expect(await pending).toBe(0);
  });
});
