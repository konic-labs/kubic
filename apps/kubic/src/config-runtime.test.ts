// Composition-root trust wiring (issue #228; §35.1): the persisted
// decision under `~/.kubic/trust.json` is what makes a committed
// `.kubic/config.toml` usable, with no env var exported per invocation.
//
// These tests drive the real `loadCliConfig` over temp home/project dirs
// (no network, no paid tokens) and clean every temp dir up in `afterEach`.

// The `cli` config layer on the composition root's own load (issue #227,
// §35.1): `kubic run --model`, `kubic tui --model` and `kubic config
// --model` are one input to the ONE load dispatch performs, so the model
// the projection hands the lane is the same model `kubic config` reports —
// never two derivations that can drift.
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  effectiveConfigView,
  renderEffectiveConfig,
} from '../../../packages/host/src/config/runtime.js';
import {
  ProjectTrustStore,
  projectTrustStorePath,
} from '../../../packages/host/src/config/trust-store.js';
import { ModelSelectError } from '../../../packages/worker/src/model-select.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '../../../packages/worker/src/pi-boundary.js';
import {
  approvalSnapshotFrom,
  configRefusalExit,
  doctorConfigProbe,
  doctorPolicyLoader,
  installedPolicyClasses,
  installedPolicyDeps,
  kubicConfigLoader,
  loadCliConfig,
  projectTrustFor,
  requireRuntimeConfig,
  resolveInteractiveProjectTrust,
  roleLayersFromConfig,
  runtimeApprovalDeps,
  runtimeLaneDeps,
  runtimeModelFrozen,
  runtimeModelPin,
  runtimeModelPinNotes,
  runtimePolicy,
  runtimeRunDeps,
  selectModelUnderPolicy,
  sessionRetentionDays,
} from './config-runtime.js';
import { prodRunDeps } from './prod-runners.js';

const made: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// A project dir that follows the design: committed `.kubic/config.toml`.
function projectWithConfig(): string {
  const project = tmpDir('kubic-trust-project-');
  mkdirSync(join(project, '.kubic'), { recursive: true });
  writeFileSync(
    join(project, '.kubic', 'config.toml'),
    '[journal]\nretentionDays = 5\n',
  );
  return project;
}

function storeFor(home: string): ProjectTrustStore {
  return new ProjectTrustStore(projectTrustStorePath(home));
}

describe('project trust store wiring (issue #228)', () => {
  it('loads the project layer after `kubic trust`, with no env var set', () => {
    const home = tmpDir('kubic-trust-home-');
    const project = projectWithConfig();
    storeFor(home).set(project, true);
    const result = loadCliConfig({ cwd: project, home, env: {} });
    expect(result.error).toBeUndefined();
    expect(result.runtime?.projectTrusted).toBe(true);
    expect(result.runtime?.journal.retentionDays).toBe(5);
  });

  it('refuses the project layer again after `kubic trust --revoke`, naming both remedies', () => {
    const home = tmpDir('kubic-trust-home-');
    const project = projectWithConfig();
    const store = storeFor(home);
    store.set(project, true);
    expect(
      loadCliConfig({ cwd: project, home, env: {} }).error,
    ).toBeUndefined();
    store.set(project, null);
    const refused = loadCliConfig({ cwd: project, home, env: {} });
    expect(refused.runtime).toBeUndefined();
    expect(refused.error).toContain('refused pre-trust');
    expect(refused.error).toContain('kubic trust');
    expect(refused.error).toContain('KUBIC_TRUST_PROJECT=1');
  });

  it('does not trust a sibling directory', () => {
    const home = tmpDir('kubic-trust-home-');
    const root = tmpDir('kubic-trust-root-');
    const a = join(root, 'a');
    const sibling = join(root, 'a-sibling');
    mkdirSync(join(a, '.kubic'), { recursive: true });
    mkdirSync(join(sibling, '.kubic'), { recursive: true });
    writeFileSync(
      join(a, '.kubic', 'config.toml'),
      '[journal]\nretentionDays = 5\n',
    );
    writeFileSync(
      join(sibling, '.kubic', 'config.toml'),
      '[journal]\nretentionDays = 5\n',
    );
    storeFor(home).set(a, true);
    expect(loadCliConfig({ cwd: a, home, env: {} }).error).toBeUndefined();
    expect(
      loadCliConfig({ cwd: sibling, home, env: {} }).runtime,
    ).toBeUndefined();
  });

  it('still honours KUBIC_TRUST_PROJECT=1 without a store entry', () => {
    const home = tmpDir('kubic-trust-home-');
    const project = projectWithConfig();
    const result = loadCliConfig({
      cwd: project,
      home,
      env: { KUBIC_TRUST_PROJECT: '1' },
    });
    expect(result.error).toBeUndefined();
    expect(result.runtime?.projectTrusted).toBe(true);
  });

  it('refuses a home that cannot hold the store instead of trusting the cwd', () => {
    const project = projectWithConfig();
    const result = loadCliConfig({ cwd: project, home: '', env: {} });
    expect(result.runtime).toBeUndefined();
    expect(result.error).toMatch(/absolute home/);
    expect(result.trust.trusted).toBe(false);
  });

  it('projects the loaded report into a per-path check, not a cwd boolean', () => {
    const home = tmpDir('kubic-trust-home-');
    const root = tmpDir('kubic-trust-root-');
    const child = join(root, 'pkg');
    mkdirSync(child);
    storeFor(home).set(root, true);
    const result = loadCliConfig({ cwd: child, home, env: {} });
    // The cwd itself is undecided...
    expect(result.trust.trusted).toBe(false);
    // ...but the grant for the tree the ancestor files live in still applies.
    const check = projectTrustFor(result);
    expect(check(root)).toBe(true);
    expect(check(child)).toBe(false);
  });
});

describe('project root resolution (issue #229)', () => {
  function repoWithConfig(): { root: string; sub: string } {
    const root = tmpDir('kubic-root-repo-');
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(root, '.kubic'), { recursive: true });
    writeFileSync(
      join(root, '.kubic', 'config.toml'),
      '[journal]\nretentionDays = 5\n',
    );
    const sub = join(root, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    return { root, sub };
  }

  it('loads the project layer from a subdirectory, reporting the root path', () => {
    const home = tmpDir('kubic-root-home-');
    const { root, sub } = repoWithConfig();
    storeFor(home).set(root, true);
    const result = loadCliConfig({ cwd: sub, home, env: {} });
    expect(result.error).toBeUndefined();
    expect(result.runtime?.journal.retentionDays).toBe(5);
    expect(result.projectRoot).toBe(root);
    const runtime = result.runtime;
    expect(runtime).toBeDefined();
    if (runtime === undefined) throw new Error('project layer did not load');
    const view = effectiveConfigView(runtime);
    const project = view.layers.find((layer) => layer.layer === 'project');
    expect(project?.path).toBe(join(root, '.kubic', 'config.toml'));
    expect(project?.present).toBe(true);
  });

  it('names the root path in the pre-trust refusal from a subdirectory', () => {
    const home = tmpDir('kubic-root-home-');
    const { root, sub } = repoWithConfig();
    const refused = loadCliConfig({ cwd: sub, home, env: {} });
    expect(refused.runtime).toBeUndefined();
    expect(refused.error).toContain(join(root, '.kubic', 'config.toml'));
    expect(refused.error).not.toContain(join(sub, '.kubic', 'config.toml'));
  });

  it('a root grant covers a subdirectory run; a subdir grant never reaches the root', () => {
    const home = tmpDir('kubic-root-home-');
    const { root, sub } = repoWithConfig();
    const store = storeFor(home);
    store.set(root, true);
    expect(loadCliConfig({ cwd: sub, home, env: {} }).error).toBeUndefined();
    store.set(root, null);
    store.set(sub, true);
    const refused = loadCliConfig({ cwd: sub, home, env: {} });
    expect(refused.runtime).toBeUndefined();
    expect(refused.error).toContain('refused pre-trust');
  });
});

describe('interactive trust prompt (issue #228)', () => {
  it('accepting records the decision and the lane boots on it', async () => {
    const home = tmpDir('kubic-trust-home-');
    const project = projectWithConfig();
    const asked: string[] = [];
    const answer = await resolveInteractiveProjectTrust({
      home,
      cwd: project,
      env: {},
      confirm: async (message) => {
        asked.push(message);
        return true;
      },
    });
    expect(answer).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(project);
    expect(storeFor(home).get(project)).toBe(true);
    expect(
      loadCliConfig({ cwd: project, home, env: {} }).error,
    ).toBeUndefined();
  });

  // Issue #229: asked from a subdirectory, the grant is recorded at the
  // project root — the same root the config load keys its trust report
  // to — so the loader honours it from any cwd under the root.
  it('records the grant at the project root when asked from a subdirectory', async () => {
    const home = tmpDir('kubic-trust-home-');
    const root = tmpDir('kubic-trust-ask-root-');
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(root, '.kubic'), { recursive: true });
    writeFileSync(
      join(root, '.kubic', 'config.toml'),
      '[journal]\nretentionDays = 5\n',
    );
    const sub = join(root, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    const asked: string[] = [];
    const answer = await resolveInteractiveProjectTrust({
      home,
      cwd: sub,
      env: {},
      confirm: async (message) => {
        asked.push(message);
        return true;
      },
    });
    expect(answer).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(realpathSync(root));
    expect(storeFor(home).get(root)).toBe(true);
    expect(loadCliConfig({ cwd: sub, home, env: {} }).error).toBeUndefined();
  });

  // The grant is one decision for the whole project tree: it also unlocks
  // the project models.json (a provider URL plus the `*_API_KEY` variable it
  // sends to it) and the project skills. The question must say so — a "yes"
  // that reads as "load config.toml" is not informed consent.
  it('the question names everything the grant unlocks: config.toml, models.json (with the key risk) and skills', async () => {
    const home = tmpDir('kubic-trust-home-');
    const project = projectWithConfig();
    const asked: string[] = [];
    await resolveInteractiveProjectTrust({
      home,
      cwd: project,
      env: {},
      confirm: async (message) => {
        asked.push(message);
        return false;
      },
    });
    expect(asked).toHaveLength(1);
    const question = asked[0] ?? '';
    const key = realpathSync(project);
    expect(question).toContain(`Trust project ${key}?`);
    expect(question).toContain(join(project, '.kubic', 'config.toml'));
    expect(question).toContain('models.json');
    expect(question).toContain('any *_API_KEY or KUBIC_* variable it names');
    expect(question).toContain('KUBIC_API_KEY by default');
    expect(question).toContain('project skills');
    // One line: it is a single confirm prompt on the terminal.
    expect(question).not.toContain('\n');
  });

  it('declining records the decision and the lane refuses accordingly', async () => {
    const home = tmpDir('kubic-trust-home-');
    const project = projectWithConfig();
    const answer = await resolveInteractiveProjectTrust({
      home,
      cwd: project,
      env: {},
      confirm: async () => false,
    });
    expect(answer).toBe(false);
    expect(storeFor(home).get(project)).toBe(false);
    const refused = loadCliConfig({ cwd: project, home, env: {} });
    expect(refused.runtime).toBeUndefined();
    expect(refused.error).toContain('kubic trust');
  });

  it('does not ask again after a recorded decline', async () => {
    const home = tmpDir('kubic-trust-home-');
    const project = projectWithConfig();
    storeFor(home).set(project, false);
    let asks = 0;
    const answer = await resolveInteractiveProjectTrust({
      home,
      cwd: project,
      env: {},
      confirm: async () => {
        asks += 1;
        return true;
      },
    });
    expect(answer).toBe(false);
    expect(asks).toBe(0);
  });

  it('a cancelled prompt records nothing and fails closed', async () => {
    const home = tmpDir('kubic-trust-home-');
    const project = projectWithConfig();
    const answer = await resolveInteractiveProjectTrust({
      home,
      cwd: project,
      env: {},
      confirm: async () => null,
    });
    expect(answer).toBe(false);
    expect(storeFor(home).get(project)).toBe(null);
    expect(loadCliConfig({ cwd: project, home, env: {} }).error).toContain(
      'refused pre-trust',
    );
  });

  it('asks nothing when the project has no config file', async () => {
    const home = tmpDir('kubic-trust-home-');
    const project = tmpDir('kubic-trust-project-');
    let asks = 0;
    const answer = await resolveInteractiveProjectTrust({
      home,
      cwd: project,
      env: {},
      confirm: async () => {
        asks += 1;
        return true;
      },
    });
    expect(answer).toBeUndefined();
    expect(asks).toBe(0);
  });

  it('asks nothing when trust is already recorded or env-granted', async () => {
    const home = tmpDir('kubic-trust-home-');
    const project = projectWithConfig();
    storeFor(home).set(project, true);
    for (const env of [{}, { KUBIC_TRUST_PROJECT: '1' }]) {
      let asks = 0;
      const answer = await resolveInteractiveProjectTrust({
        home,
        cwd: project,
        env,
        confirm: async () => {
          asks += 1;
          return false;
        },
      });
      expect(answer).toBe(true);
      expect(asks).toBe(0);
    }
  });

  it('reads and writes one injected store, never a second one', async () => {
    const home = tmpDir('kubic-trust-home-');
    const project = projectWithConfig();
    const custom = new ProjectTrustStore(
      join(tmpDir('kubic-trust-alt-'), 'trust.json'),
    );
    custom.set(project, true);
    let asks = 0;
    const trusted = await resolveInteractiveProjectTrust({
      home,
      cwd: project,
      env: {},
      store: custom,
      confirm: async () => {
        asks += 1;
        return false;
      },
    });
    expect(trusted).toBe(true);
    expect(asks).toBe(0);
    // An accepted prompt lands in the same store, not a second one.
    const other = projectWithConfig();
    const accepted = await resolveInteractiveProjectTrust({
      home,
      cwd: other,
      env: {},
      store: custom,
      confirm: async () => true,
    });
    expect(accepted).toBe(true);
    expect(custom.get(other)).toBe(true);
  });
});

describe('cli model layer (issue #227)', () => {
  it('projects --model as the cli layer, above the file pin', () => {
    const home = tmp('cli-model-home-');
    const cwd = tmp('cli-model-cwd-');
    mkdirSync(join(home, '.kubic'), { recursive: true });
    writeFileSync(
      join(home, '.kubic', 'config.toml'),
      '[model]\nprovider = "g"\nid = "file"\n',
    );

    const result = loadCliConfig({
      cwd,
      home,
      env: {},
      model: { provider: 'faux', id: 'small' },
    });
    expect(result.error).toBeUndefined();
    expect(runtimeModelPin(result)).toEqual({
      provider: 'faux',
      id: 'small',
    });
    const view = effectiveConfigView(requireRuntimeConfig(result));
    expect(view.modelSource).toBe('cli');
    expect(renderEffectiveConfig(view)).toContain(
      'selected model: faux/small (cli)',
    );
  });

  it('without the flag the file pin stays in force', () => {
    const home = tmp('cli-model-home2-');
    const cwd = tmp('cli-model-cwd2-');
    mkdirSync(join(home, '.kubic'), { recursive: true });
    writeFileSync(
      join(home, '.kubic', 'config.toml'),
      '[model]\nprovider = "g"\nid = "file"\n',
    );

    const result = loadCliConfig({ cwd, home, env: {} });
    expect(runtimeModelPin(result)).toEqual({ provider: 'g', id: 'file' });
    const view = effectiveConfigView(requireRuntimeConfig(result));
    expect(renderEffectiveConfig(view)).toContain(
      'selected model: g/file (global)',
    );
  });
});

// The config-runtime projections (issue #384): every export of
// config-runtime.ts is referenced by a behavioural test below, driven
// through the real loadCliConfig over temp dirs (no network, no tokens).
// Helpers write one layer file at a time: the global layer needs no trust,
// the project layer loads under KUBIC_TRUST_PROJECT=1.
function globalHome(toml: string): { home: string; cwd: string } {
  const home = tmpDir('kubic-proj-home-');
  const cwd = tmpDir('kubic-proj-cwd-');
  mkdirSync(join(home, '.kubic'), { recursive: true });
  writeFileSync(join(home, '.kubic', 'config.toml'), toml);
  return { home, cwd };
}

function trustedProject(toml: string): { home: string; project: string } {
  const home = tmpDir('kubic-proj-phome-');
  const project = tmpDir('kubic-proj-project-');
  mkdirSync(join(project, '.kubic'), { recursive: true });
  writeFileSync(join(project, '.kubic', 'config.toml'), toml);
  return { home, project };
}

function refusedGlobal(): ReturnType<typeof loadCliConfig> {
  const { home, cwd } = globalHome('[bogus]\nkey = 1\n');
  const refused = loadCliConfig({ cwd, home, env: {} });
  expect(refused.runtime).toBeUndefined();
  expect(refused.error).toContain('bogus');
  return refused;
}

describe('runtimeModelPin + requireRuntimeConfig + configRefusalExit (issue #384)', () => {
  it('is undefined when no model is pinned', () => {
    const home = tmpDir('kubic-pin-absent-home-');
    const cwd = tmpDir('kubic-pin-absent-cwd-');
    expect(
      runtimeModelPin(loadCliConfig({ cwd, home, env: {} })),
    ).toBeUndefined();
  });

  it('projects a set pin as { provider, id }', () => {
    const { home, cwd } = globalHome('[model]\nprovider = "g"\nid = "file"\n');
    expect(runtimeModelPin(loadCliConfig({ cwd, home, env: {} }))).toEqual({
      provider: 'g',
      id: 'file',
    });
  });

  it('is undefined on a refused config instead of a default', () => {
    expect(runtimeModelPin(refusedGlobal())).toBeUndefined();
  });

  it('requireRuntimeConfig returns the runtime, or throws the named refusal', () => {
    const { home, cwd } = globalHome('[model]\nprovider = "g"\nid = "file"\n');
    const clean = loadCliConfig({ cwd, home, env: {} });
    expect(requireRuntimeConfig(clean)).toBe(clean.runtime);
    const refused = refusedGlobal();
    expect(() => requireRuntimeConfig(refused)).toThrow(
      refused.error ?? 'refused',
    );
  });

  it('configRefusalExit stops the agent-executing modes, never the reporting ones', () => {
    const { home, cwd } = globalHome('[model]\nprovider = "g"\nid = "file"\n');
    const clean = loadCliConfig({ cwd, home, env: {} });
    expect(configRefusalExit(clean, 'run')).toBeUndefined();
    const refused = refusedGlobal();
    for (const command of ['run', 'orchestrate', 'tui', 'replay']) {
      expect(configRefusalExit(refused, command)).toBe(1);
    }
    for (const command of ['config', 'doctor', 'trust', undefined]) {
      expect(configRefusalExit(refused, command)).toBeUndefined();
    }
  });
});

describe('kubicConfigLoader + doctorPolicyLoader fail closed (issue #384)', () => {
  it('kubicConfigLoader renders the runtime, or throws the refusal', () => {
    const { home, cwd } = globalHome('[model]\nprovider = "g"\nid = "file"\n');
    const clean = loadCliConfig({ cwd, home, env: {} });
    expect(kubicConfigLoader(clean)()).toBe(clean.runtime);
    const refused = refusedGlobal();
    expect(() => kubicConfigLoader(refused)()).toThrow(
      refused.error ?? 'refused',
    );
  });

  it('doctorPolicyLoader reads the approvals policy, or throws the refusal', () => {
    const { home, cwd } = globalHome('[approvals]\nroute = "deny"\n');
    const clean = loadCliConfig({ cwd, home, env: {} });
    expect(doctorPolicyLoader(clean)()).toBe(clean.runtime?.approvals.policy);
    const refused = refusedGlobal();
    expect(() => doctorPolicyLoader(refused)()).toThrow(
      refused.error ?? 'refused',
    );
  });
});

describe('approvalSnapshotFrom copies the policy (issue #384)', () => {
  it('carries route/autoApprove/maxPendingMs by value, never by reference', () => {
    const { home, cwd } = globalHome(
      '[approvals]\nroute = "deny"\nmaxPendingMs = 4321\nautoApprove = ["read", "write"]\n',
    );
    const runtime = requireRuntimeConfig(loadCliConfig({ cwd, home, env: {} }));
    const snapshot = approvalSnapshotFrom(runtime);
    expect(snapshot).toEqual({
      route: 'deny',
      autoApprove: ['read', 'write'],
      maxPendingMs: 4321,
    });
    // The frozen-snapshot guarantee: not the live array.
    expect(snapshot.autoApprove).not.toBe(runtime.approvals.policy.autoApprove);
    // Mutating the snapshot leaves the runtime (and the next snapshot) unchanged.
    // (cast: the snapshot type is readonly, the runtime value is a live array.)
    (snapshot.autoApprove as string[]).push('network');
    expect(runtime.approvals.policy.autoApprove).toEqual(['read', 'write']);
    expect(approvalSnapshotFrom(runtime).autoApprove).toEqual([
      'read',
      'write',
    ]);
  });
});

describe('installedPolicyClasses over the same load the lane uses (issue #384)', () => {
  it('is {} when the config declares no classes', () => {
    const home = tmpDir('kubic-pol-absent-home-');
    const cwd = tmpDir('kubic-pol-absent-cwd-');
    const result = loadCliConfig({ cwd, home, env: {} });
    expect(result.error).toBeUndefined();
    expect(installedPolicyClasses(result)).toEqual({});
    expect(installedPolicyDeps(result).source).toBe('default');
  });

  it('carries configured classes with a config source', () => {
    const { home, cwd } = globalHome('[permissions]\nshell = false\n');
    const result = loadCliConfig({ cwd, home, env: {} });
    expect(result.error).toBeUndefined();
    const { classes } = installedPolicyClasses(result);
    expect(classes?.shell).toBe(false);
    const deps = installedPolicyDeps(result);
    expect(deps.source).toBe('config');
    expect(deps.classes?.shell).toBe(false);
  });
});

describe('doctorConfigProbe names clean vs refused (issue #384)', () => {
  it('passes on a clean load', () => {
    const { home, cwd } = globalHome('[model]\nprovider = "g"\nid = "file"\n');
    const probe = doctorConfigProbe(loadCliConfig({ cwd, home, env: {} }));
    expect(probe.id).toBe('config-load');
    expect(probe.ok).toBe(true);
  });

  it('fails by name on a refused load, never on defaults', () => {
    const refused = refusedGlobal();
    const probe = doctorConfigProbe(refused);
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain(refused.error ?? 'bogus');
  });
});

describe('roleLayersFromConfig (issue #384)', () => {
  it('turns [roles.<name>] model/tools into layer inputs', () => {
    const { home, project } = trustedProject(
      '[roles.implementer]\nmodel = "g/file"\ntools = ["read"]\n',
    );
    const result = loadCliConfig({
      cwd: project,
      home,
      env: { KUBIC_TRUST_PROJECT: '1' },
    });
    expect(result.error).toBeUndefined();
    const runtime = requireRuntimeConfig(result);
    const layers = roleLayersFromConfig(runtime);
    expect(layers).toHaveLength(1);
    expect(layers[0]?.layer).toBe('project');
    expect(layers[0]?.roles['implementer']).toEqual({
      model: 'g/file',
      tools: ['read'],
    });
    // Copied out: the projection holds its own array, not the live one.
    expect(layers[0]?.roles['implementer']?.tools).not.toBe(
      runtime.config.roles?.['implementer']?.tools,
    );
    expect(runtime.config.roles?.['implementer']?.tools).toEqual(['read']);
  });

  it('orders layers by CONFIG_LAYERS: global before project', () => {
    const home = tmpDir('kubic-layers-home-');
    const project = tmpDir('kubic-layers-project-');
    mkdirSync(join(home, '.kubic'), { recursive: true });
    writeFileSync(
      join(home, '.kubic', 'config.toml'),
      '[roles.alpha]\ntools = ["read"]\n',
    );
    mkdirSync(join(project, '.kubic'), { recursive: true });
    writeFileSync(
      join(project, '.kubic', 'config.toml'),
      '[roles.beta]\nmodel = "g/file"\n',
    );
    const result = loadCliConfig({
      cwd: project,
      home,
      env: { KUBIC_TRUST_PROJECT: '1' },
    });
    expect(result.error).toBeUndefined();
    const layers = roleLayersFromConfig(requireRuntimeConfig(result));
    expect(layers.map((entry) => entry.layer)).toEqual(['global', 'project']);
    expect(layers[0]?.roles['alpha']).toEqual({ tools: ['read'] });
    expect(layers[1]?.roles['beta']).toEqual({ model: 'g/file' });
  });

  it('is empty when no layer declares a role leaf', () => {
    const home = tmpDir('kubic-layers-empty-home-');
    const cwd = tmpDir('kubic-layers-empty-cwd-');
    const result = loadCliConfig({ cwd, home, env: {} });
    expect(roleLayersFromConfig(requireRuntimeConfig(result))).toEqual([]);
  });
});

describe('remaining projections stay fail-closed (issue #384)', () => {
  it('runtimePolicy is defined on a clean load, undefined on a refusal', () => {
    const { home, cwd } = globalHome('[model]\nprovider = "g"\nid = "file"\n');
    expect(runtimePolicy(loadCliConfig({ cwd, home, env: {} }))).toBeDefined();
    expect(runtimePolicy(refusedGlobal())).toBeUndefined();
  });

  it('a global pin is not a frozen enterprise pin and overrides nothing', () => {
    const { home, cwd } = globalHome('[model]\nprovider = "g"\nid = "file"\n');
    const result = loadCliConfig({ cwd, home, env: {} });
    // Frozen is the enterprise [model] path (host runtime tests pin it);
    // a file pin below enterprise never freezes and overrides nothing.
    expect(runtimeModelFrozen(result)).toBe(false);
    expect(runtimeModelPinNotes(result)).toEqual([]);
  });

  it('sessionRetentionDays, approvals, run and lane projections read one load', () => {
    const { home, cwd } = globalHome(
      '[agent]\nname = "alice"\n[approvals]\nroute = "deny"\nmaxPendingMs = 4321\n[session]\nretentionDays = 9\n[permissions]\nshell = false\n',
    );
    const result = loadCliConfig({ cwd, home, env: {} });
    expect(result.error).toBeUndefined();
    expect(sessionRetentionDays(result)).toBe(9);
    expect(runtimeApprovalDeps(result).route).toBe('deny');
    const run = runtimeRunDeps(result);
    expect(run.policySource).toBe('config');
    expect(run.policyClasses?.shell).toBe(false);
    expect(run.approvals?.route).toBe('deny');
    const lane = runtimeLaneDeps(result);
    expect(lane.agentId).toBe('alice');
    expect(lane.roles?.layers).toEqual([]);
    expect(typeof lane.roles?.trustProject).toBe('function');
    // A refused config contributes nothing: the command fails closed first.
    const refused = refusedGlobal();
    expect(sessionRetentionDays(refused)).toBeUndefined();
    expect(runtimeRunDeps(refused).policySource).toBe('default');
    expect(runtimeLaneDeps(refused)).toEqual({});
  });
});

describe('selectModelUnderPolicy gates before the registry (issue #384)', () => {
  function catalog(
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

  it('without a model policy it is exactly selectModel', () => {
    const { home, cwd } = globalHome('[model]\nprovider = "g"\nid = "file"\n');
    const policy = runtimePolicy(loadCliConfig({ cwd, home, env: {} }));
    const models = catalog([
      { provider: 'g', models: ['file'] },
      { provider: 'other', models: ['m'] },
    ]);
    expect(
      selectModelUnderPolicy(
        models,
        { provider: 'other', id: 'm' },
        undefined,
        undefined,
        policy,
      ).id,
    ).toBe('m');
    expect(
      selectModelUnderPolicy(
        models,
        undefined,
        { provider: 'g', id: 'file' },
        undefined,
        policy,
      ).id,
    ).toBe('file');
  });

  it('refuses a gated-out pin by name before any provider call', () => {
    const { home, cwd } = globalHome(
      '[policy]\nallowed_models = ["corp/approved"]\n',
    );
    const policy = runtimePolicy(loadCliConfig({ cwd, home, env: {} }));
    expect(policy).toBeDefined();
    const models = catalog([
      { provider: 'corp', models: ['approved'] },
      { provider: 'other', models: ['m'] },
    ]);
    expect(() =>
      selectModelUnderPolicy(
        models,
        { provider: 'other', id: 'm' },
        undefined,
        undefined,
        policy,
      ),
    ).toThrow(ModelSelectError);
    expect(() =>
      selectModelUnderPolicy(
        models,
        { provider: 'other', id: 'm' },
        undefined,
        undefined,
        policy,
      ),
    ).toThrow(/refused by enterprise policy/);
    // The allowed pin still selects.
    expect(
      selectModelUnderPolicy(
        models,
        { provider: 'corp', id: 'approved' },
        undefined,
        undefined,
        policy,
      ).id,
    ).toBe('approved');
  });
});

describe('end to end: the project [model] pin reaches the prod run runner (issue #384)', () => {
  // Scope says `[agent] model`; `[agent]` only carries `name` (config.ts:
  // checkNoUnknown(agent, {'name'})) — the top-level `[model]` pin is what
  // Evidence describes and what runtimeModelPin projects, so that is what
  // this drives through prodRunDeps, the builder the binary calls.
  it('project [model] provider/id becomes prodRunDeps.model', () => {
    const { home, project } = trustedProject(
      '[model]\nprovider = "g"\nid = "file"\n',
    );
    const result = loadCliConfig({
      cwd: project,
      home,
      env: { KUBIC_TRUST_PROJECT: '1' },
    });
    expect(result.error).toBeUndefined();
    expect(runtimeModelPin(result)).toEqual({ provider: 'g', id: 'file' });
    expect(prodRunDeps(result).model).toEqual({ provider: 'g', id: 'file' });
  });
});
