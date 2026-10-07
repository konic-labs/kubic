// License-guard for the open-source backlog (issue #59; §75.1).
// Static repo state, no build needed: LICENSE text, NOTICE attribution,
// and the license field in every publishable manifest.
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = join(import.meta.dirname, '..');

function manifests(root = ROOT) {
  const found = [join(root, 'package.json')];
  for (const dir of ['packages', 'apps']) {
    for (const entry of readdirSync(join(root, dir), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(root, dir, entry.name, 'package.json');
      if (existsSync(manifest)) found.push(manifest);
    }
  }
  return found.sort();
}

// Manifests (relative to root) whose license field is not exactly "MIT".
function nonMitManifests(root = ROOT) {
  return manifests(root)
    .filter(
      (manifest) =>
        JSON.parse(readFileSync(manifest, 'utf8')).license !== 'MIT',
    )
    .map((manifest) => manifest.slice(root.length + 1));
}

describe('LICENSE (issue #59)', () => {
  it('exists and carries the MIT text with the Konic Labs copyright', () => {
    const text = readFileSync(join(ROOT, 'LICENSE'), 'utf8');
    assert.match(text, /MIT License/);
    assert.match(text, /Permission is hereby granted, free of charge/);
    assert.match(text, /Konic Labs/);
  });

  it('every package.json declares the MIT license field', () => {
    assert.deepEqual(
      nonMitManifests(),
      [],
      'every manifest must declare "license": "MIT"',
    );
    // Root + 8 packages + apps/kubic: fail loudly if discovery collapses
    // instead of certifying an empty scan.
    const checked = manifests().length;
    assert.ok(checked >= 10, `expected at least 10 manifests, saw ${checked}`);
  });

  it('the manifest check flags a missing or non-MIT license field', () => {
    const dir = mkdtempSync(join(tmpdir(), 'license-'));
    try {
      const write = (rel, json) => {
        mkdirSync(join(dir, rel, '..'), { recursive: true });
        writeFileSync(join(dir, rel), JSON.stringify(json));
      };
      write('package.json', { name: 'root', license: 'MIT' });
      write('packages/a/package.json', { name: 'a', license: 'ISC' });
      write('packages/b/package.json', { name: 'b' });
      write('packages/c/package.json', { name: 'c', license: 'MIT' });
      write('apps/d/package.json', { name: 'd', license: 'mit' });
      assert.deepEqual(nonMitManifests(dir), [
        join('apps', 'd', 'package.json'),
        join('packages', 'a', 'package.json'),
        join('packages', 'b', 'package.json'),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('NOTICE.md attributes the Pi / @earendil-works third-party code', () => {
    const text = readFileSync(join(ROOT, 'NOTICE.md'), 'utf8');
    assert.match(text, /@earendil-works/);
    assert.match(text, /MIT/);
  });

  it('NOTICE.md lists every direct third-party CLI dependency', () => {
    const text = readFileSync(join(ROOT, 'NOTICE.md'), 'utf8');
    const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const direct = Object.keys(root.dependencies ?? {});
    // Floor, not an exact count: the CLI stack is commander (+ extra-typings),
    // consola and @clack/prompts since colour moved to Kubic's own style
    // engine (issue #444) and tables to the output kit (issue #445).
    assert.ok(direct.length >= 4, `expected the CLI stack, saw ${direct}`);
    for (const dep of direct) {
      assert.ok(text.includes(`\`${dep}\``), `NOTICE.md must list ${dep}`);
    }
  });

  it('every runtime package in the lockfile carries a permissive license', () => {
    const lock = JSON.parse(
      readFileSync(join(ROOT, 'package-lock.json'), 'utf8'),
    );
    const offenders = runtimeLicenseOffenders(lock);
    assert.deepEqual(offenders, [], 'non-permissive runtime dependency');
    const runtime = Object.entries(lock.packages).filter(
      ([path, entry]) => path.includes('node_modules/') && entry.dev !== true,
    );
    assert.ok(
      runtime.length >= 10,
      `expected a runtime tree, saw ${runtime.length}`,
    );
  });

  it('the runtime license check flags copyleft, missing, and ignores dev', () => {
    assert.deepEqual(
      runtimeLicenseOffenders({
        packages: {
          '': { license: 'MIT' },
          'node_modules/ok': { license: 'Apache-2.0' },
          'node_modules/gpl': { license: 'GPL-3.0' },
          'node_modules/none': {},
          'node_modules/devonly': { license: 'AGPL-3.0', dev: true },
          'packages/core': { license: 'MIT' },
        },
      }),
      ['node_modules/gpl: GPL-3.0', 'node_modules/none: undefined'],
    );
  });
});

// Licences a shipped (non-dev) dependency may carry: permissive only.
const PERMISSIVE = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Unlicense',
]);

function runtimeLicenseOffenders(lock) {
  const offenders = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path.includes('node_modules/') || entry.dev === true) continue;
    if (entry.link === true) continue;
    if (!PERMISSIVE.has(entry.license)) {
      offenders.push(`${path}: ${entry.license}`);
    }
  }
  return offenders.sort();
}
