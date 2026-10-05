// Runtime config load (issue #90; design §35.1/§36/§71) — RED first.
// Every test drives the production entry point (`loadRuntimeConfig`) over
// a fake FileBridge: zero network, zero real files, dummy $ENV_VAR refs.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SOLO_DEFAULTS } from '../../../agents/src/policy.js';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import type { FileBridge } from '../../../exec/src/file-bridge.js';
import { createNodeFileBridge } from '../../../exec/src/file-bridge.js';
import { FileJournalStore } from '../../../exec/src/journal.js';
import {
  ensureRuntimeExcludeRules,
  gitSync,
} from '../../../exec/src/runtime-exclude.js';
import {
  createGitSandbox,
  disposeAllGitSandboxes,
  type GitSandbox,
} from '../../../exec/src/test-support/git-sandbox.js';
import { applyToolPolicy } from '../../../worker/src/lane/policy.js';
import {
  bootFauxLane,
  promptToolsLine,
} from '../../../worker/src/lane/test-harness.js';
import { BACKGROUND_CONTEXT } from '../../../worker/src/pi-boundary.js';
import {
  hasToolPolicy,
  isToolAllowed,
  isToolAllowedByEnterprise,
} from '../policy/enterprise.js';
import {
  BudgetKeyError,
  ConfigError,
  ProjectUntrustedError,
} from './config.js';
import {
  checkWorkspaceIgnoreSplit,
  effectiveConfigView,
  keyEffectFor,
  loadRuntimeConfig,
  RUNTIME_ENV_OVERRIDES,
  RUNTIME_KEY_EFFECTS,
  type RuntimeConfigInputs,
  renderEffectiveConfig,
  runtimeKeyDisposition,
  runtimeKeyEffectText,
} from './runtime.js';

type BridgePick = Pick<FileBridge, 'exists' | 'readTextFile'>;

function fakeBridge(files: Record<string, string>): BridgePick {
  const store = new Map(Object.entries(files));
  return {
    exists: (path: string): boolean => store.has(path),
    readTextFile: (path: string): string => {
      const hit = store.get(path);
      if (hit === undefined) throw new Error(`no such file: ${path}`);
      return hit;
    },
  };
}

const HOME = '/home/u';
const CWD = '/repo';
const GLOBAL = `${HOME}/.kubic/config.toml`;
const PROJECT = `${CWD}/.kubic/config.toml`;

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  driver = undefined;
  disposeAllGitSandboxes();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The test's git driver (issue #420): plain, never injected — production
// reaches git only through the injected gitRunner seam.
let driver: GitSandbox | undefined;

function load(
  files: Record<string, string>,
  overrides: Partial<RuntimeConfigInputs> = {},
) {
  return loadRuntimeConfig({
    bridge: fakeBridge(files),
    home: HOME,
    cwd: CWD,
    ...overrides,
  });
}

describe('runtime config load (issue #90)', () => {
  it('reads the project layer and turns approval route into a live policy', () => {
    const runtime = load(
      {
        [PROJECT]:
          '[approvals]\nroute = "deny"\nautoApprove = ["network"]\nmaxPendingMs = 1500\n',
      },
      { projectTrusted: true },
    );
    expect(runtime.approvals.policy.route).toBe('deny');
    expect(runtime.approvals.policy.maxPendingMs).toBe(1500);
    expect(runtime.approvals.source).toBe('project');
    // Live behaviour, not just "is parsed": the policy is consumable by the
    // approval service (validatePolicy shape) — route deny wins over the
    // host's hard-coded default.
    expect(runtime.approvals.policy.autoApprove).toEqual(['network']);
  });

  it('turns [journal] retentionDays into a live journal age bound', () => {
    const runtime = load(
      { [PROJECT]: '[journal]\nretentionDays = 7\n' },
      {
        projectTrusted: true,
      },
    );
    expect(runtime.journal.retentionDays).toBe(7);
    expect(runtime.journal.maxAgeMs).toBe(7 * 24 * 60 * 60 * 1000);

    // Measurably live: the projection prunes a real store. An entry older
    // than the bound is gone after the append that enforces retention.
    const dir = tempDir('kubic-90-journal-');
    const store = new FileJournalStore(dir, {
      maxAgeMs: runtime.journal.maxAgeMs,
    });
    const dayMs = 24 * 60 * 60 * 1000;
    store.append({
      path: 'a.txt',
      op: 'write',
      before: null,
      after: 'x',
      bytesDelta: 1,
      sessionId: 's1',
      agentId: 'root',
      toolCallId: null,
      timestamp: Date.now() - 30 * dayMs,
    });
    store.append({
      path: 'b.txt',
      op: 'write',
      before: null,
      after: 'y',
      bytesDelta: 1,
      sessionId: 's1',
      agentId: 'root',
      toolCallId: null,
      timestamp: Date.now() - dayMs,
    });
    // Only the entry past the bound is gone; one inside it survives.
    expect(store.entries().map((entry) => entry.path)).toEqual(['b.txt']);

    // No retention key: no age bound is invented (§42.4 opt-in).
    const unbounded = load(
      { [PROJECT]: '[approvals]\nroute = "ask-user"\n' },
      {
        projectTrusted: true,
      },
    );
    expect(unbounded.journal.maxAgeMs).toBeUndefined();
    const keepDir = tempDir('kubic-90-journal-keep-');
    const keep = new FileJournalStore(
      keepDir,
      unbounded.journal.maxAgeMs === undefined
        ? {}
        : { maxAgeMs: unbounded.journal.maxAgeMs },
    );
    keep.append({
      path: 'a.txt',
      op: 'write',
      before: null,
      after: 'x',
      bytesDelta: 1,
      sessionId: 's1',
      agentId: 'root',
      toolCallId: null,
      timestamp: Date.now() - 30 * dayMs,
    });
    expect(keep.entries().length).toBe(1);
  });

  it('projects [journal] outOfScope with its layer, refusing an empty entry by name', () => {
    const runtime = load(
      { [PROJECT]: '[journal]\noutOfScope = ["build", "coverage"]\n' },
      { projectTrusted: true },
    );
    expect(runtime.journal.outOfScope).toEqual(['build', 'coverage']);
    expect(runtime.sources['journal.outOfScope']).toBe('project');
    // `kubic config --json` reports the value with the layer that owns it,
    // both in the flat value list and in the journal projection.
    const view = effectiveConfigView(runtime);
    expect(view.journal.outOfScope).toEqual(['build', 'coverage']);
    expect(view.values).toContainEqual({
      key: 'journal.outOfScope',
      value: '["build", "coverage"]',
      layer: 'project',
      disposition: 'consumed',
    });
    // The key has an observable effect row (docs/cli/configuration.md
    // mirrors it), so it can never quietly stop doing anything.
    const row = RUNTIME_KEY_EFFECTS['journal.outOfScope'];
    expect(row !== undefined && 'effect' in row).toBe(true);
    expect(row !== undefined && 'effect' in row ? row.effect : '').toContain(
      '§42.5',
    );

    // Unset stays undefined — no empty list is invented (§35 opt-in).
    const bare = load(
      { [PROJECT]: '[approvals]\nroute = "ask-user"\n' },
      { projectTrusted: true },
    );
    expect(bare.journal.outOfScope).toBeUndefined();
    expect(effectiveConfigView(bare).journal.outOfScope).toBeUndefined();

    // A file layer refuses the same shapes by name...
    expect(() =>
      load(
        { [PROJECT]: '[journal]\noutOfScope = [""]\n' },
        {
          projectTrusted: true,
        },
      ),
    ).toThrow(/'journal': 'outOfScope' entry 1 is empty/);
    // ...and a programmatic layer bypasses the TOML parser, so the
    // projection re-checks the rule: fail-closed, never half-applied.
    expect(() =>
      loadRuntimeConfig({
        bridge: fakeBridge({}),
        home: HOME,
        cwd: CWD,
        session: { journal: { outOfScope: ['build', ''] } },
      }),
    ).toThrow(/'journal': 'outOfScope' entry 2 is empty/);
  });

  it('feeds permission classes from [permissions], refusing invalid levels', () => {
    const runtime = load(
      {
        [PROJECT]:
          '[permissions]\nfilesystem = "read"\nshell = false\nnetwork = "allowlist"\n',
      },
      { projectTrusted: true },
    );
    expect(runtime.permissions.classes).toEqual({
      ...SOLO_DEFAULTS,
      filesystem: 'read',
      shell: false,
      network: 'allowlist',
    });
    expect(runtime.permissions.source).toBe('project');

    expect(() =>
      load(
        { [PROJECT]: '[permissions]\nfilesystem = "everything"\n' },
        {
          projectTrusted: true,
        },
      ),
    ).toThrow(/invalid filesystem/);
  });

  it('selects provider/model from config and refuses a half-specified pin', () => {
    const runtime = load(
      {
        [GLOBAL]:
          '[model]\nprovider = "local"\nid = "llama3"\nthinking = "high"\n',
      },
      { projectTrusted: true },
    );
    expect(runtime.model).toEqual({
      provider: 'local',
      id: 'llama3',
      thinking: 'high',
    });
    expect(runtime.modelSource).toBe('global');

    expect(() =>
      load(
        { [GLOBAL]: '[model]\nprovider = "local"\n' },
        { projectTrusted: true },
      ),
    ).toThrow(/provider and 'id' must be set together/);
  });

  it('honours precedence: cli > enterprise > env > global > project > workspace > session > agent', () => {
    const files = {
      [GLOBAL]: '[model]\nprovider = "g"\nid = "m"\n',
      [PROJECT]: '[model]\nprovider = "p"\nid = "m"\n',
      '/etc/kubic/config.toml': '[model]\nprovider = "ent"\nid = "m"\n',
    };
    const base = {
      bridge: fakeBridge(files),
      home: HOME,
      cwd: CWD,
      projectTrusted: true,
    };

    // File layers: enterprise freezes every lower attempt; global beats project.
    expect(loadRuntimeConfig(base).model?.provider).toBe('ent');
    const noEnterprise = {
      ...base,
      enterprisePath: '/nonexistent/config.toml',
    };
    expect(loadRuntimeConfig(noEnterprise).model?.provider).toBe('g');
    // env beats the files but never the frozen enterprise layer.
    expect(
      loadRuntimeConfig({
        ...noEnterprise,
        env: { [RUNTIME_ENV_OVERRIDES.model]: 'e/m' },
      }).model?.provider,
    ).toBe('e');
    expect(
      loadRuntimeConfig({
        ...base,
        env: { [RUNTIME_ENV_OVERRIDES.model]: 'e/m' },
      }).model?.provider,
    ).toBe('ent');
    // cli beats every lower layer, but never the frozen enterprise layer.
    expect(
      loadRuntimeConfig({
        ...base,
        cli: { model: { provider: 'cli', id: 'm' } },
      }).model?.provider,
    ).toBe('ent');
    const noEnterpriseCli = {
      ...noEnterprise,
      cli: { model: { provider: 'cli', id: 'm' } },
    };
    expect(loadRuntimeConfig(noEnterpriseCli).model?.provider).toBe('cli');
    expect(loadRuntimeConfig(noEnterpriseCli).sources['model.provider']).toBe(
      'cli',
    );
    // The lower tail: project > workspace > session > agent.
    const tail = (
      files: Record<string, string>,
      extra: Partial<RuntimeConfigInputs>,
    ) =>
      loadRuntimeConfig({
        bridge: fakeBridge(files),
        home: HOME,
        cwd: CWD,
        enterprisePath: '/nonexistent/config.toml',
        projectTrusted: true,
        workspaceRoot: '/ws',
        ...extra,
      }).model?.provider;
    const workspaceFile = '/ws/.kubic/config.toml';
    const session = { model: { provider: 's', id: 'm' } };
    const agent = { model: { provider: 'a', id: 'm' } };
    expect(
      tail(
        {
          [PROJECT]: files[PROJECT],
          [workspaceFile]: '[model]\nprovider = "w"\nid = "m"\n',
        },
        { session, agent },
      ),
    ).toBe('p');
    expect(
      tail(
        { [workspaceFile]: '[model]\nprovider = "w"\nid = "m"\n' },
        { session, agent },
      ),
    ).toBe('w');
    expect(tail({}, { session, agent })).toBe('s');
    expect(tail({}, { agent })).toBe('a');
  });

  it('reports the cli/env model pins a frozen enterprise pin overrode (issue #295)', () => {
    const base = {
      bridge: fakeBridge({
        '/etc/kubic/config.toml': '[model]\nprovider = "ent"\nid = "m"\n',
      }),
      home: HOME,
      cwd: CWD,
      projectTrusted: true,
    };
    // The flag alone: named by its flag spelling, in both the structured
    // field and the attempts `kubic config` prints.
    const cli = loadRuntimeConfig({
      ...base,
      cli: { model: { provider: 'cli', id: 'x' } },
    });
    expect(cli.model).toEqual({ provider: 'ent', id: 'm' });
    expect(cli.modelPinOverrides).toEqual([
      { source: 'cli', requested: 'cli/x', pinned: 'ent/m' },
    ]);
    expect(cli.overriddenAttempts).toEqual([
      "model: --model 'cli/x' rejected: enterprise pin 'ent/m' holds",
    ]);
    // The env pin alone: named by its variable.
    const env = loadRuntimeConfig({
      ...base,
      env: { [RUNTIME_ENV_OVERRIDES.model]: 'e/y' },
    });
    expect(env.modelPinOverrides).toEqual([
      { source: 'env', requested: 'e/y', pinned: 'ent/m' },
    ]);
    expect(env.overriddenAttempts).toEqual([
      "model: KUBIC_MODEL 'e/y' rejected: enterprise pin 'ent/m' holds",
    ]);
    // Both, flag first (the precedence order they would have applied in).
    const both = loadRuntimeConfig({
      ...base,
      cli: { model: { provider: 'cli', id: 'x' } },
      env: { [RUNTIME_ENV_OVERRIDES.model]: 'e/y' },
    });
    expect(both.modelPinOverrides.map((entry) => entry.source)).toEqual([
      'cli',
      'env',
    ]);
    // A pin equal to the enterprise one overrode nothing.
    expect(
      loadRuntimeConfig({
        ...base,
        cli: { model: { provider: 'ent', id: 'm' } },
        env: { [RUNTIME_ENV_OVERRIDES.model]: 'ent/m' },
      }).modelPinOverrides,
    ).toEqual([]);
    // No cli/env pin: nothing to report.
    expect(loadRuntimeConfig(base).modelPinOverrides).toEqual([]);
    expect(loadRuntimeConfig(base).overriddenAttempts).toEqual([]);
    // No freeze (a non-enterprise layer set the pin): the flag simply wins.
    const free = loadRuntimeConfig({
      bridge: fakeBridge({ [GLOBAL]: '[model]\nprovider = "g"\nid = "m"\n' }),
      home: HOME,
      cwd: CWD,
      enterprisePath: '/nonexistent/config.toml',
      projectTrusted: true,
      // The env pin under the flag is the ordinary precedence order, not an
      // enterprise override: nothing is reported without a freeze.
      env: { [RUNTIME_ENV_OVERRIDES.model]: 'e/y' },
      cli: { model: { provider: 'cli', id: 'x' } },
    });
    expect(free.model?.provider).toBe('cli');
    expect(free.modelPinOverrides).toEqual([]);
    expect(free.overriddenAttempts).toEqual([]);
  });

  it('reports the override attempts it refused to apply', () => {
    const runtime = load(
      {
        [GLOBAL]: '[journal]\nretentionDays = 30\n',
        [PROJECT]: '[journal]\nretentionDays = 7\n',
      },
      { projectTrusted: true },
    );
    expect(runtime.journal.retentionDays).toBe(30);
    expect(runtime.overriddenAttempts).toContain('journal.retentionDays');
  });

  it('refuses a distrusted project layer by name, before reading it', () => {
    try {
      load({ [PROJECT]: 'garbage [[[\n' }, { projectTrusted: false });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectUntrustedError);
      expect((error as Error).message).toContain(PROJECT);
    }
  });

  it('fails closed on unknown keys with the offending layer named', () => {
    try {
      load(
        { [GLOBAL]: '[telemetry]\nenabled = true\n' },
        { projectTrusted: true },
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toMatch(
        /layer 'global'.*unknown section '\[telemetry\]'/,
      );
    }
  });

  it('fails closed on budget keys instead of inventing a limit (§71)', () => {
    expect(() =>
      load(
        { [GLOBAL]: '[budgets]\nmaxCostUsd = 1\n' },
        { projectTrusted: true },
      ),
    ).toThrow(BudgetKeyError);
    const runtime = load({}, { projectTrusted: true });
    expect(runtime.budgets.configured).toBe(false);
    expect(runtime.budgets.detail).toMatch(/no budgets are defaulted/i);
  });

  it('refuses secret refs in config (§36: secrets live in models.json)', () => {
    expect(() =>
      load(
        { [GLOBAL]: '[model]\nprovider = "$SECRET_PROVIDER"\nid = "m"\n' },
        {
          projectTrusted: true,
        },
      ),
    ).toThrow(/secrets never appear in config/);
    expect(() =>
      load(
        { [GLOBAL]: '[ui]\ntheme = "!op read token"\n' },
        { projectTrusted: true },
      ),
    ).toThrow(/secrets never appear in config/);
  });

  it('refuses contradictory modes, never silently picking one', () => {
    expect(() =>
      load(
        { [GLOBAL]: '[modes]\nsolo = true\norchestrator = true\n' },
        {
          projectTrusted: true,
        },
      ),
    ).toThrow(/modes: at most one/);
    const runtime = load(
      { [GLOBAL]: '[modes]\norchestrator = true\n' },
      {
        projectTrusted: true,
      },
    );
    expect(runtime.modes).toMatchObject({
      solo: false,
      orchestrator: true,
      source: 'global',
    });
    // Absent modes: the documented defaults, sourced as defaults.
    expect(load({}, { projectTrusted: true }).modes).toEqual({
      solo: true,
      orchestrator: false,
      source: 'defaults',
    });
  });

  it('applies documented env overrides, refusing malformed values', () => {
    const env = {
      [RUNTIME_ENV_OVERRIDES.model]: 'local/llama3',
      [RUNTIME_ENV_OVERRIDES.approvalsRoute]: 'deny',
      [RUNTIME_ENV_OVERRIDES.journalRetentionDays]: '3',
      [RUNTIME_ENV_OVERRIDES.modelThinking]: 'low',
    };
    const runtime = load({}, { projectTrusted: true, env });
    expect(runtime.model).toEqual({
      provider: 'local',
      id: 'llama3',
      thinking: 'low',
    });
    expect(runtime.approvals.policy.route).toBe('deny');
    expect(runtime.journal.retentionDays).toBe(3);
    expect(runtime.sources['approvals.route']).toBe('env');

    expect(() =>
      load(
        {},
        {
          projectTrusted: true,
          env: { [RUNTIME_ENV_OVERRIDES.model]: 'llama3' },
        },
      ),
    ).toThrow(/'provider\/id'/);
    expect(() =>
      load(
        {},
        {
          projectTrusted: true,
          env: { [RUNTIME_ENV_OVERRIDES.approvalsRoute]: 'auto' },
        },
      ),
    ).toThrow(/must be 'ask-user' or 'deny'/);
    expect(() =>
      load(
        {},
        {
          projectTrusted: true,
          env: { [RUNTIME_ENV_OVERRIDES.journalRetentionDays]: 'x' },
        },
      ),
    ).toThrow(/non-negative integer/);
  });

  it('lets KUBIC_TRUST_PROJECT opt the project layer in, and records it', () => {
    const runtime = load(
      { [PROJECT]: '[journal]\nretentionDays = 5\n' },
      { env: { [RUNTIME_ENV_OVERRIDES.trustProject]: '1' } },
    );
    expect(runtime.projectTrusted).toBe(true);
    expect(runtime.journal.retentionDays).toBe(5);
    expect(runtime.layers.find((l) => l.layer === 'project')).toMatchObject({
      present: true,
      trusted: true,
    });
    // Anything other than an explicit truthy value stays distrusted.
    expect(() =>
      load(
        { [PROJECT]: '[journal]\nretentionDays = 5\n' },
        {
          env: { [RUNTIME_ENV_OVERRIDES.trustProject]: 'yes' },
        },
      ),
    ).toThrow(ProjectUntrustedError);
  });
});

describe('thinking level load (issue #225; §38.3)', () => {
  const MODEL_HIGH =
    '[model]\nprovider = "local"\nid = "llama3"\nthinking = "high"\n';

  it('resolves --thinking > env > file, and the pin carries it', () => {
    const file = load({ [PROJECT]: MODEL_HIGH }, { projectTrusted: true });
    expect(file.thinking).toEqual({ level: 'high', source: 'project' });
    expect(file.model).toMatchObject({ thinking: 'high' });

    const env = load(
      { [PROJECT]: MODEL_HIGH },
      {
        projectTrusted: true,
        env: { [RUNTIME_ENV_OVERRIDES.modelThinking]: 'low' },
      },
    );
    expect(env.thinking).toEqual({ level: 'low', source: 'env' });
    expect(env.model).toMatchObject({
      provider: 'local',
      id: 'llama3',
      thinking: 'low',
    });

    const cli = load(
      { [PROJECT]: MODEL_HIGH },
      {
        projectTrusted: true,
        env: { [RUNTIME_ENV_OVERRIDES.modelThinking]: 'low' },
        cli: { thinking: 'minimal' },
      },
    );
    expect(cli.thinking).toEqual({ level: 'minimal', source: 'cli' });
    expect(cli.model).toMatchObject({ thinking: 'minimal' });
  });

  it('keeps an env-only level without inventing a model pin', () => {
    const runtime = load(
      {},
      {
        projectTrusted: true,
        env: { [RUNTIME_ENV_OVERRIDES.modelThinking]: 'low' },
      },
    );
    expect(runtime.model).toBeUndefined();
    expect(runtime.thinking).toEqual({ level: 'low', source: 'env' });
  });

  it('refuses a malformed env value fail-closed, naming the variable', () => {
    expect(() =>
      load(
        {},
        {
          projectTrusted: true,
          env: { [RUNTIME_ENV_OVERRIDES.modelThinking]: 'banana' },
        },
      ),
    ).toThrow(/KUBIC_MODEL_THINKING.*banana/);
  });

  it('refuses a malformed --thinking value fail-closed, naming the flag', () => {
    expect(() =>
      load({}, { projectTrusted: true, cli: { thinking: 'banana' } }),
    ).toThrow(/--thinking.*banana/);
  });

  it('freezes an enterprise level against the flag; the env override is not applied', () => {
    const files = {
      '/etc/kubic/config.toml': MODEL_HIGH,
      [PROJECT]: '[model]\nprovider = "local"\nid = "llama3"\n',
    };
    const frozen = load(files, { projectTrusted: true });
    expect(frozen.thinking).toEqual({ level: 'high', source: 'enterprise' });
    expect(() =>
      load(files, { projectTrusted: true, cli: { thinking: 'low' } }),
    ).toThrow(/--thinking.*frozen by the enterprise layer/);
    const envIgnored = load(files, {
      projectTrusted: true,
      env: { [RUNTIME_ENV_OVERRIDES.modelThinking]: 'low' },
    });
    expect(envIgnored.thinking).toEqual({
      level: 'high',
      source: 'enterprise',
    });
  });

  it('names --thinking (not --model) as the per-run override', () => {
    const text = runtimeKeyEffectText(RUNTIME_KEY_EFFECTS['model.thinking']);
    expect(text).toContain('--thinking');
    expect(text).not.toContain('--model');
  });
});

describe('effective config view (issue #90)', () => {
  it('reports every value with the layer it came from, machine-readable', () => {
    const runtime = load(
      {
        [GLOBAL]: '[model]\nprovider = "local"\nid = "llama3"\n',
        [PROJECT]: '[journal]\nretentionDays = 7\n',
      },
      { projectTrusted: true },
    );
    const view = effectiveConfigView(runtime);
    expect(view.values).toEqual(
      expect.arrayContaining([
        {
          key: 'model.provider',
          value: '"local"',
          layer: 'global',
          disposition: 'consumed',
        },
        {
          key: 'journal.retentionDays',
          value: '7',
          layer: 'project',
          disposition: 'consumed',
        },
      ]),
    );
    expect(view.budgets.configured).toBe(false);
    expect(view.projectTrusted).toBe(true);
    // Every documented key with an observable effect is listed for the docs
    // test — the view and the docs share one list, never two.
    expect(Object.keys(RUNTIME_KEY_EFFECTS).length).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(view)).values.length).toBe(
      view.values.length,
    );
  });

  it('turns [session] compaction keys into a live lane projection (issue #239)', () => {
    const runtime = load(
      {
        [PROJECT]:
          '[session]\nautoCompact = false\nreserveTokens = 4000\nkeepRecentTokens = 5000\n',
      },
      { projectTrusted: true },
    );
    expect(runtime.compaction).toEqual({
      enabled: false,
      reserveTokens: 4000,
      keepRecentTokens: 5000,
      source: 'project',
    });
    // The effective view default-fills for display: the report names the
    // values the lane will run with, and the render line states the clamp.
    const view = effectiveConfigView(runtime);
    expect(view.compaction).toEqual({
      enabled: false,
      reserveTokens: 4000,
      keepRecentTokens: 5000,
      source: 'project',
    });
    expect(
      view.values.find((v) => v.key === 'session.reserveTokens'),
    ).toMatchObject({
      value: '4000',
      layer: 'project',
      disposition: 'consumed',
    });
    const lines = renderEffectiveConfig(view);
    expect(lines.some((line) => line.includes('reserve=4000 token(s)'))).toBe(
      true,
    );
  });

  it('reports the highest-precedence contributing layer for split compaction keys (issue #239 review)', () => {
    // autoCompact from project, reserveTokens from global: the old
    // first-set-key rule named 'project' (autoCompact sorts first in key
    // order); the provenance must name 'global' — the
    // highest-precedence layer that contributed a key.
    const runtime = load(
      {
        [GLOBAL]: '[session]\nreserveTokens = 4000\n',
        [PROJECT]: '[session]\nautoCompact = false\n',
      },
      { projectTrusted: true },
    );
    expect(runtime.compaction).toEqual({
      enabled: false,
      reserveTokens: 4000,
      source: 'global',
    });
  });

  it('reports compaction defaults when nothing is configured (issue #239)', () => {
    const runtime = load({});
    expect(runtime.compaction).toEqual({ source: 'defaults' });
    const view = effectiveConfigView(runtime);
    expect(view.compaction).toEqual({
      enabled: true,
      reserveTokens: 16384,
      keepRecentTokens: 20000,
      source: 'defaults',
    });
    const lines = renderEffectiveConfig(view);
    expect(lines.some((line) => line.includes('reserve=16384 token(s)'))).toBe(
      true,
    );
  });

  it('re-validates session compaction for the programmatic layers (issue #239)', () => {
    // The session/agent layers never pass through the TOML parser: a bad
    // value there is refused by name, never carried to the lane.
    expect(() =>
      loadRuntimeConfig({
        bridge: fakeBridge({}),
        home: HOME,
        cwd: CWD,
        session: { session: { reserveTokens: 0 } },
      }),
    ).toThrow(/'session': 'reserveTokens' must be a positive integer/);
    expect(() =>
      loadRuntimeConfig({
        bridge: fakeBridge({}),
        home: HOME,
        cwd: CWD,
        agent: { session: { autoCompact: 'yes' as unknown as boolean } },
      }),
    ).toThrow(/'session': 'autoCompact' must be a boolean/);
  });

  it('resolves [agent] systemPromptFile against the declaring layer (issue #240)', () => {
    const runtime = load(
      {
        [GLOBAL]: '[agent]\nsystemPromptFile = "SYSTEM.md"\n',
        [`${HOME}/.kubic/SYSTEM.md`]: 'Be terse.\n',
      },
      { projectTrusted: true },
    );
    // The contents travel in the runtime; the report names the path.
    expect(runtime.systemPromptFile).toEqual({
      path: `${HOME}/.kubic/SYSTEM.md`,
      contents: 'Be terse.\n',
      source: 'global',
    });
    const view = effectiveConfigView(runtime);
    expect(
      view.values.find((v) => v.key === 'agent.systemPromptFile'),
    ).toMatchObject({
      // formatValue quotes: the effective (resolved) path, reported.
      value: `"${HOME}/.kubic/SYSTEM.md"`,
      layer: 'global',
      disposition: 'consumed',
    });
    const lines = renderEffectiveConfig(view);
    expect(
      lines.some((line) =>
        line.includes(
          `agent.systemPromptFile = "${HOME}/.kubic/SYSTEM.md" (global, consumed)`,
        ),
      ),
    ).toBe(true);
    // The path reports; the contents never do.
    expect(lines.join('\n')).not.toContain('Be terse.');
    expect(keyEffectFor('agent.systemPromptFile')).toBe(
      RUNTIME_KEY_EFFECTS['agent.systemPromptFile'],
    );
  });

  it('expands a leading ~/ against home (issue #240)', () => {
    const runtime = load(
      {
        [GLOBAL]: '[agent]\nsystemPromptFile = "~/prompts/sys.md"\n',
        [`${HOME}/prompts/sys.md`]: 'Tilde.\n',
      },
      { projectTrusted: true },
    );
    expect(runtime.systemPromptFile?.path).toBe(`${HOME}/prompts/sys.md`);
    expect(runtime.systemPromptFile?.contents).toBe('Tilde.\n');
  });

  it('contains the project layer to the project root (issue #240)', () => {
    const inside = load(
      {
        [PROJECT]: '[agent]\nsystemPromptFile = "docs/SYSTEM.md"\n',
        [`${CWD}/.kubic/docs/SYSTEM.md`]: 'Inside.\n',
      },
      { projectTrusted: true },
    );
    expect(inside.systemPromptFile?.path).toBe(`${CWD}/.kubic/docs/SYSTEM.md`);
    // A trusted absolute path outside the root is refused by name.
    expect(() =>
      load(
        { [PROJECT]: '[agent]\nsystemPromptFile = "/tmp/evil.md"\n' },
        { projectTrusted: true },
      ),
    ).toThrow(
      /'agent': 'systemPromptFile' '\/tmp\/evil.md' is outside the project root/,
    );
    // So is a relative path that escapes it.
    expect(() =>
      load(
        {
          [PROJECT]: '[agent]\nsystemPromptFile = "../../evil.md"\n',
        },
        { projectTrusted: true },
      ),
    ).toThrow(/is outside the project root/);
  });

  it('refuses an untrusted project file pre-trust and a missing file by name (issue #240)', () => {
    // The trust gate fires before any project file is read: the refusal
    // names trust, never the file.
    expect(() =>
      load({
        [PROJECT]: '[agent]\nsystemPromptFile = "SYSTEM.md"\n',
        [`${CWD}/.kubic/SYSTEM.md`]: 'Untrusted.\n',
      }),
    ).toThrow(ProjectUntrustedError);
    expect(() =>
      load({
        [GLOBAL]: '[agent]\nsystemPromptFile = "MISSING.md"\n',
      }),
    ).toThrow(
      /'agent': 'systemPromptFile' '.*MISSING.md' (does not exist|cannot be read)/,
    );
  });

  it('re-validates the programmatic layers and refuses relative paths without a declaring file (issue #240)', () => {
    expect(() =>
      loadRuntimeConfig({
        bridge: fakeBridge({}),
        home: HOME,
        cwd: CWD,
        session: { agent: { systemPromptFile: 42 as unknown as string } },
      }),
    ).toThrow(/'agent': 'systemPromptFile' must be a non-empty string/);
    // Session/agent layers are never files: a relative path has no
    // directory to resolve against, so it is refused, never guessed.
    expect(() =>
      loadRuntimeConfig({
        bridge: fakeBridge({}),
        home: HOME,
        cwd: CWD,
        agent: { agent: { systemPromptFile: 'REL.md' } },
      }),
    ).toThrow(/no declaring config file/);
  });

  it('renders the same view for humans', () => {
    const runtime = load(
      { [GLOBAL]: '[model]\nprovider = "local"\nid = "llama3"\n' },
      { projectTrusted: true },
    );
    const lines = renderEffectiveConfig(effectiveConfigView(runtime));
    expect(
      lines.some((line) => line.includes('model.provider = "local" (global,')),
    ).toBe(true);
    expect(lines.some((line) => line.includes('budgets'))).toBe(true);
  });

  it('distinguishes consumed, kept and pending keys (issue #133)', () => {
    expect(runtimeKeyDisposition({ effect: 'x' })).toBe('consumed');
    expect(runtimeKeyDisposition({ kept: 'x' })).toBe('kept');
    expect(runtimeKeyDisposition({ notYetImplemented: 'x' })).toBe('pending');
    // No effect row at all is its own state: config-doctor flags it by name.
    expect(runtimeKeyDisposition(undefined)).toBe('unknown');
    // The lookup is section-or-key, the same rule the docs test uses.
    expect(keyEffectFor('roles.implementer.model')).toBe(
      RUNTIME_KEY_EFFECTS.roles,
    );
    expect(keyEffectFor('agent.name')).toBe(RUNTIME_KEY_EFFECTS['agent.name']);
    expect(keyEffectFor('telemetry.endpoint')).toBeUndefined();
  });

  it('renders the disposition on every effective value (issue #133)', () => {
    const runtime = load(
      {
        [PROJECT]:
          '[agent]\nname = "kubic"\n[ui]\ntheme = "dark"\nstatusBar = true\n',
      },
      { projectTrusted: true },
    );
    const view = effectiveConfigView(runtime);
    expect(view.values.find((v) => v.key === 'agent.name')?.disposition).toBe(
      'consumed',
    );
    // Issue #304: `ui.theme` is consumed (the TUI resolves it before the
    // alt-screen opens); `ui.statusBar` stays kept.
    expect(view.values.find((v) => v.key === 'ui.theme')?.disposition).toBe(
      'consumed',
    );
    expect(view.values.find((v) => v.key === 'ui.statusBar')?.disposition).toBe(
      'kept',
    );
    const lines = renderEffectiveConfig(view);
    expect(
      lines.some((line) =>
        line.includes('agent.name = "kubic" (project, consumed)'),
      ),
    ).toBe(true);
    expect(
      lines.some((line) =>
        line.includes('ui.theme = "dark" (project, consumed)'),
      ),
    ).toBe(true);
    expect(
      lines.some((line) =>
        line.includes('ui.statusBar = true (project, kept)'),
      ),
    ).toBe(true);
    // One summary line states the split, so a reader sees it before the list.
    expect(
      lines.some(
        (line) =>
          line.includes('effects:') &&
          line.includes('consumed') &&
          line.includes('kept'),
      ),
    ).toBe(true);
  });

  it('names no issue in any key-effect annotation (the #133 acceptance gate)', () => {
    // The annotations are decisions or named follow-ups. A closed-issue
    // pointer is exactly what this table must never carry again, so the pin
    // is stronger than the gate: no issue number at all.
    for (const [key, entry] of Object.entries(RUNTIME_KEY_EFFECTS)) {
      expect(runtimeKeyEffectText(entry), key).not.toMatch(/#\d+/);
    }
  });

  it('never renders a secret-shaped config value verbatim', () => {
    const runtime = loadRuntimeConfig({
      bridge: fakeBridge({}),
      home: HOME,
      cwd: CWD,
      projectTrusted: true,
      session: { ui: { theme: 'sk-live-abcdef1234567890' } },
    });
    const rendered = renderEffectiveConfig(effectiveConfigView(runtime)).join(
      '\n',
    );
    expect(rendered).not.toContain('sk-live-abcdef1234567890');
    // Redacted, not dropped: the key still renders, with a marker.
    expect(rendered).toContain('ui.theme = "[redacted-secret]"');
  });

  // The acceptance criterion's own bar: a .kubic/config.toml value must
  // measurably change a live behaviour, not merely parse. This drives the
  // real solo lane (through the shared faux harness factory, #401) with the
  // classes the config produced and asserts the lane's own allowlist — the
  // same set applyToolPolicy installs.
  it('narrows a live lane allowlist from [permissions] in config', async () => {
    const runtime = load(
      {
        [PROJECT]:
          '[permissions]\nfilesystem = "read"\nshell = false\ngit = false\nnetwork = "none"\n',
      },
      { projectTrusted: true },
    );
    const lane = await bootFauxLane({
      env: new FakeExecutionEnv({}),
      policy: { classes: runtime.permissions.classes },
    });
    try {
      const allowed = await applyToolPolicy(
        lane.solo.registry,
        lane.solo.conversation,
        runtime.permissions.classes,
        BACKGROUND_CONTEXT,
      );
      expect(allowed.sort()).toEqual(['find', 'grep', 'ls', 'read']);
      const active = await lane.activeTools();
      expect(active).not.toContain('bash');
      expect(active).not.toContain('write');
    } finally {
      await lane.cleanup();
    }
  });
});

describe('§37.4 request options reach the effective view (issue #257)', () => {
  it('marks the [model] tuning consumed with its layer', () => {
    const runtime = load(
      {
        [PROJECT]:
          '[model]\nprovider = "local"\nid = "llama3"\ntimeoutMs = 60000\nmaxRetries = 5\nmaxRetryDelayMs = 10000\ncacheRetention = "long"\n',
      },
      { projectTrusted: true },
    );
    for (const key of [
      'model.timeoutMs',
      'model.maxRetries',
      'model.maxRetryDelayMs',
      'model.cacheRetention',
    ]) {
      expect(keyEffectFor(key), key).toBe(RUNTIME_KEY_EFFECTS[key]);
      expect(runtimeKeyDisposition(keyEffectFor(key)), key).toBe('consumed');
    }
    const view = effectiveConfigView(runtime);
    expect(view.values.find((v) => v.key === 'model.timeoutMs')).toMatchObject({
      value: '60000',
      layer: 'project',
      disposition: 'consumed',
    });
    expect(
      view.values.find((v) => v.key === 'model.cacheRetention'),
    ).toMatchObject({
      value: '"long"',
      layer: 'project',
      disposition: 'consumed',
    });
    // A role table's tuning resolves through the `roles` section row — the
    // same section-or-key rule `roles.<name>.model` already follows.
    expect(keyEffectFor('roles.a.maxRetries')).toBe(RUNTIME_KEY_EFFECTS.roles);
  });
});

describe('enterprise [policy] on the live path (issue #288)', () => {
  const ENTERPRISE = '/etc/kubic/config.toml';
  const PRODUCT = '/etc/kubic/product.toml';
  const GLOBAL = `${HOME}/.kubic/config.toml`;

  const S58_EXAMPLE = `[policy]
allowed_models = ["claude-sonnet-4-6", "local/*"]
allowed_providers = ["anthropic", "local"]
allowed_tools = ["read", "grep", "find", "ls", "bash", "edit", "write", "git_diff"]
denied_tools = ["network_fetch"]

network_policy = "proxy"
allowed_domains = ["registry.npmjs.org", "github.com"]

filesystem_policy = "workspace-only"
require_credential_broker = true
deny_local_credentials = true

data_policy = "no-external-training"
logging_policy = "full-audit"
agent_policy = { max_agents = 2, max_cost_usd = 5.0 }

[[audit]]
sink = "syslog"
level = "privileged"
`;

  it('loads the §58 example as the enterprise layer and resolves it', () => {
    const runtime = load({ [ENTERPRISE]: S58_EXAMPLE });
    expect(runtime.policy.tools.deny).toEqual(['network_fetch']);
    expect(runtime.policy.tools.allow).toContain('bash');
    expect(runtime.policy.models.allowed).toEqual([
      'claude-sonnet-4-6',
      'local/*',
    ]);
    expect(runtime.policy.models.providers).toEqual(['anthropic', 'local']);
    // 'proxy' is carried as the engine's allowlist mode; workspace-only as
    // workspace-write. Both reconciliations are documented in design-drift.
    expect(runtime.policy.network.mode).toBe('allowlist');
    expect(runtime.policy.filesystem.level).toBe('workspace-write');
    expect(runtime.policy.credentials.requireCredentialBroker).toBe(true);
    expect(runtime.policy.agent).toEqual({ maxWorkers: 2, maxCostUsd: 5 });
    // Every policy key has an effect row: the effective view never reports
    // the documented surface as decoration.
    const view = effectiveConfigView(runtime);
    const policyValues = view.values.filter((entry) =>
      entry.key.startsWith('policy.'),
    );
    expect(policyValues.length).toBeGreaterThan(0);
    expect(policyValues.every((entry) => entry.disposition !== 'unknown')).toBe(
      true,
    );
  });

  it('refuses an unknown [policy] key as the enterprise layer, naming the key and layer', () => {
    expect(() => load({ [ENTERPRISE]: '[policy]\nbogus_key = 1\n' })).toThrow(
      /layer 'enterprise':.*unknown key 'bogus_key'/,
    );
  });

  it('pins enterprise > product > global > project > session, denying downward only', () => {
    const runtime = load(
      {
        [ENTERPRISE]: '[policy]\ndenied_tools = ["bash"]\n',
        [PRODUCT]: '[policy]\nallowed_tools = ["bash", "read"]\n',
        [GLOBAL]: '[policy]\nallowed_tools = ["bash", "read", "write"]\n',
        [PROJECT]: '[policy]\nallowed_tools = ["bash"]\n',
      },
      {
        projectTrusted: true,
        session: { policy: { allowedTools: ['bash'] } },
      },
    );
    // The product layer is the first to set the allow list; global, project
    // and session narrower/wider attempts are reported, never applied.
    expect(runtime.policy.tools.allowSource).toBe('product');
    expect(runtime.policy.tools.denySources).toEqual({ bash: 'enterprise' });
    // The enterprise deny holds against every lower layer...
    expect(isToolAllowed(runtime.policy, 'bash')).toBe(false);
    // ...the product allow still admits what it names, and no lower layer
    // can add a tool the product did not allow (write is dropped).
    expect(isToolAllowed(runtime.policy, 'read')).toBe(true);
    expect(isToolAllowed(runtime.policy, 'write')).toBe(false);
  });

  it('narrows a live lane from an enterprise tool deny (active tools and prompt tools line)', async () => {
    const runtime = load(
      {
        [ENTERPRISE]: '[policy]\ndenied_tools = ["bash"]\n',
        [PROJECT]: '[permissions]\nshell = true\n',
      },
      { projectTrusted: true },
    );
    const lane = await bootFauxLane({
      env: new FakeExecutionEnv({}),
      policy: {
        classes: runtime.permissions.classes,
        toolAllowed: (tool) => isToolAllowedByEnterprise(runtime.policy, tool),
      },
    });
    try {
      // The class-derived allowlist would include bash (shell=true); the
      // enterprise deny removes it from what the lane actually activates.
      const active = await lane.activeTools();
      expect(active).not.toContain('bash');
      expect(active).toContain('read');
      // The prompt tells the model the truth about its own tool set (§40.3);
      // the committed system entry carries the assembled solo prompt.
      await lane.run('hi');
      const advertised = promptToolsLine(await lane.systemPrompt());
      expect(advertised).not.toContain('bash');
      expect(advertised).toContain('read');
    } finally {
      await lane.cleanup();
    }
  });

  it('leaves a lane without an enterprise tool policy untouched (control)', async () => {
    const runtime = load(
      { [PROJECT]: '[permissions]\nshell = true\n' },
      { projectTrusted: true },
    );
    const lane = await bootFauxLane({
      env: new FakeExecutionEnv({}),
      policy: {
        classes: runtime.permissions.classes,
        ...(hasToolPolicy(runtime.policy)
          ? {
              toolAllowed: (tool: string) =>
                isToolAllowedByEnterprise(runtime.policy, tool),
            }
          : {}),
      },
    });
    try {
      const active = await lane.activeTools();
      expect(active).toContain('bash');
    } finally {
      await lane.cleanup();
    }
  });
});

describe('orchestrator config projections (issue #133)', () => {
  it('projects [orchestrator] root + maxWorkers, refusing escapes by name', () => {
    const runtime = load(
      {
        [PROJECT]:
          '[orchestrator]\nroot = ".kubic-custom/wt"\nmaxWorkers = 7\n',
      },
      { projectTrusted: true },
    );
    expect(runtime.orchestrator).toEqual({
      root: '.kubic-custom/wt',
      maxWorkers: 7,
    });
    expect(runtime.sources['orchestrator.root']).toBe('project');
    expect(runtime.sources['orchestrator.maxWorkers']).toBe('project');

    // Unset stays unset — no root and no cap are invented (§35 opt-in).
    const bare = load(
      { [PROJECT]: '[approvals]\nroute = "ask-user"\n' },
      { projectTrusted: true },
    );
    expect(bare.orchestrator).toEqual({});

    // Issue #431 (L-D34): the delegation driver projects through, default
    // template (absent, never invented).
    const lane = load(
      { [PROJECT]: '[orchestrator]\nmanager = "lane"\n' },
      { projectTrusted: true },
    );
    expect(lane.orchestrator).toEqual({ manager: 'lane' });
    expect(lane.sources['orchestrator.manager']).toBe('project');

    // An absolute root or a `..` segment is refused at load, by name: the
    // value is a workspace-relative parent, never a path that escapes.
    expect(() =>
      load(
        { [PROJECT]: '[orchestrator]\nroot = "../escape"\n' },
        { projectTrusted: true },
      ),
    ).toThrow(/'orchestrator': 'root' must be a workspace-relative path/);
    expect(() =>
      load(
        { [PROJECT]: '[orchestrator]\nroot = "/abs/wt"\n' },
        { projectTrusted: true },
      ),
    ).toThrow(/'orchestrator': 'root' must be a workspace-relative path/);
    // Programmatic session/agent layers bypass the TOML parser: the
    // projection re-checks the same rule, fail-closed.
    expect(() =>
      loadRuntimeConfig({
        bridge: fakeBridge({}),
        home: HOME,
        cwd: CWD,
        projectTrusted: true,
        session: { orchestrator: { root: 'a/../b' } },
      }),
    ).toThrow(/'orchestrator': 'root' must be a workspace-relative path/);

    // §45: the cap is a positive integer. A value that could never admit a
    // worker is refused at load, by name — never clamped into one silently.
    expect(() =>
      load(
        { [PROJECT]: '[orchestrator]\nmaxWorkers = 0\n' },
        { projectTrusted: true },
      ),
    ).toThrow(/'orchestrator': 'maxWorkers' must be a positive integer/);
    expect(() =>
      load(
        { [PROJECT]: '[orchestrator]\nmaxWorkers = 1.5\n' },
        { projectTrusted: true },
      ),
    ).toThrow(/'orchestrator': 'maxWorkers' must be a positive integer/);
  });

  it('refuses control characters and committed-half roots at load, by name (issue #133 review)', () => {
    // The root becomes a git exclude entry verbatim: a newline would inject
    // arbitrary patterns, so it is refused before the value can travel.
    expect(() =>
      load(
        { [PROJECT]: '[orchestrator]\nroot = "x\\n*.log\\n!keep"\n' },
        { projectTrusted: true },
      ),
    ).toThrow(/control characters are refused/);
    // Programmatic session/agent layers bypass the TOML parser: the
    // projection re-checks the same rule, fail-closed.
    expect(() =>
      loadRuntimeConfig({
        bridge: fakeBridge({}),
        home: HOME,
        cwd: CWD,
        projectTrusted: true,
        session: { orchestrator: { root: 'wt\u001b[31m' } },
      }),
    ).toThrow(/control characters are refused/);
    // D35: a root whose exclude entry would ignore `.kubic/config.toml` /
    // `.kubic/roles/*.md` is refused, by name — including via the
    // programmatic layers.
    expect(() =>
      load(
        { [PROJECT]: '[orchestrator]\nroot = ".kubic"\n' },
        { projectTrusted: true },
      ),
    ).toThrow(/committed config half/);
    expect(() =>
      loadRuntimeConfig({
        bridge: fakeBridge({}),
        home: HOME,
        cwd: CWD,
        projectTrusted: true,
        session: { orchestrator: { root: '.kubic/roles' } },
      }),
    ).toThrow(/committed config half/);
    // Case variants of the committed half (issue #133 fix-cycle-3): git
    // folds ignore patterns on a case-insensitive filesystem, so `.KUBIC/`
    // hides exactly the same files — refused through the programmatic
    // layers too, by the same name.
    for (const root of ['.KUBIC', '.Kubic', '.KUBIC/roles', '.kubic/ROLES']) {
      expect(
        () =>
          loadRuntimeConfig({
            bridge: fakeBridge({}),
            home: HOME,
            cwd: CWD,
            projectTrusted: true,
            session: { orchestrator: { root } },
          }),
        root,
      ).toThrow(/committed config half/);
    }
    // No-op roots (issue #133 fix-cycle-3): a '.' segment means the derived
    // entry would match nothing and the worktree set would stay unignored —
    // refused through the programmatic layers too.
    for (const root of ['.', './wt', 'foo/.']) {
      expect(
        () =>
          loadRuntimeConfig({
            bridge: fakeBridge({}),
            home: HOME,
            cwd: CWD,
            projectTrusted: true,
            session: { orchestrator: { root } },
          }),
        root,
      ).toThrow(/must not name the workspace/);
    }
  });

  it('refuses gitignore metacharacter roots at load, by name (issue #133 re-review)', () => {
    // Same rule as the control characters: the value is shipped verbatim to
    // git's exclude file, where `*`/`?`/`[`/`]` would match paths other
    // than the named directory (hiding them from `git add -A` and the
    // clean-tree guard), a leading `#` would comment the line out, and a
    // backslash would escape the next character.
    for (const root of [
      '*',
      '**',
      '.kubic*',
      '.kubi[c]',
      '.kubi?',
      '#x',
      'x\\',
    ]) {
      expect(
        () =>
          load(
            { [PROJECT]: `[orchestrator]\nroot = ${JSON.stringify(root)}\n` },
            { projectTrusted: true },
          ),
        root,
      ).toThrow(/gitignore metacharacters are refused/);
    }
    // Programmatic session/agent layers bypass the TOML parser: the
    // projection re-checks the same rule, fail-closed.
    expect(() =>
      loadRuntimeConfig({
        bridge: fakeBridge({}),
        home: HOME,
        cwd: CWD,
        projectTrusted: true,
        session: { orchestrator: { root: '.kubic*' } },
      }),
    ).toThrow(/gitignore metacharacters are refused/);
    // §36 keeps its own refusal — and its own message — for a `!`-leading
    // root: that shape is a models.json secret ref, not a gitignore pattern.
    expect(() =>
      load(
        { [PROJECT]: '[orchestrator]\nroot = "!x"\n' },
        { projectTrusted: true },
      ),
    ).toThrow(/secrets never appear in config/);
  });
});

describe('checkWorkspaceIgnoreSplit in linked worktrees (issue #292)', () => {
  // Real git fixtures: a linked worktree's `.git` is a file, so only
  // `git rev-parse --git-path info/exclude` (what the writer uses) finds
  // the common-dir exclude. Cleanup removes the worktree first so no
  // stale metadata stays in the main checkout, then the temp dirs.
  const worktrees: Array<{ repo: string; wt: string }> = [];

  afterEach(() => {
    for (const { repo, wt } of worktrees.splice(0)) {
      try {
        git(repo, ['worktree', 'remove', '--force', wt]);
      } catch {
        // The rmSync below still reclaims the directory.
      }
    }
  });

  function git(cwd: string, args: string[]): string {
    // Shared sandbox driver (issue #420): production reaches git only
    // through the injected gitRunner seam below — plain, never injected.
    driver ??= createGitSandbox();
    return driver.git(args, { cwd }).trim();
  }

  // The injectable runner the prod caller passes: the writer's own probe.
  const gitRunner = gitSync;

  function initRepo(): string {
    const repo = tempDir('kubic-ignore-split-');
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'split@kubic.dev']);
    git(repo, ['config', 'user.name', 'kubic split']);
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    git(repo, ['add', 'base.txt']);
    git(repo, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base']);
    return repo;
  }

  function linkWorktree(repo: string): string {
    const wt = join(tempDir('kubic-ignore-wt-'), 'checkout');
    git(repo, ['worktree', 'add', '--detach', wt, 'HEAD']);
    worktrees.push({ repo, wt });
    return wt;
  }

  it('finds the writer entries in the common-dir exclude from a linked worktree', () => {
    const repo = initRepo();
    const wt = linkWorktree(repo);
    // Prod fidelity: the real writer puts the entries where rev-parse
    // points — the common dir's info/exclude.
    const written = ensureRuntimeExcludeRules({ cwd: wt });
    expect(written.changed).toBe(true);
    const split = checkWorkspaceIgnoreSplit(
      createNodeFileBridge('/'),
      wt,
      gitRunner,
    );
    expect(split.applicable).toBe(true);
    // The worktree `.git` is a file: the legacy `${cwd}/.git/info/exclude`
    // probe fails ENOTDIR and every entry reports missing.
    expect(split.missing).toEqual([]);
  });

  it('reads the root files from a repo subdirectory', () => {
    const repo = initRepo();
    const written = ensureRuntimeExcludeRules({ cwd: repo });
    expect(written.changed).toBe(true);
    const sub = join(repo, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    const split = checkWorkspaceIgnoreSplit(
      createNodeFileBridge('/'),
      sub,
      gitRunner,
    );
    expect(split.applicable).toBe(true);
    expect(split.missing).toEqual([]);
    expect(split.checked.some((path) => path.endsWith('info/exclude'))).toBe(
      true,
    );
  });

  it('stays inapplicable outside any repository', () => {
    const outside = tempDir('kubic-ignore-outside-');
    const split = checkWorkspaceIgnoreSplit(
      createNodeFileBridge('/'),
      outside,
      gitRunner,
    );
    expect(split.applicable).toBe(false);
    expect(split.missing).toEqual([]);
  });
});
