// Composition-root trust wiring (issue #228; §35.1): the persisted
// decision under `~/.kubic/trust.json` is what makes a committed
// `.kubic/config.toml` usable, with no env var exported per invocation.
//
// These tests drive the real `loadCliConfig` over temp home/project dirs
// (no network, no paid tokens) and clean every temp dir up in `afterEach`.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ProjectTrustStore,
  projectTrustStorePath,
} from '../../../packages/host/src/config/trust-store.js';
import {
  loadCliConfig,
  projectTrustFor,
  resolveInteractiveProjectTrust,
} from './config-runtime.js';

const made: string[] = [];

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
