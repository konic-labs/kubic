import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkPinned } from './check-pinned-deps.mjs';
import { checkTree } from './dep-lint.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const PI_DEPS = [
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-tui',
  '@earendil-works/chord',
  '@earendil-works/pi-telemetry',
  '@earendil-works/pi-protocol',
];
const PI_VERSION = '0.87.1';

function fixturePackageJson(deps) {
  const dir = mkdtempSync(join(tmpdir(), 'pinned-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', private: true, dependencies: deps }),
  );
  return dir;
}

describe('pi pinning + boundary (issue #4)', () => {
  it('worker pins all six Pi deps exactly', () => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, 'packages', 'worker', 'package.json'), 'utf8'),
    );
    for (const dep of PI_DEPS) {
      assert.equal(
        pkg.dependencies?.[dep],
        PI_VERSION,
        `${dep} must be pinned to ${PI_VERSION}`,
      );
    }
  });

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
    const dir = mkdtempSync(join(tmpdir(), 'pinned-opt-'));
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

  it('pi-boundary.ts exists with seam docs and justification template', () => {
    const file = join(ROOT, 'packages', 'worker', 'src', 'pi-boundary.ts');
    assert.ok(existsSync(file), 'missing packages/worker/src/pi-boundary.ts');
    const src = readFileSync(file, 'utf8');
    for (const needle of ['ExecutionEnv', 'before_tool', 'JUSTIFICATION']) {
      assert.ok(src.includes(needle), `pi-boundary.ts must document ${needle}`);
    }
  });

  it('pi-boundary.ts is the only file allowed Pi imports', () => {
    const okDir = mkdtempSync(join(tmpdir(), 'piseam-ok-'));
    mkdirSync(join(okDir, 'packages', 'worker', 'src'), { recursive: true });
    writeFileSync(
      join(okDir, 'packages', 'worker', 'src', 'pi-boundary.ts'),
      `import type { Agent } from '@earendil-works/pi-agent-core';\n`,
    );
    assert.deepEqual(checkTree(okDir), []);
  });

  it('worker files outside pi-boundary.ts must not import Pi', () => {
    const dir = mkdtempSync(join(tmpdir(), 'piseam-bad-'));
    mkdirSync(join(dir, 'packages', 'worker', 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'packages', 'worker', 'src', 'tools.ts'),
      `import { Agent } from '@earendil-works/pi-agent-core';\n`,
    );
    const violations = checkTree(dir);
    assert.ok(
      violations.some(
        (v) => v.from === 'worker' && v.to.includes('pi-agent-core'),
      ),
      `expected worker Pi-seam violation, got ${JSON.stringify(violations)}`,
    );
  });

  it('similarly-suffixed worker files must not import Pi', () => {
    const dir = mkdtempSync(join(tmpdir(), 'piseam-suffix-'));
    mkdirSync(join(dir, 'packages', 'worker', 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'packages', 'worker', 'src', 'fake-pi-boundary.ts'),
      `import { Agent } from '@earendil-works/pi-agent-core';\n`,
    );
    const violations = checkTree(dir);
    assert.ok(
      violations.some(
        (v) => v.from === 'worker' && v.to.includes('pi-agent-core'),
      ),
      `expected suffix-bypass violation, got ${JSON.stringify(violations)}`,
    );
  });

  it('non-worker packages must not import Pi', () => {
    const dir = mkdtempSync(join(tmpdir(), 'piseam-host-'));
    mkdirSync(join(dir, 'packages', 'host', 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'packages', 'host', 'src', 'dispatch.ts'),
      `import { x } from '@earendil-works/chord';\n`,
    );
    const violations = checkTree(dir);
    assert.ok(
      violations.some((v) => v.from === 'host'),
      `expected host Pi-seam violation, got ${JSON.stringify(violations)}`,
    );
  });

  it('CODEOWNERS flags pi-boundary.ts', () => {
    const file = join(ROOT, 'CODEOWNERS');
    assert.ok(existsSync(file), 'missing CODEOWNERS');
    const src = readFileSync(file, 'utf8');
    assert.ok(
      src.includes('packages/worker/src/pi-boundary.ts'),
      'CODEOWNERS must own pi-boundary.ts',
    );
  });

  it('CI runs the pinned-deps check', () => {
    const yml = readFileSync(
      join(ROOT, '.github', 'workflows', 'ci.yml'),
      'utf8',
    );
    assert.ok(yml.includes('check:pi'), 'ci.yml must run check:pi');
  });

  it('lockfile pins the Pi deps', () => {
    const lock = JSON.parse(
      readFileSync(join(ROOT, 'package-lock.json'), 'utf8'),
    );
    const pkgs = lock.packages ?? {};
    for (const dep of PI_DEPS) {
      const key = `node_modules/${dep}`;
      assert.equal(
        pkgs[key]?.version,
        PI_VERSION,
        `lockfile must pin ${dep}@${PI_VERSION}`,
      );
    }
  });
});
