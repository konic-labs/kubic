// Runtime config load.
// Every test drives the production entry point (`loadRuntimeConfig`) over
// a fake FileBridge: zero network, zero real files, dummy $ENV_VAR refs.

import { DEFAULT_PERMISSIONS } from '@kubic/agent/permissions';
import { FileJournalStore } from '@kubic/exec/journal';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { fakeBridge } from '../test-support/config-bridge.js';
import { ConfigError, ProjectUntrustedError } from './errors.js';
import { loadRuntimeConfig } from './runtime.js';
import { RUNTIME_ENV_OVERRIDES } from './runtime-env.js';
import type { RuntimeConfigInputs } from './runtime-types.js';
import {
  compactionSummaryLine,
  effectiveConfigView,
  keyEffectFor,
  RUNTIME_KEY_EFFECTS,
  runtimeKeyDisposition,
} from './runtime-view.js';

const HOME = '/home/u';

const CWD = '/repo';

const GLOBAL = `${HOME}/.kubic/config.toml`;

const PROJECT = `${CWD}/.kubic/config.toml`;

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

// The row's own words, whichever disposition the row carries.
const effectTextOf = (entry: (typeof RUNTIME_KEY_EFFECTS)[string]): string => {
  if ('effect' in entry) return entry.effect;
  if ('kept' in entry) return entry.kept;
  return entry.notYetImplemented;
};

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
      toolCallId: null,
      timestamp: Date.now() - 30 * dayMs,
    });
    expect(keep.entries().length).toBe(1);
  });

  it('reads [journal] retentionDays = 0 as retention off, as journal prune does', () => {
    const fromFile = load(
      { [PROJECT]: '[journal]\nretentionDays = 0\n' },
      { projectTrusted: true },
    );
    expect(fromFile.journal.retentionDays).toBe(0);
    expect(fromFile.journal.maxAgeMs).toBeUndefined();
    const fromEnv = load(
      {},
      {
        projectTrusted: true,
        env: { [RUNTIME_ENV_OVERRIDES.journalRetentionDays]: '0' },
      },
    );
    expect(fromEnv.journal.retentionDays).toBe(0);
    expect(fromEnv.journal.maxAgeMs).toBeUndefined();

    // Measurably off: a store built from it keeps every entry it appends.
    const store = new FileJournalStore(
      tempDir('kubic-runtime-journal-off-'),
      fromFile.journal.maxAgeMs === undefined
        ? {}
        : { maxAgeMs: fromFile.journal.maxAgeMs },
    );
    const dayMs = 24 * 60 * 60 * 1000;
    for (const [path, age] of [
      ['old.txt', 30 * dayMs],
      ['new.txt', 0],
    ] as const) {
      store.append({
        path,
        op: 'write',
        before: null,
        after: path,
        bytesDelta: path.length,
        sessionId: 's1',
        toolCallId: null,
        timestamp: Date.now() - age,
      });
    }
    expect(store.entries().map((entry) => entry.path)).toEqual([
      'old.txt',
      'new.txt',
    ]);
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

  it('says the kept window is capped to a quarter of the room below the reserve, in the key table and the summary line', () => {
    const entry = keyEffectFor('session.keepRecentTokens');
    expect(entry === undefined ? '' : effectTextOf(entry)).toContain(
      'capped per model to a quarter of the room below its reserve',
    );
    expect(
      compactionSummaryLine({
        enabled: true,
        reserveTokens: 16384,
        keepRecentTokens: 20000,
        source: 'defaults',
      }),
    ).toContain(
      'keep-recent=20000 token(s), capped to a quarter of the room below the reserve',
    );
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
      ...DEFAULT_PERMISSIONS,
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

  it('honours precedence: cli > enterprise > env > global > project > session > agent', () => {
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
    // The lower tail: project > session > agent.
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
        ...extra,
      }).model?.provider;
    const session = { model: { provider: 's', id: 'm' } };
    const agent = { model: { provider: 'a', id: 'm' } };
    expect(tail({ [PROJECT]: files[PROJECT] }, { session, agent })).toBe('p');
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
