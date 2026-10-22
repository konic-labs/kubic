// Unit tests for the pure parts of scripts/pack-install-contract.mjs: the
// packed file list, the probe verdicts, the loopback registry's packument and
// the comparison of an installed tree with npm-shrinkwrap.json. The contract
// itself installs real packages, so it runs in CI's pack-contract job
// (`npm run release:contract`), not here.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  doctorProblems,
  fileListProblems,
  footprintProblems,
  INSTALL_BUDGET_BYTES,
  installedTreeProblems,
  packument,
  REQUIRED_FILES,
  runProblems,
  versionProblems,
} from './pack-install-contract.mjs';

const LISTING = [...REQUIRED_FILES, 'dist/kubic.js.map'].map(
  (file) => `package/${file}`,
);

describe('fileListProblems', () => {
  it('accepts exactly the release files', () => {
    assert.deepEqual(fileListProblems(LISTING), []);
  });

  it('accepts the images the README shows and names one that is missing', () => {
    const images = ['docs/assets/a.png'];
    assert.deepEqual(
      fileListProblems([...LISTING, 'package/docs/assets/a.png'], images),
      [],
    );
    assert.deepEqual(fileListProblems(LISTING, images), [
      'missing docs/assets/a.png',
    ]);
  });

  it('names a required file the tarball lacks', () => {
    const listing = LISTING.filter((entry) => !entry.endsWith('NOTICE.md'));
    assert.deepEqual(fileListProblems(listing), ['missing NOTICE.md']);
  });

  it('names every file outside the allow-list, with the reason it must not ship', () => {
    const problems = fileListProblems([
      ...LISTING,
      'package/dist/apps/kubic/src/main.test.js',
      'package/packages/core/src/license.ts',
      'package/scripts/build.mjs',
      'package/docs/README.md',
      'package/.github/workflows/ci.yml',
      'package/.kubic/config.toml',
      'package/CLAUDE.md',
      'package/package-lock.json',
      'package/tsconfig.base.json',
      'package/vitest.config.ts',
      'package/notes.txt',
    ]);
    assert.deepEqual(problems, [
      'unexpected dist/apps/kubic/src/main.test.js (a test file)',
      'unexpected packages/core/src/license.ts (TypeScript source)',
      'unexpected scripts/build.mjs (repository tooling)',
      'unexpected docs/README.md (repository docs)',
      'unexpected .github/workflows/ci.yml (CI configuration)',
      'unexpected .kubic/config.toml (local Kubic state)',
      'unexpected CLAUDE.md (private agent notes)',
      'unexpected package-lock.json (the development lockfile)',
      'unexpected tsconfig.base.json (development configuration)',
      'unexpected vitest.config.ts (TypeScript source)',
      'unexpected notes.txt',
    ]);
  });
});

describe('versionProblems', () => {
  const ok = { code: 0, stdout: 'kubic 0.1.0 (license: MIT)\n', stderr: '' };

  it('accepts the exact version line', () => {
    assert.deepEqual(versionProblems(ok, '0.1.0'), []);
  });

  it('names a wrong line and a failed exit', () => {
    assert.equal(versionProblems(ok, '0.2.0').length, 1);
    assert.equal(versionProblems({ ...ok, code: 1 }, '0.1.0').length, 1);
  });
});

describe('doctorProblems', () => {
  it('accepts a printed summary whatever the exit code', () => {
    const result = {
      code: 6,
      stdout:
        'FAIL limit:provider-availability\ndoctor: 16 pass, 6 warn, 1 fail, 0 skip\n',
      stderr: '',
    };
    assert.deepEqual(doctorProblems(result), []);
  });

  it('names a doctor that printed no summary', () => {
    const result = { code: 1, stdout: '', stderr: 'boom' };
    assert.equal(doctorProblems(result).length, 1);
  });
});

describe('runProblems', () => {
  it('accepts a completed JSON envelope', () => {
    const result = {
      code: 0,
      stdout: `${JSON.stringify({ ok: true, status: 'completed' })}\n`,
      stderr: '',
    };
    assert.deepEqual(runProblems(result), []);
  });

  it('names a failed exit, unparsable output and a wrong status', () => {
    assert.equal(runProblems({ code: 6, stdout: '', stderr: 'x' }).length, 1);
    assert.equal(
      runProblems({ code: 0, stdout: 'hello', stderr: '' }).length,
      1,
    );
    const failed = JSON.stringify({ ok: false, status: 'failed' });
    assert.equal(
      runProblems({ code: 0, stdout: failed, stderr: '' }).length,
      1,
    );
  });
});

describe('packument', () => {
  it('serves one version that declares its shrinkwrap', () => {
    const doc = packument(
      { name: 'kubic', version: '0.1.0', license: 'MIT' },
      Buffer.from('tarball bytes'),
      'http://127.0.0.1:4873',
    );
    assert.deepEqual(doc['dist-tags'], { latest: '0.1.0' });
    const version = doc.versions['0.1.0'];
    assert.equal(version._hasShrinkwrap, true);
    assert.equal(
      version.dist.tarball,
      'http://127.0.0.1:4873/kubic/-/kubic-0.1.0.tgz',
    );
    assert.match(version.dist.integrity, /^sha512-/);
    assert.match(version.dist.shasum, /^[0-9a-f]{40}$/);
  });
});

describe('installedTreeProblems', () => {
  const shrinkwrap = {
    packages: {
      '': { name: 'kubic' },
      'node_modules/consola': { version: '3.4.2' },
      'node_modules/ws': { version: '8.18.0' },
    },
  };

  it('accepts a tree with every package at its locked version', () => {
    const installed = {
      'node_modules/consola': '3.4.2',
      'node_modules/ws': '8.18.0',
    };
    assert.deepEqual(
      installedTreeProblems(shrinkwrap, (path) => installed[path]),
      [],
    );
  });

  it('names a package installed at another version, and a missing one', () => {
    const installed = { 'node_modules/ws': '8.22.0' };
    assert.deepEqual(
      installedTreeProblems(shrinkwrap, (path) => installed[path]),
      [
        'node_modules/consola: not installed (locked at 3.4.2)',
        'node_modules/ws: installed 8.22.0, locked at 8.18.0',
      ],
    );
  });
});

describe('footprintProblems', () => {
  it('accepts an install within the budget', () => {
    assert.deepEqual(footprintProblems(140 * 1024 * 1024), []);
  });

  it('names an install above the budget, such as every platform binary', () => {
    const problems = footprintProblems(INSTALL_BUDGET_BYTES + 1);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /above the .* budget/);
  });
});
