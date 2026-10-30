// The Pi dependency contract: exact pins in the two workspace manifests that
// declare Pi and in the root manifest npm installs (which also pins Pi's
// transitive telemetry package), one hoisted copy of every Pi package in the
// lockfile, and a JUSTIFICATION block on every
// export of the two boundary files (which files may import Pi at all is
// `npm run lint:deps`).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const PI_DEPS = [
  '@earendil-works/chord',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-durable',
  '@earendil-works/pi-tui',
];
// Only the tui boundary imports pi-tui, so the tui manifest declares it.
const TUI_PI_DEPS = ['@earendil-works/pi-tui'];
// Pi packages Kubic does not import: Pi 1.0's pi-agent-core has no harness,
// and nothing imports pi-protocol or pi-telemetry directly.
const UNUSED_PI_DEPS = [
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-protocol',
  '@earendil-works/pi-telemetry',
];
// Absent from the lockfile: nothing depends on them, even transitively.
const ABSENT_FROM_LOCK = [
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-protocol',
];
// Transitive Pi deps the root pins directly: a direct exact dependency is the
// pin that holds in an npm install (overrides do not).
const ROOT_PINNED_PI_DEPS = ['@earendil-works/pi-telemetry'];

// Pi ships its packages as one release, so every Pi package a manifest
// declares and every copy the lockfile resolves sits at one exact version:
// the one the root manifest pins pi-durable to. The version lives in the
// manifests alone, so a Pi bump is a manifest and lockfile change, never an
// edit here. Returns one line per mismatch, naming both versions.
function piVersionMismatches({ root, agent, tui, lock }) {
  const version = root.dependencies?.['@earendil-works/pi-durable'];
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    return [
      `package.json: @earendil-works/pi-durable is ${version ?? 'missing'}, not an exact version`,
    ];
  }
  const found = [];
  const check = (where, dep, actual) => {
    if (actual !== version) {
      found.push(
        `${where}: ${dep} is ${actual ?? 'missing'}, the root pins Pi at ${version}`,
      );
    }
  };
  const rootPinned = [...PI_DEPS, ...ROOT_PINNED_PI_DEPS];
  for (const dep of rootPinned) {
    check('package.json', dep, root.dependencies?.[dep]);
  }
  for (const dep of PI_DEPS.filter((d) => !TUI_PI_DEPS.includes(d))) {
    check('packages/agent/package.json', dep, agent.dependencies?.[dep]);
  }
  for (const dep of TUI_PI_DEPS) {
    check('packages/tui/package.json', dep, tui.dependencies?.[dep]);
  }
  // npm may hoist or nest each copy, so every resolved copy counts.
  const pkgs = Object.entries(lock?.packages ?? {});
  for (const dep of rootPinned) {
    const suffix = `node_modules/${dep}`;
    const copies = pkgs.filter(
      ([path]) => path === suffix || path.endsWith(`/${suffix}`),
    );
    if (copies.length === 0) check('package-lock.json', dep, undefined);
    for (const [path, entry] of copies) check(path, dep, entry.version);
  }
  return found;
}

function readJson(...parts) {
  return JSON.parse(readFileSync(join(ROOT, ...parts), 'utf8'));
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

// Exactly ONE hoisted copy of every Pi package.
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
  it('every Pi package and lockfile copy sits at the version the root pins', () => {
    assert.deepEqual(
      piVersionMismatches({
        root: readJson('package.json'),
        agent: readJson('packages', 'agent', 'package.json'),
        tui: readJson('packages', 'tui', 'package.json'),
        lock: readJson('package-lock.json'),
      }),
      [],
    );
  });

  it('agent declares no unused Pi package and the root no overrides', () => {
    const agent = readJson('packages', 'agent', 'package.json');
    assert.equal(
      agent.dependencies?.['@earendil-works/pi-tui'],
      undefined,
      'pi-tui must not be declared by the agent manifest',
    );
    for (const dep of UNUSED_PI_DEPS) {
      assert.equal(
        agent.dependencies?.[dep],
        undefined,
        `${dep} must not be declared by the agent manifest`,
      );
    }
    assert.equal(
      readJson('package.json').overrides,
      undefined,
      'the root must have no overrides',
    );
  });

  it('both Pi boundary files justify every export', () => {
    for (const rel of [
      join('packages', 'agent', 'src', 'pi-boundary.ts'),
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

  // One hoisted copy of every `@earendil-works/*` package is the invariant a
  // lockfile refresh must not break. A nested second copy (under a workspace
  // or under pi-durable) at the same version passes the pin check below, and
  // vitest resolves from source, but the built binary cannot load it from
  // dist/; two copies of pi-ai would also give Kubic and pi-durable separate
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
        // A workspace-level nest counts too (packages/agent held one).
        'packages/agent/node_modules/@earendil-works/chord': {
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
          'packages/agent/node_modules/@earendil-works/chord',
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

  it('the version gate takes the version from the root and names a mismatch', () => {
    const at = (version) => ({
      root: {
        dependencies: {
          '@earendil-works/chord': version,
          '@earendil-works/pi-ai': version,
          '@earendil-works/pi-durable': version,
          '@earendil-works/pi-telemetry': version,
          '@earendil-works/pi-tui': version,
        },
      },
      agent: {
        dependencies: {
          '@earendil-works/chord': version,
          '@earendil-works/pi-ai': version,
          '@earendil-works/pi-durable': version,
        },
      },
      tui: { dependencies: { '@earendil-works/pi-tui': version } },
      lock: {
        packages: {
          'node_modules/@earendil-works/chord': { version },
          'node_modules/@earendil-works/pi-ai': { version },
          'node_modules/@earendil-works/pi-durable': { version },
          'node_modules/@earendil-works/pi-telemetry': { version },
          'node_modules/@earendil-works/pi-tui': { version },
        },
      },
    });
    // Any one exact version passes, so a Pi bump needs no edit here.
    assert.deepEqual(piVersionMismatches(at('9.9.9')), []);
    const tuiBehind = at('9.9.9');
    tuiBehind.tui.dependencies['@earendil-works/pi-tui'] = '9.9.8';
    assert.deepEqual(piVersionMismatches(tuiBehind), [
      'packages/tui/package.json: @earendil-works/pi-tui is 9.9.8, the root pins Pi at 9.9.9',
    ]);
    const lockMissing = at('9.9.9');
    delete lockMissing.lock.packages['node_modules/@earendil-works/pi-ai'];
    assert.deepEqual(piVersionMismatches(lockMissing), [
      'package-lock.json: @earendil-works/pi-ai is missing, the root pins Pi at 9.9.9',
    ]);
    const range = at('^9.9.9');
    assert.deepEqual(piVersionMismatches(range), [
      'package.json: @earendil-works/pi-durable is ^9.9.9, not an exact version',
    ]);
  });

  it('the lockfile holds no unused Pi package', () => {
    const pkgs = readJson('package-lock.json').packages ?? {};
    for (const dep of ABSENT_FROM_LOCK) {
      const suffix = `/node_modules/${dep}`;
      const copies = Object.keys(pkgs).filter(
        (path) => path === `node_modules/${dep}` || path.endsWith(suffix),
      );
      assert.deepEqual(copies, [], `${dep} must not be in the lockfile`);
    }
  });
});
