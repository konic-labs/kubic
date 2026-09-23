// License-guard for the open-source backlog (issue #59; §75.1).
// Static repo state, no build needed: LICENSE text, NOTICE attribution,
// and the license field in every publishable manifest.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = join(import.meta.dirname, '..');

function manifests() {
  const found = [join(ROOT, 'package.json')];
  for (const dir of ['packages', 'apps']) {
    for (const entry of readdirSync(join(ROOT, dir), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(ROOT, dir, entry.name, 'package.json');
      if (existsSync(manifest)) found.push(manifest);
    }
  }
  return found.sort();
}

describe('LICENSE (issue #59)', () => {
  it('exists and carries the MIT text with the Konic Labs copyright', () => {
    const text = readFileSync(join(ROOT, 'LICENSE'), 'utf8');
    assert.match(text, /MIT License/);
    assert.match(text, /Permission is hereby granted, free of charge/);
    assert.match(text, /Konic Labs/);
  });

  it('every package.json declares the MIT license field', () => {
    const checked = [];
    for (const manifest of manifests()) {
      const json = JSON.parse(readFileSync(manifest, 'utf8'));
      assert.equal(
        json.license,
        'MIT',
        `${manifest} must declare "license": "MIT"`,
      );
      checked.push(manifest);
    }
    // Root + 9 packages + apps/kubic: fail loudly if a manifest is added
    // without the field instead of silently skipping it.
    assert.ok(
      checked.length >= 11,
      `expected at least 11 manifests, saw ${checked.length}`,
    );
  });

  it('NOTICE.md attributes the Pi / @earendil-works third-party code', () => {
    const text = readFileSync(join(ROOT, 'NOTICE.md'), 'utf8');
    assert.match(text, /@earendil-works/);
    assert.match(text, /MIT/);
  });
});
