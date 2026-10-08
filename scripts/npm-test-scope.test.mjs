// npm test scope guard.
//
// `docs/contributing.md` promises `npm test` runs every `scripts/*.test.mjs`
// via `node --test`. The root `package.json` must not list the files by hand,
// so a new gate test could land on disk but never run unless someone remembered
// to edit the script too. The script now globs the suite; this guard keeps
// the property structural: the glob form stays, no single gate file is
// named, and the glob provably matches every gate file on disk.
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The exact pattern the `test` script passes to `node --test`: one `*`
// never crosses `/`, and every gate file sits directly in `scripts/` — a
// nested `scripts/sub/x.test.mjs` would run in NEITHER `npm test` nor CI,
// so the disk scan below descends and the gate fails on it.
const GATE_GLOB = 'scripts/*.test.mjs';
const GATE_GLOB_RE = /^scripts\/[^/]+\.test\.mjs$/;

// Every gate file on disk, relative to `scripts/`, descending into
// subdirectories so a nested gate cannot silently skip the suite.
function gateTestsOnDisk(root = ROOT) {
  const found = [];
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), `${rel}${entry.name}/`);
      } else if (entry.name.endsWith('.test.mjs')) {
        found.push(`${rel}${entry.name}`);
      }
    }
  };
  walk(join(root, 'scripts'), '');
  return found.sort();
}

function testScript(root = ROOT) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts
    .test;
}

// Every way the script and the tree disagree, as `problem` strings.
function scopeProblems(script, files) {
  const problems = [];
  if (!script.includes(`"${GATE_GLOB}"`)) {
    problems.push(`test script must run node --test "${GATE_GLOB}"`);
  }
  for (const file of files) {
    if (script.includes(`scripts/${file}`)) {
      problems.push(`test script must not name scripts/${file}`);
    }
    if (!GATE_GLOB_RE.test(`scripts/${file}`)) {
      problems.push(`scripts/${file} is not matched by ${GATE_GLOB}`);
    }
  }
  return problems;
}

describe('npm test runs every gate', () => {
  it('the glob owns the set: every gate on disk runs under npm test', () => {
    const files = gateTestsOnDisk();
    // The suite ships 10+ gates; an empty or collapsed scripts/ dir must
    // fail loudly instead of certifying a vacuous glob.
    assert.ok(
      files.length >= 10,
      `expected the gate suite on disk, saw ${files.length} files`,
    );
    assert.deepEqual(
      scopeProblems(testScript(), files),
      [],
      'npm test must glob the gate suite, not hand-list it',
    );
  });

  it('flags a hand-listed script, a named file and a non-matching file', () => {
    assert.deepEqual(
      scopeProblems('node --test scripts/a.test.mjs scripts/b.test.mjs', [
        'a.test.mjs',
        'b.test.mjs',
      ]),
      [
        'test script must run node --test "scripts/*.test.mjs"',
        'test script must not name scripts/a.test.mjs',
        'test script must not name scripts/b.test.mjs',
      ],
    );
    assert.deepEqual(
      scopeProblems('node --test "scripts/*.test.mjs"', [
        'nested/dir.test.mjs',
      ]),
      ['scripts/nested/dir.test.mjs is not matched by scripts/*.test.mjs'],
    );
    assert.deepEqual(
      scopeProblems('node --test "scripts/*.test.mjs"', ['a.test.mjs']),
      [],
    );
  });

  it('the disk scan descends into subdirectories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'npm-test-scope-'));
    try {
      mkdirSync(join(dir, 'scripts', 'sub'), { recursive: true });
      writeFileSync(join(dir, 'scripts', 'top.test.mjs'), '');
      writeFileSync(join(dir, 'scripts', 'sub', 'nested.test.mjs'), '');
      writeFileSync(join(dir, 'scripts', 'sub', 'helper.mjs'), '');
      assert.deepEqual(gateTestsOnDisk(dir), [
        'sub/nested.test.mjs',
        'top.test.mjs',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
