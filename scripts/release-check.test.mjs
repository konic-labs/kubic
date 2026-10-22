// The release workflow's checks: a tag must name the manifest's version, and
// a published version must carry its shrinkwrap, its provenance and the
// dist-tag it was published under.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { registryProblems, tagProblems } from './release-check.mjs';

describe('tagProblems', () => {
  it('accepts the tag of the manifest version', () => {
    assert.deepEqual(tagProblems('v0.1.3', '0.1.3'), []);
  });

  it('refuses a tag for another version, or without the v', () => {
    assert.match(tagProblems('v0.1.4', '0.1.3')[0], /v0\.1\.4.*0\.1\.3/);
    assert.equal(tagProblems('0.1.3', '0.1.3').length, 1);
    assert.equal(tagProblems('', '0.1.3').length, 1);
  });
});

function published(overrides = {}) {
  return {
    name: 'kubic',
    version: '0.1.3',
    _hasShrinkwrap: true,
    'dist-tags': { latest: '0.1.2', next: '0.1.3' },
    dist: {
      attestations: {
        url: 'https://registry.npmjs.org/-/npm/v1/attestations/kubic@0.1.3',
        provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
      },
    },
    ...overrides,
  };
}

describe('registryProblems', () => {
  it('accepts a version with its shrinkwrap, provenance and dist-tag', () => {
    assert.deepEqual(registryProblems(published(), '0.1.3', 'next'), []);
  });

  it('names a missing shrinkwrap', () => {
    const problems = registryProblems(
      published({ _hasShrinkwrap: undefined }),
      '0.1.3',
      'next',
    );
    assert.deepEqual(problems, ['kubic@0.1.3 has no npm-shrinkwrap.json']);
  });

  it('names a missing provenance attestation', () => {
    const problems = registryProblems(published({ dist: {} }), '0.1.3', 'next');
    assert.deepEqual(problems, [
      'kubic@0.1.3 carries no provenance attestation',
    ]);
  });

  it('names a dist-tag that points elsewhere', () => {
    const problems = registryProblems(
      published({ 'dist-tags': { latest: '0.1.2', next: '0.1.2' } }),
      '0.1.3',
      'next',
    );
    assert.deepEqual(problems, ["dist-tag 'next' is 0.1.2, not 0.1.3"]);
  });

  it('names a version the registry does not serve yet', () => {
    assert.deepEqual(registryProblems(undefined, '0.1.3', 'next'), [
      'kubic@0.1.3 is not on the registry',
    ]);
    assert.deepEqual(
      registryProblems(published({ version: '0.0.0-stage' }), '0.1.3', 'next'),
      ['kubic@0.1.3 is not on the registry'],
    );
  });
});
