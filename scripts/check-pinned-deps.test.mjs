// Exact-pin check for every dependency (issue #4; Pi 1.0: 1.0.2).
//
// `scripts/check-pinned-deps.mjs` (`npm run check:pi`) rejects every
// `^`/`~`/range spec on `@earendil-works/*` and the CLI stack: the runtime
// tree must not move under a release. Moved out of
// `scripts/pi-boundary.test.mjs` (issue #376) so every gate has a
// same-named test.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkPinned } from './check-pinned-deps.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const scratchDirs = [];
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function fixturePackageJson(deps) {
  const dir = scratchDir('pinned-');
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', private: true, dependencies: deps }),
  );
  return dir;
}

describe('check-pinned-deps (issue #4)', () => {
  it('pinned check passes on the clean tree', () => {
    assert.deepEqual(checkPinned(ROOT), []);
  });

  it('pinned check rejects ^/~ ranges on Pi deps', () => {
    const dir = fixturePackageJson({ '@earendil-works/pi-ai': '^0.85.1' });
    const violations = checkPinned(dir);
    assert.ok(
      violations.some((v) => v.dep === '@earendil-works/pi-ai'),
      `expected range violation, got ${JSON.stringify(violations)}`,
    );
  });

  it('pinned check rejects ranges in optionalDependencies', () => {
    const dir = scratchDir('pinned-opt-');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        private: true,
        optionalDependencies: { '@earendil-works/pi-ai': '~0.85.1' },
      }),
    );
    const violations = checkPinned(dir);
    assert.ok(
      violations.some((v) => v.dep === '@earendil-works/pi-ai'),
      `expected range violation, got ${JSON.stringify(violations)}`,
    );
  });

  it('pinned check rejects ranges on any third-party dep (CLI stack)', () => {
    const dir = fixturePackageJson({ chalk: '^6.0.0', commander: '15.0.0' });
    assert.deepEqual(
      checkPinned(dir).map((v) => v.dep),
      ['chalk'],
    );
  });

  it('pinned check rejects ranges in peerDependencies', () => {
    const dir = fixturePackageJson({});
    mkdirSync(join(dir, 'packages', 'worker'), { recursive: true });
    writeFileSync(
      join(dir, 'packages', 'worker', 'package.json'),
      JSON.stringify({
        name: '@kubic/worker',
        peerDependencies: { '@earendil-works/pi-ai': '>=0.85.1' },
      }),
    );
    const violations = checkPinned(dir);
    assert.ok(
      violations.some((v) => v.dep === '@earendil-works/pi-ai'),
      `expected range violation, got ${JSON.stringify(violations)}`,
    );
  });

  it('pinned check rejects ranges in overrides', () => {
    const dir = fixturePackageJson({});
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        private: true,
        overrides: {
          '@earendil-works/pi-ai': '^0.85.1',
          lodash: '^4.0.0',
        },
      }),
    );
    const violations = checkPinned(dir);
    assert.deepEqual(
      violations.map((v) => `${v.file}:${v.dep}@${v.spec}:${v.reason}`),
      ['package.json:@earendil-works/pi-ai@^0.85.1:range-not-exact'],
    );
  });

  it('pinned check passes exact pins in overrides', () => {
    const dir = fixturePackageJson({});
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        private: true,
        overrides: { '@earendil-works/pi-ai': '0.85.1' },
      }),
    );
    assert.deepEqual(checkPinned(dir), []);
  });

  it('pinned check ignores null overrides (npm deletion marker)', () => {
    const dir = fixturePackageJson({});
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        private: true,
        overrides: { '@earendil-works/pi-ai': null },
      }),
    );
    assert.deepEqual(checkPinned(dir), []);
  });

  it('pinned module has no import side effects', async () => {
    const writes = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      writes.push(String(chunk));
      return true;
    };
    try {
      await import(`./check-pinned-deps.mjs?silent=${Date.now()}`);
    } finally {
      process.stdout.write = original;
    }
    assert.deepEqual(writes, []);
  });

  it('pinned check scans apps manifests too', () => {
    const dir = fixturePackageJson({});
    mkdirSync(join(dir, 'apps', 'kubic'), { recursive: true });
    writeFileSync(
      join(dir, 'apps', 'kubic', 'package.json'),
      JSON.stringify({
        name: 'kubic',
        dependencies: { '@earendil-works/pi-ai': '~0.85.1' },
      }),
    );
    const violations = checkPinned(dir);
    assert.deepEqual(
      violations.map((v) => `${v.file}:${v.dep}`),
      ['apps/kubic/package.json:@earendil-works/pi-ai'],
    );
  });

  it('pinned check ignores non-Pi ranges in overrides only', () => {
    const dir = scratchDir('pinned-ovr-nonpi-');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        private: true,
        dependencies: { '@earendil-works/pi-ai': '0.85.1' },
        overrides: { lodash: '^4.0.0' },
      }),
    );
    assert.deepEqual(checkPinned(dir), []);
  });

  it('pinned check rejects non-string specs', () => {
    const dir = fixturePackageJson({});
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        dependencies: { '@earendil-works/pi-ai': null },
      }),
    );
    const violations = checkPinned(dir);
    assert.deepEqual(
      violations.map((v) => `${v.dep}:${v.reason}`),
      ['@earendil-works/pi-ai:range-not-exact'],
    );
  });

  it('pinned check skips invalid manifests and missing trees', () => {
    const dir = scratchDir('pinned-bad-');
    writeFileSync(join(dir, 'package.json'), 'not json\n');
    assert.deepEqual(checkPinned(dir), []);
  });

  it('pinned check accepts exact multi-digit and prerelease pins', () => {
    const dir = fixturePackageJson({
      '@earendil-works/pi-ai': '0.85.1-beta.1',
    });
    assert.deepEqual(checkPinned(dir), []);
    for (const spec of ['10.0.0', '0.85.10']) {
      const d = fixturePackageJson({ '@earendil-works/pi-ai': spec });
      assert.deepEqual(
        checkPinned(d),
        [],
        `exact pin ${JSON.stringify(spec)} must pass`,
      );
    }
  });

  it('pinned check rejects pins with trailing garbage', () => {
    const dir = fixturePackageJson({ '@earendil-works/pi-ai': '0.85.1 ' });
    const violations = checkPinned(dir);
    assert.deepEqual(
      violations.map((v) => `${v.dep}@${v.spec}`),
      ['@earendil-works/pi-ai@0.85.1 '],
    );
  });

  it('pinned check reports the exact violation shape', () => {
    const dir = fixturePackageJson({
      '@earendil-works/pi-ai': '~0.85.1',
    });
    assert.deepEqual(checkPinned(dir), [
      {
        file: 'package.json',
        dep: '@earendil-works/pi-ai',
        spec: '~0.85.1',
        reason: 'range-not-exact',
      },
    ]);
  });

  it('pinned CLI exits 0 printing OK on the clean tree', () => {
    const out = execFileSync(
      process.execPath,
      [join(ROOT, 'scripts', 'check-pinned-deps.mjs'), ROOT],
      { encoding: 'utf8' },
    );
    assert.match(out, /dependency pins OK/);
  });

  it('pinned CLI exits 1 listing violations', () => {
    const dir = fixturePackageJson({
      '@earendil-works/pi-ai': '^0.85.1',
    });
    // spawnSync, not execFileSync in a try/catch: the catch would also
    // swallow an assert.fail thrown inside the try.
    const result = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts', 'check-pinned-deps.mjs'), dir],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1, 'CLI must exit 1 on an unpinned tree');
    assert.match(result.stdout, /is not an exact pin/);
    assert.match(result.stdout, /1 unpinned dependency\(ies\)/);
    assert.doesNotMatch(result.stdout, /dependency pins OK/);
  });

  it('pinned check rejects ranges in devDependencies', () => {
    const dir = fixturePackageJson({});
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        devDependencies: { '@earendil-works/pi-ai': '^0.85.1' },
      }),
    );
    const violations = checkPinned(dir);
    assert.deepEqual(
      violations.map((v) => `${v.dep}@${v.spec}`),
      ['@earendil-works/pi-ai@^0.85.1'],
    );
  });

  it('pinned CLI defaults to the parent root', () => {
    const out = execFileSync(
      process.execPath,
      [join(ROOT, 'scripts', 'check-pinned-deps.mjs')],
      { encoding: 'utf8', cwd: join(ROOT, 'scripts') },
    );
    assert.match(out, /dependency pins OK/);
  });

  it('pinned check skips invalid package manifests', () => {
    const dir = fixturePackageJson({});
    mkdirSync(join(dir, 'packages', 'broken'), { recursive: true });
    writeFileSync(
      join(dir, 'packages', 'broken', 'package.json'),
      'not json\n',
    );
    assert.deepEqual(checkPinned(dir), []);
  });

  it('pinned check tolerates missing packages and apps trees', () => {
    const dir = scratchDir('pinned-empty-');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'fixture', private: true }),
    );
    assert.deepEqual(checkPinned(dir), []);
  });
});
