import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkTree } from './dep-lint.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const PI_DEPS = [
  '@earendil-works/chord',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-durable',
  '@earendil-works/pi-tui',
];
// Dropped in the Pi 1.0 migration: pi-agent-core lost the
// harness, and nothing imports pi-protocol / pi-telemetry directly.
const REMOVED_PI_DEPS = [
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-protocol',
  '@earendil-works/pi-telemetry',
];
// Gone from the lockfile entirely — nothing depends on them transitively.
const GONE_FROM_LOCK = [
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-protocol',
];
// Transitive Pi deps re-pinned to PI_VERSION by a root `overrides` entry
// (pi-ai@1.0.2 declares pi-telemetry with a caret).
const OVERRIDDEN_PI_DEPS = ['@earendil-works/pi-telemetry'];
const PI_VERSION = '1.0.2';

const scratchDirs = [];
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

// Every `export` statement in either Pi boundary file must be
// preceded by the JUSTIFICATION block the file's own template requires.
// Returns the 1-based line numbers of unjustified exports.
function unjustifiedExports(source) {
  const bad = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^export\b/.test(lines[i])) continue;
    let j = i - 1;
    while (j >= 0 && lines[j].trim() === '') j--;
    const block = [];
    while (j >= 0 && lines[j].startsWith('//')) {
      block.unshift(lines[j]);
      j--;
    }
    if (!block.some((line) => line.includes('JUSTIFICATION'))) bad.push(i + 1);
  }
  return bad;
}

// / commit 83ee635: exactly ONE hoisted copy of every Pi package.
// Walks the lockfile's `packages` map (v3 is authoritative) and returns one
// `{ name, paths }` entry per `@earendil-works/*` package resolved at more
// than one path — a hoisted root copy plus a nested one under a workspace or
// under pi-durable. Sub-paths (a `dist/` entry) never match: the check is
// about package roots. Sorted by name for a stable assertion.
function duplicatePiCopies(lock) {
  const pkgs = lock?.packages ?? {};
  const copies = new Map();
  for (const path of Object.keys(pkgs)) {
    const match = /(?:^|\/)node_modules\/(@earendil-works\/[^/]+)$/.exec(path);
    if (match === null) continue;
    const name = match[1];
    copies.set(name, [...(copies.get(name) ?? []), path]);
  }
  return [...copies.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([name, paths]) => ({ name, paths: [...paths].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

describe('pi pinning + boundary', () => {
  it('worker pins all four Pi deps exactly and drops the removed three', () => {
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
    for (const dep of REMOVED_PI_DEPS) {
      assert.equal(
        pkg.dependencies?.[dep],
        undefined,
        `${dep} must be gone from the worker manifest`,
      );
    }
  });

  it('root overrides pin the transitive Pi telemetry exactly', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    // pi-ai@1.0.2 declares `@earendil-works/pi-telemetry: ^1.0.2`; Kubic
    // re-pins it exactly so a telemetry release cannot move the runtime tree.
    assert.equal(
      pkg.overrides?.['@earendil-works/pi-telemetry'],
      PI_VERSION,
      `pi-telemetry must be overridden to ${PI_VERSION}`,
    );
  });

  it('pi-boundary.ts exists with seam docs and justification template', () => {
    const file = join(ROOT, 'packages', 'worker', 'src', 'pi-boundary.ts');
    assert.ok(existsSync(file), 'missing packages/worker/src/pi-boundary.ts');
    const src = readFileSync(file, 'utf8');
    for (const needle of ['ExecutionEnv', 'beforeTool', 'JUSTIFICATION']) {
      assert.ok(src.includes(needle), `pi-boundary.ts must document ${needle}`);
    }
  });

  it('both Pi boundary files justify every export', () => {
    for (const rel of [
      join('packages', 'worker', 'src', 'pi-boundary.ts'),
      join('packages', 'tui', 'src', 'tui-boundary.ts'),
    ]) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      assert.deepEqual(
        unjustifiedExports(src),
        [],
        `${rel}: export statements need a JUSTIFICATION block`,
      );
    }
  });

  it('the justification gate fails a fixture export without one', () => {
    assert.deepEqual(unjustifiedExports('export const x = 1;\n'), [1]);
    assert.deepEqual(unjustifiedExports('// note\nexport const x = 1;\n'), [2]);
    assert.deepEqual(
      unjustifiedExports(
        '// JUSTIFICATION:\n//   seam: x\nexport const x = 1;\n',
      ),
      [],
    );
    // Blank lines between the block and the export are fine; a second
    // export after another statement needs its own block.
    assert.deepEqual(
      unjustifiedExports(
        '// JUSTIFICATION:\n\nexport const x = 1;\nexport const y = 2;\n',
      ),
      [4],
    );
  });

  it('pi-boundary.ts itself may import Pi', () => {
    const okDir = scratchDir('piseam-ok-');
    mkdirSync(join(okDir, 'packages', 'worker', 'src'), { recursive: true });
    writeFileSync(
      join(okDir, 'packages', 'worker', 'src', 'pi-boundary.ts'),
      `import type { Agent } from '@earendil-works/pi-agent-core';\n`,
    );
    assert.deepEqual(checkTree(okDir), []);
  });

  it('worker files outside pi-boundary.ts must not import Pi', () => {
    const dir = scratchDir('piseam-bad-');
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
    const dir = scratchDir('piseam-suffix-');
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
    const dir = scratchDir('piseam-host-');
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

  // / commit 83ee635: the built binary could not load
  // @earendil-works/chord from dist/ because the lockfile NESTED a
  // second copy of pi-ai and chord (under packages/worker and under
  // pi-durable) instead of hoisting them — all at 1.0.2, so the pin check
  // below stayed green, vitest resolved from source so the suite stayed
  // green, and only the binary contract caught it. One hoisted copy of every
  // `@earendil-works/*` package is the invariant a lockfile refresh must not
  // break; two copies of pi-ai would also give Kubic and pi-durable separate
  // module instances.
  it('the lockfile resolves exactly one copy of every Pi package', () => {
    const lock = JSON.parse(
      readFileSync(join(ROOT, 'package-lock.json'), 'utf8'),
    );
    assert.deepEqual(
      duplicatePiCopies(lock),
      [],
      'the lockfile must hoist ONE copy of every @earendil-works/* package ' +
        '(a nested duplicate broke the built binary: 83ee635)',
    );
  });

  it('the one-copy gate fails a fixture lock with a nested duplicate', () => {
    const fixture = {
      lockfileVersion: 3,
      packages: {
        '': { name: 'fixture' },
        'node_modules/@earendil-works/chord': { version: '1.0.2' },
        'node_modules/@earendil-works/pi-ai': { version: '1.0.2' },
        // The 83ee635 shape: pi-durable nests its own pi-ai copy.
        'node_modules/@earendil-works/pi-durable/node_modules/@earendil-works/pi-ai':
          { version: '1.0.2' },
        // A workspace-level nest counts too (packages/worker held one).
        'packages/worker/node_modules/@earendil-works/chord': {
          version: '1.0.2',
        },
        // Unrelated packages and deeper sub-paths never participate.
        'node_modules/lodash': { version: '4.17.21' },
        'node_modules/@earendil-works/pi-tui/dist': { version: '1.0.2' },
      },
    };
    assert.deepEqual(duplicatePiCopies(fixture), [
      {
        name: '@earendil-works/chord',
        paths: [
          'node_modules/@earendil-works/chord',
          'packages/worker/node_modules/@earendil-works/chord',
        ],
      },
      {
        name: '@earendil-works/pi-ai',
        paths: [
          'node_modules/@earendil-works/pi-ai',
          'node_modules/@earendil-works/pi-durable/node_modules/@earendil-works/pi-ai',
        ],
      },
    ]);
    // One copy each: the gate stays silent.
    assert.deepEqual(
      duplicatePiCopies({
        packages: {
          'node_modules/@earendil-works/pi-durable': { version: '1.0.2' },
          'node_modules/@earendil-works/pi-telemetry': { version: '1.0.2' },
        },
      }),
      [],
    );
    // A missing/absent `packages` map is not a duplicate report.
    assert.deepEqual(duplicatePiCopies({}), []);
  });

  it('lockfile pins every copy of the Pi deps and drops the removed two', () => {
    const lock = JSON.parse(
      readFileSync(join(ROOT, 'package-lock.json'), 'utf8'),
    );
    const pkgs = lock.packages ?? {};
    for (const dep of [...PI_DEPS, ...OVERRIDDEN_PI_DEPS]) {
      // npm may hoist or nest each copy (pi-ai appears both under the worker
      // and under pi-durable), so pin every resolved copy, not one path.
      const suffix = `node_modules/${dep}`;
      const copies = Object.entries(pkgs).filter(
        ([path]) => path === suffix || path.endsWith(`/${suffix}`),
      );
      assert.ok(copies.length > 0, `lockfile must contain ${dep}`);
      for (const [path, entry] of copies) {
        assert.equal(
          entry.version,
          PI_VERSION,
          `${path} must be pinned to ${PI_VERSION}`,
        );
      }
    }
    for (const dep of GONE_FROM_LOCK) {
      const suffix = `/node_modules/${dep}`;
      const copies = Object.keys(pkgs).filter(
        (path) => path === `node_modules/${dep}` || path.endsWith(suffix),
      );
      assert.deepEqual(copies, [], `${dep} must be gone from the lockfile`);
    }
  });
});
