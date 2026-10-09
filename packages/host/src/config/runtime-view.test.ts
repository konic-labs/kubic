// Runtime config load.
// Every test drives the production entry point (`loadRuntimeConfig`) over
// a fake FileBridge: zero network, zero real files, dummy $ENV_VAR refs.

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyToolPolicy } from '@kubic/agent/lane/policy';
import { BACKGROUND_CONTEXT } from '@kubic/agent/pi-boundary';
import { bootFauxLane } from '@kubic/agent/test-support/lane-harness';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { FakeExecutionEnv } from '@kubic/exec/test-support/fake-env';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeBridge } from '../test-support/config-bridge.js';
import { ProjectUntrustedError } from './errors.js';
import { loadRuntimeConfig } from './runtime.js';
import { RUNTIME_ENV_OVERRIDES } from './runtime-env.js';
import type { RuntimeConfigInputs } from './runtime-types.js';
import {
  effectiveConfigView,
  keyEffectFor,
  RUNTIME_KEY_EFFECTS,
  renderEffectiveConfig,
  runtimeKeyDisposition,
} from './runtime-view.js';

const HOME = '/home/u';

const CWD = '/repo';

const GLOBAL = `${HOME}/.kubic/config.toml`;

const PROJECT = `${CWD}/.kubic/config.toml`;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
    const text = effectTextOf(RUNTIME_KEY_EFFECTS['model.thinking']);
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
    // autoCompact from project, reserveTokens from global: a first-set-key
    // rule would name 'project' (autoCompact sorts first in key order); the
    // provenance must name 'global' — the
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

  it('refuses a project prompt file that links out of the project root', () => {
    const root = mkdtempSync(join(tmpdir(), 'kubic-prompt-link-'));
    try {
      const project = join(root, 'repo');
      mkdirSync(join(project, '.kubic'), { recursive: true });
      writeFileSync(join(root, 'outside.md'), 'Outside.\n');
      writeFileSync(join(project, '.kubic', 'inside.md'), 'Inside.\n');
      symlinkSync(join(root, 'outside.md'), join(project, '.kubic', 'out.md'));
      symlinkSync(
        join(project, '.kubic', 'inside.md'),
        join(project, '.kubic', 'in.md'),
      );
      // The project config declares the file, relative to `.kubic/`.
      const loadWith = (file: string) => {
        writeFileSync(
          join(project, '.kubic', 'config.toml'),
          `[agent]\nsystemPromptFile = "${file}"\n`,
        );
        return loadRuntimeConfig({
          bridge: createNodeFileBridge('/'),
          home: join(root, 'home'),
          cwd: project,
          projectRoot: project,
          projectTrusted: true,
        });
      };
      expect(() => loadWith('out.md')).toThrow(
        /'agent': 'systemPromptFile' '.*out\.md' resolves outside the project root/,
      );
      // A link that stays inside the root is fine.
      expect(loadWith('in.md').systemPromptFile?.contents).toBe('Inside.\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    // The annotations reach `kubic config` and the configuration docs, so
    // they state decisions in words and never point at an issue number.
    for (const [key, entry] of Object.entries(RUNTIME_KEY_EFFECTS)) {
      expect(effectTextOf(entry), key).not.toMatch(/#\d+/);
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

  // The bar: a .kubic/config.toml value must
  // measurably change a live behaviour, not merely parse. This drives the
  // real lane (through the shared faux harness factory) with the
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
        lane.lane.registry,
        lane.lane.conversation,
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
