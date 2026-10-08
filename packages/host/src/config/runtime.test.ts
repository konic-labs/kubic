// Runtime config load.
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
import { ConfigError, ProjectUntrustedError } from './config.js';
import {
  checkWorkspaceIgnoreSplit,
  compactionSummaryLine,
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

// The test's git driver: plain, never injected — production
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

describe('runtime config load', () => {
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
    const dir = tempDir('kubic-runtime-journal-');
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

    // No retention key: no age bound is invented.
    const unbounded = load(
      { [PROJECT]: '[approvals]\nroute = "ask-user"\n' },
      {
        projectTrusted: true,
      },
    );
    expect(unbounded.journal.maxAgeMs).toBeUndefined();
    const keepDir = tempDir('kubic-runtime-journal-keep-');
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

  it('projects the [model] escalation ladder with its bound', () => {
    const runtime = load(
      {
        [PROJECT]:
          '[model]\nprovider = "local"\nid = "a"\nescalate = ["local/a", "acme/big"]\nmaxEscalations = 1\n',
      },
      { projectTrusted: true },
    );
    expect(runtime.escalate).toEqual({
      steps: ['local/a', 'acme/big'],
      maxEscalations: 1,
    });
    expect(runtime.sources['model.escalate']).toBe('project');
    // Unset max defaults to the ladder length (the ladder itself bounds).
    expect(
      load(
        {
          [PROJECT]:
            '[model]\nprovider = "local"\nid = "a"\nescalate = ["local/a", "local/b"]\n',
        },
        { projectTrusted: true },
      ).escalate,
    ).toEqual({ steps: ['local/a', 'local/b'], maxEscalations: 2 });
    // No ladder: nothing is invented.
    expect(
      load(
        { [PROJECT]: '[model]\nprovider = "x"\nid = "y"\n' },
        { projectTrusted: true },
      ).escalate,
    ).toBeUndefined();
  });

  it('explains the escalation keys in the key-effects table', () => {
    for (const key of ['model.escalate', 'model.maxEscalations']) {
      expect(runtimeKeyDisposition(keyEffectFor(key))).toBe('consumed');
    }
    // The per-role ladder falls back to the `roles` section row.
    expect(runtimeKeyDisposition(keyEffectFor('roles.reviewer.escalate'))).toBe(
      'consumed',
    );
  });

  it('says the kept window is capped to the model window, in the key table and the summary line', () => {
    const entry = keyEffectFor('session.keepRecentTokens');
    expect(entry === undefined ? '' : runtimeKeyEffectText(entry)).toMatch(
      /capped per model/,
    );
    expect(
      compactionSummaryLine({
        enabled: true,
        reserveTokens: 16384,
        keepRecentTokens: 20000,
        source: 'defaults',
      }),
    ).toContain('keep-recent=20000 token(s), capped to the model window');
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
      'baseline',
    );

    // Unset stays undefined — no empty list is invented.
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

  it('reports the cli/env model pins a frozen enterprise pin overrode', () => {
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

  it('refuses secret refs in config (secrets live in models.json)', () => {
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

describe('thinking level load', () => {
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

describe('enterprise-frozen thinking + thinking-only layers', () => {
  // Bug A: an enterprise-pinned level keeps its value and source against
  // the env override — and the dropped override is reported, never
  // silent (the model-pin pattern, one row per ignored input).
  it('records the env override a frozen enterprise level drops', () => {
    const files = {
      // Thinking-only enterprise layer (the shape that broke): the pin comes
      // from project, the level from enterprise.
      '/etc/kubic/config.toml': '[model]\nthinking = "high"\n',
      [PROJECT]: '[model]\nprovider = "local"\nid = "llama3"\n',
    };
    const env = load(files, {
      projectTrusted: true,
      env: { [RUNTIME_ENV_OVERRIDES.modelThinking]: 'low' },
    });
    expect(env.thinking).toEqual({ level: 'high', source: 'enterprise' });
    expect(env.model).toMatchObject({ thinking: 'high' });
    expect(env.overriddenAttempts).toEqual([
      "model: KUBIC_MODEL_THINKING 'low' rejected: enterprise thinking 'high' holds",
    ]);
    // An equal value overrode nothing.
    expect(
      load(files, {
        projectTrusted: true,
        env: { [RUNTIME_ENV_OVERRIDES.modelThinking]: 'high' },
      }).overriddenAttempts,
    ).toEqual([]);
    // No env override: nothing to report.
    expect(load(files, { projectTrusted: true }).overriddenAttempts).toEqual(
      [],
    );
  });

  // Bug B: a layer that sets only `[model] thinking` reaches the
  // projection through the thinking channel (no model pin is invented)
  // and `kubic config` names the same winner the lane boots with.
  it('reports a thinking-only layer consistently', () => {
    const runtime = load(
      { [PROJECT]: '[model]\nthinking = "high"\n' },
      { projectTrusted: true },
    );
    expect(runtime.model).toBeUndefined();
    expect(runtime.thinking).toEqual({ level: 'high', source: 'project' });
    const view = effectiveConfigView(runtime);
    expect(view.values).toEqual(
      expect.arrayContaining([
        {
          key: 'model.thinking',
          value: '"high"',
          layer: 'project',
          disposition: 'consumed',
        },
      ]),
    );
    expect(view.thinking).toEqual({ level: 'high', source: 'project' });
    const lines = renderEffectiveConfig(view);
    expect(lines).toContain('thinking level: high (project)');
    expect(lines).toContain(
      'selected model: first available provider (defaults) — no model pin configured',
    );
  });
});

describe('effective config view', () => {
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
    expect(view.projectTrusted).toBe(true);
    // Every documented key with an observable effect is listed for the docs
    // test — the view and the docs share one list, never two.
    expect(Object.keys(RUNTIME_KEY_EFFECTS).length).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(view)).values.length).toBe(
      view.values.length,
    );
  });

  it('turns [session] compaction keys into a live lane projection', () => {
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

  it('reports the highest-precedence contributing layer for split compaction keys', () => {
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

  it('reports compaction defaults when nothing is configured', () => {
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

  it('re-validates session compaction for the programmatic layers', () => {
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

  it('resolves [agent] systemPromptFile against the declaring layer', () => {
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

  it('expands a leading ~/ against home', () => {
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

  it('contains the project layer to the project root', () => {
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

  it('refuses an untrusted project file pre-trust and a missing file by name', () => {
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

  it('re-validates the programmatic layers and refuses relative paths without a declaring file', () => {
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
  });

  it('distinguishes consumed, kept and pending keys', () => {
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

  it('renders the disposition on every effective value', () => {
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
    // `ui.theme` is consumed (the TUI resolves it before the
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

  it('names no issue in any key-effect annotation', () => {
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
  // real solo lane (through the shared faux harness factory) with the
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

describe('request options reach the effective view', () => {
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

describe('enterprise [policy] on the live path', () => {
  const ENTERPRISE = '/etc/kubic/config.toml';
  const PRODUCT = '/etc/kubic/product.toml';
  const GLOBAL = `${HOME}/.kubic/config.toml`;

  const POLICY_EXAMPLE = `[policy]
allowed_models = ["claude-sonnet-4-6", "local/*"]
allowed_providers = ["anthropic", "local"]
allowed_tools = ["read", "grep", "find", "ls", "bash", "edit", "write", "git_diff"]
denied_tools = ["network_fetch"]

network_policy = "proxy"
allowed_domains = ["registry.npmjs.org", "github.com"]

filesystem_policy = "workspace-only"

data_policy = "no-external-training"
logging_policy = "full-audit"

[[audit]]
sink = "syslog"
level = "privileged"
`;

  it('loads the documented example as the enterprise layer and resolves it', () => {
    const runtime = load({ [ENTERPRISE]: POLICY_EXAMPLE });
    expect(runtime.policy.tools.deny).toEqual(['network_fetch']);
    expect(runtime.policy.tools.allow).toContain('bash');
    expect(runtime.policy.models.allowed).toEqual([
      'claude-sonnet-4-6',
      'local/*',
    ]);
    expect(runtime.policy.models.providers).toEqual(['anthropic', 'local']);
    // 'proxy' is carried as the engine's allowlist mode; workspace-only as
    // workspace-write.
    expect(runtime.policy.network.mode).toBe('allowlist');
    expect(runtime.policy.filesystem.level).toBe('workspace-write');
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
      // The prompt tells the model the truth about its own tool set;
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

describe('checkWorkspaceIgnoreSplit in linked worktrees', () => {
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
    // Shared sandbox driver: production reaches git only
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

describe('project configuration', () => {
  // The project layer the test writes into a temp directory, so no test reads a
  // config file from the checkout.
  const PROJECT_CONFIG_TOML = `[model]
provider = "local"
id = "llama3"
thinking = "medium"

[approvals]
route = "ask-user"
maxPendingMs = 60000
autoApprove = []
sessionScoped = true
requireJustification = false

[permissions]
filesystem = "workspace-write"
shell = true
network = "none"
git = "workspace"
credentials = "none"

[journal]
retentionDays = 30
`;

  it('keeps every key-effect entry meaningful', () => {
    for (const [key, entry] of Object.entries(RUNTIME_KEY_EFFECTS)) {
      expect(key.length).toBeGreaterThan(0);
      // Every disposition carries words: an effect, a kept decision, or a
      // named pending follow-up.
      expect(runtimeKeyEffectText(entry).length).toBeGreaterThan(10);
      expect(runtimeKeyDisposition(entry)).not.toBe('unknown');
    }
  });

  it('loads a project .kubic/config.toml and maps every key', () => {
    const project = tempDir('kubic-project-config-');
    mkdirSync(join(project, '.kubic'), { recursive: true });
    writeFileSync(join(project, '.kubic', 'config.toml'), PROJECT_CONFIG_TOML);
    const runtime = loadRuntimeConfig({
      bridge: createNodeFileBridge(project),
      home: '/home/u',
      cwd: project,
      enterprisePath: '/nonexistent/config.toml',
      projectTrusted: true,
    });
    expect(runtime.model).toEqual({
      provider: 'local',
      id: 'llama3',
      thinking: 'medium',
    });
    expect(runtime.modelSource).toBe('project');
    expect(runtime.approvals.source).toBe('project');
    expect(runtime.permissions.classes.network).toBe('none');
    expect(runtime.journal.retentionDays).toBe(30);
    expect(runtime.projectTrusted).toBe(true);
    const view = effectiveConfigView(runtime);
    expect(view.values.length).toBeGreaterThan(0);
    expect(view.values.every((entry) => entry.layer === 'project')).toBe(true);
    expect(view.values.every((entry) => entry.disposition !== 'unknown')).toBe(
      true,
    );
  });
});
