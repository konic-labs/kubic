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
    // Root + 9 packages + apps/kubic: fail loudly if discovery collapses
    // instead of certifying an empty scan.
    const checked = manifests().length;
    assert.ok(checked >= 11, `expected at least 11 manifests, saw ${checked}`);
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
});
