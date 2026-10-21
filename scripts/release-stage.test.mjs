// Unit tests for the pure parts of scripts/release-stage.mjs: the generated
// release manifest, the lockfile it is seeded with, and the checks on the
// shrinkwrap, the packed tarball and the SBOM. Staging itself runs in CI's
// pack-contract job (`npm run release:stage`).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  dropPlatformEntries,
  finishSbom,
  PACK_BUDGET_BYTES,
  packProblems,
  RELEASE_FILES,
  releaseManifest,
  sbomFileName,
  sbomProblems,
  seedLockfile,
  shrinkwrapProblems,
} from './release-stage.mjs';

const ROOT_MANIFEST = {
  name: 'kubic',
  version: '0.1.0',
  private: true,
  license: 'MIT',
  type: 'module',
  description: 'Kubic',
  bin: { kubic: 'bin/kubic.js' },
  engines: { node: '>=22.19' },
  workspaces: ['packages/*', 'apps/*'],
  scripts: { build: 'node scripts/build.mjs' },
  devDependencies: { vitest: '5.0.3' },
  dependencies: { consola: '3.4.2', '@earendil-works/pi-ai': '1.0.2' },
  overrides: { ws: '8.0.0' },
};

const ROOT_LOCK = {
  name: 'kubic',
  version: '0.1.0',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': { name: 'kubic', workspaces: ['packages/*'] },
    'packages/core': { name: '@kubic/core', version: '0.0.0' },
    'node_modules/@kubic/core': { resolved: 'packages/core', link: true },
    'node_modules/consola': { version: '3.4.2' },
    'node_modules/vitest': { version: '5.0.3', dev: true },
  },
};

describe('releaseManifest', () => {
  it('keeps the published fields and the files allow-list, nothing else', () => {
    assert.deepEqual(releaseManifest(ROOT_MANIFEST), {
      name: 'kubic',
      version: '0.1.0',
      description: 'Kubic',
      license: 'MIT',
      type: 'module',
      bin: { kubic: 'bin/kubic.js' },
      engines: { node: '>=22.19' },
      dependencies: { consola: '3.4.2', '@earendil-works/pi-ai': '1.0.2' },
      files: RELEASE_FILES,
    });
  });

  it('carries the optional registry fields when the root declares them', () => {
    const manifest = releaseManifest({
      ...ROOT_MANIFEST,
      repository: { type: 'git', url: 'git+https://example.com/kubic.git' },
      keywords: ['agent'],
    });
    assert.deepEqual(manifest.keywords, ['agent']);
    assert.equal(manifest.repository.url, 'git+https://example.com/kubic.git');
  });

  it('lists the shrinkwrap among the published files', () => {
    assert.ok(RELEASE_FILES.includes('npm-shrinkwrap.json'));
  });
});

describe('seedLockfile', () => {
  it('keeps the installed packages and drops workspace folders and links', () => {
    const seed = seedLockfile(ROOT_LOCK, releaseManifest(ROOT_MANIFEST));
    assert.deepEqual(Object.keys(seed.packages), [
      '',
      'node_modules/consola',
      'node_modules/vitest',
    ]);
    assert.equal(seed.lockfileVersion, 3);
  });

  it('describes the release package at the root entry', () => {
    const seed = seedLockfile(ROOT_LOCK, releaseManifest(ROOT_MANIFEST));
    assert.deepEqual(seed.packages[''], {
      name: 'kubic',
      version: '0.1.0',
      license: 'MIT',
      bin: { kubic: 'bin/kubic.js' },
      engines: { node: '>=22.19' },
      dependencies: { consola: '3.4.2', '@earendil-works/pi-ai': '1.0.2' },
    });
  });
});

describe('dropPlatformEntries', () => {
  it('drops the optional entries restricted to one platform, nothing else', () => {
    const shrinkwrap = {
      packages: {
        '': { name: 'kubic' },
        'node_modules/esbuild': {
          version: '0.28.2',
          optionalDependencies: { '@esbuild/linux-x64': '0.28.2' },
        },
        'node_modules/@esbuild/linux-x64': {
          version: '0.28.2',
          optional: true,
          os: ['linux'],
          cpu: ['x64'],
        },
        'node_modules/fsevents': {
          version: '2.3.3',
          optional: true,
          os: ['darwin'],
        },
        'node_modules/optional-anywhere': { version: '1.0.0', optional: true },
      },
    };
    const { shrinkwrap: kept, dropped } = dropPlatformEntries(shrinkwrap);
    assert.deepEqual(dropped, [
      'node_modules/@esbuild/linux-x64',
      'node_modules/fsevents',
    ]);
    assert.deepEqual(Object.keys(kept.packages), [
      '',
      'node_modules/esbuild',
      'node_modules/optional-anywhere',
    ]);
  });
});

describe('shrinkwrapProblems', () => {
  const clean = {
    packages: {
      '': { name: 'kubic' },
      'node_modules/consola': { version: '3.4.2' },
    },
  };

  it('accepts a production tree at the tested versions', () => {
    assert.deepEqual(shrinkwrapProblems(clean, ROOT_LOCK), []);
  });

  it('names links, dev entries, extraneous entries and foreign keys', () => {
    const problems = shrinkwrapProblems(
      {
        packages: {
          '': { name: 'kubic' },
          'node_modules/@kubic/core': { link: true, resolved: 'packages/core' },
          'node_modules/vitest': { version: '5.0.3', dev: true },
          'node_modules/consola': { version: '3.4.2', extraneous: true },
          'packages/core': { version: '0.0.0' },
        },
      },
      ROOT_LOCK,
    );
    assert.deepEqual(problems, [
      'node_modules/@kubic/core: a link entry (a workspace leaked into the release tree)',
      'node_modules/vitest: a dev entry',
      'node_modules/consola: an extraneous entry',
      'packages/core: not a node_modules path',
    ]);
  });

  it('names an entry restricted to one platform', () => {
    const problems = shrinkwrapProblems(
      {
        packages: {
          '': {},
          'node_modules/consola': {
            version: '3.4.2',
            optional: true,
            os: ['linux'],
          },
        },
      },
      ROOT_LOCK,
    );
    assert.deepEqual(problems, [
      'node_modules/consola: restricted to one platform; npm 11 would install it on every platform',
    ]);
  });

  it('names a version that differs from the tested lockfile', () => {
    const problems = shrinkwrapProblems(
      { packages: { '': {}, 'node_modules/consola': { version: '3.4.3' } } },
      ROOT_LOCK,
    );
    assert.deepEqual(problems, [
      'node_modules/consola: 3.4.3, but the tested package-lock.json has 3.4.2',
    ]);
  });

  it('names a package the tested lockfile does not have', () => {
    const problems = shrinkwrapProblems(
      { packages: { '': {}, 'node_modules/left-pad': { version: '1.3.0' } } },
      ROOT_LOCK,
    );
    assert.deepEqual(problems, [
      'node_modules/left-pad: 1.3.0 is not in the tested package-lock.json',
    ]);
  });
});

describe('packProblems', () => {
  const pack = { size: 400_000, entryCount: 9 };

  it('accepts a tarball within the budget', () => {
    assert.deepEqual(packProblems(pack), []);
  });

  it('names a tarball above the budget', () => {
    const problems = packProblems({ ...pack, size: PACK_BUDGET_BYTES + 1 });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /above the .* budget/);
  });
});

describe('the SBOM', () => {
  const shrinkwrap = {
    packages: {
      '': { name: 'kubic', version: '0.1.0' },
      'node_modules/consola': { version: '3.4.2' },
      'node_modules/@earendil-works/pi-ai': { version: '1.0.2' },
      'node_modules/a/node_modules/b': { version: '2.0.0' },
    },
  };
  const sbom = {
    bomFormat: 'CycloneDX',
    metadata: {
      component: {
        'bom-ref': 'kubic@0.1.0',
        name: 'release',
        version: '0.1.0',
      },
    },
    components: [
      { name: 'consola', version: '3.4.2' },
      { name: '@earendil-works/pi-ai', version: '1.0.2' },
      { name: 'b', version: '2.0.0' },
    ],
  };

  it('is named after the package and sits beside the tarball', () => {
    assert.equal(
      sbomFileName({ name: 'kubic', version: '0.1.0' }),
      'kubic-0.1.0.cdx.json',
    );
  });

  it('names the root component after the package, not the staging folder', () => {
    const finished = finishSbom(sbom, { name: 'kubic', version: '0.1.0' });
    assert.equal(finished.metadata.component.name, 'kubic');
    assert.equal(finished.metadata.component['bom-ref'], 'kubic@0.1.0');
    assert.deepEqual(finished.components, sbom.components);
  });

  it('accepts an SBOM that lists every pinned package', () => {
    assert.deepEqual(sbomProblems(sbom, shrinkwrap), []);
  });

  it('names a pinned package the SBOM misses, and a non-CycloneDX document', () => {
    const missing = { ...sbom, components: sbom.components.slice(1) };
    assert.deepEqual(sbomProblems(missing, shrinkwrap), [
      'the SBOM does not list consola@3.4.2',
    ]);
    assert.deepEqual(sbomProblems({ bomFormat: 'SPDX' }, shrinkwrap), [
      'the SBOM is not CycloneDX',
    ]);
  });
});
