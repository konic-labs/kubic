// Runtime config load (issue #90; design §35.1/§36/§71) — RED first.
// Every test drives the production entry point (`loadRuntimeConfig`) over
// a fake FileBridge: zero network, zero real files, dummy $ENV_VAR refs.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SOLO_DEFAULTS } from '../../../agents/src/policy.js';
import type { FileBridge } from '../../../exec/src/file-bridge.js';
import { FileJournalStore } from '../../../exec/src/journal.js';
import {
  BudgetKeyError,
  ConfigError,
  ProjectUntrustedError,
} from './config.js';
import {
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
    const dir = mkdtempSync(join(tmpdir(), 'kubic-90-journal-'));
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
    expect(store.entries()).toEqual([]);

    // No retention key: no age bound is invented (§42.4 opt-in).
    const unbounded = load(
      { [PROJECT]: '[approvals]\nroute = "ask-user"\n' },
      {
        projectTrusted: true,
      },
    );
    expect(unbounded.journal.maxAgeMs).toBeUndefined();
    const keepDir = mkdtempSync(join(tmpdir(), 'kubic-90-journal-keep-'));
    const keep = new FileJournalStore(
      keepDir,
      unbounded.journal.retentionDays === undefined ? {} : {},
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

  it('renders the same view for humans, redacting secret shapes', () => {
    const runtime = load(
      { [GLOBAL]: '[model]\nprovider = "local"\nid = "llama3"\n' },
      { projectTrusted: true },
    );
    const lines = renderEffectiveConfig(effectiveConfigView(runtime));
    expect(
      lines.some((line) => line.includes('model.provider = "local" (global,')),
    ).toBe(true);
    expect(lines.some((line) => line.includes('budgets'))).toBe(true);
    expect(lines.join('\n')).not.toMatch(/\$[A-Z]/);
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
        [PROJECT]: '[agent]\nname = "kubic"\n[ui]\ntheme = "dark"\n',
      },
      { projectTrusted: true },
    );
    const view = effectiveConfigView(runtime);
    expect(view.values.find((v) => v.key === 'agent.name')?.disposition).toBe(
      'consumed',
    );
    expect(view.values.find((v) => v.key === 'ui.theme')?.disposition).toBe(
      'kept',
    );
    const lines = renderEffectiveConfig(view);
    expect(
      lines.some((line) =>
        line.includes('agent.name = "kubic" (project, consumed)'),
      ),
    ).toBe(true);
    expect(
      lines.some((line) => line.includes('ui.theme = "dark" (project, kept)')),
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
  });

  // The acceptance criterion's own bar: a .kubic/config.toml value must
  // measurably change a live behaviour, not merely parse. This drives the
  // real solo lane with the classes the config produced and asserts the
  // lane's own allowlist — the same set applyToolPolicy installs.
  it('narrows a live lane allowlist from [permissions] in config', async () => {
    const runtime = load(
      {
        [PROJECT]:
          '[permissions]\nfilesystem = "read"\nshell = false\ngit = false\nnetwork = "none"\n',
      },
      { projectTrusted: true },
    );
    const { bootSoloLane } = await import('../../../worker/src/lane/solo.js');
    const { applyToolPolicy } = await import(
      '../../../worker/src/lane/policy.js'
    );
    const { FakeExecutionEnv } = await import('../../../exec/src/env.js');
    const {
      BACKGROUND_CONTEXT,
      createModels,
      fauxAssistantMessage,
      fauxProvider,
      MemorySessionRepo,
    } = await import('../../../worker/src/pi-boundary.js');
    const repo = new MemorySessionRepo();
    const session = await repo.create({}, BACKGROUND_CONTEXT);
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('hi')]);
    const booted = await bootSoloLane({
      session,
      models,
      model: faux.getModel(),
      env: new FakeExecutionEnv({}),
      sessionId: session.metadata.id,
      agentId: 'root',
      policy: { classes: runtime.permissions.classes },
    });
    const allowed = await applyToolPolicy(
      booted.harness,
      booted.lane,
      runtime.permissions.classes,
      BACKGROUND_CONTEXT,
    );
    expect(allowed.sort()).toEqual(['find', 'grep', 'ls', 'read']);
    const active = await booted.lane.getActiveTools(BACKGROUND_CONTEXT);
    expect(active).not.toContain('bash');
    expect(active).not.toContain('write');
    await session.close(BACKGROUND_CONTEXT);
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
