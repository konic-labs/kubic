import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { PATCHES, patchDir, patchSource } from './patch-vitest-runner.mjs';

// Verbatim shapes from @stryker-mutator/vitest-runner 10.0.0 dist.
const HELPERS = `export function collectTestName({ name, suite, }) {
    const nameParts = [name];
    let currentSuite = suite;
    while (currentSuite) {
        nameParts.unshift(currentSuite.name);
        currentSuite = currentSuite.suite;
    }
    return nameParts.join(' ').trim();
}`;
const RUNNER = `            const regexTestNameFilter = parsedTests
                .map(({ test: name }) => escapeRegExp(name))
                .join('|');
            const regex = new RegExp(regexTestNameFilter);`;

function load(source, fnName) {
  const body = source.replace(/^export /, '');
  return new Function(`${body}; return ${fnName};`)();
}

describe('patch-vitest-runner', () => {
  const [helpersPatch, , runnerPatch] = PATCHES;

  it('names a test by vitest 5 fullTestName, matching what testNamePattern sees', () => {
    const collectTestName = load(
      patchSource(HELPERS, helpersPatch),
      'collectTestName',
    );
    const suite = { name: 'outer', suite: { name: '' } };
    assert.equal(
      collectTestName({ name: 'leaf', suite, fullTestName: 'outer > leaf' }),
      'outer > leaf',
    );
  });

  it('keeps the space-joined fallback when fullTestName is absent', () => {
    const collectTestName = load(
      patchSource(HELPERS, helpersPatch),
      'collectTestName',
    );
    assert.equal(
      collectTestName({ name: 'leaf', suite: { name: 'outer' } }),
      'outer leaf',
    );
  });

  it('the unpatched runner name never matches a vitest 5 full name (the bug)', () => {
    const collectTestName = load(HELPERS, 'collectTestName');
    const name = collectTestName({ name: 'leaf', suite: { name: 'outer' } });
    assert.equal(new RegExp(name).test('outer > leaf'), false);
  });

  it('anchors the filter so a name does not select longer names it prefixes', () => {
    const patched = patchSource(RUNNER, runnerPatch);
    const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const build = new Function(
      'parsedTests',
      'escapeRegExp',
      `${patched}\nreturn regex;`,
    );
    const regex = build([{ test: 'a > b' }, { test: 'c (x)' }], escapeRegExp);
    assert.equal(regex.test('a > b'), true);
    assert.equal(regex.test('c (x)'), true);
    assert.equal(regex.test('a > b > c'), false);
    assert.equal(regex.test('z > a > b'), false);
  });

  it('is idempotent', () => {
    const once = patchSource(HELPERS, helpersPatch);
    assert.equal(patchSource(once, helpersPatch), once);
  });

  it('throws when the runner changed shape instead of silently skipping', () => {
    assert.throws(
      () => patchSource('function other() {}', helpersPatch),
      /changed shape/,
    );
  });

  it('patches a runner dist dir in place and reports only changed files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubic-runner-'));
    try {
      fs.writeFileSync(path.join(dir, 'test-helpers.js'), HELPERS);
      fs.writeFileSync(
        path.join(dir, 'stryker-setup.js'),
        HELPERS.replace('export ', ''),
      );
      fs.writeFileSync(path.join(dir, 'vitest-test-runner.js'), RUNNER);
      assert.deepEqual(patchDir(dir), [
        'test-helpers.js',
        'stryker-setup.js',
        'vitest-test-runner.js',
      ]);
      assert.deepEqual(patchDir(dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the installed runner is patched (postinstall ran)', () => {
    const dir = 'node_modules/@stryker-mutator/vitest-runner/dist/src';
    for (const { file } of PATCHES) {
      assert.match(
        fs.readFileSync(path.join(dir, file), 'utf8'),
        /kubic-patch: vitest5-fullTestName/,
        file,
      );
    }
  });
});
