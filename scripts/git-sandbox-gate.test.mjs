// Real-git test hermeticity gate (issues #365, #420).
//
// Every real-git test must drive git through the shared helper
// (`packages/exec/src/test-support/git-sandbox.ts`), never through a bare
// `git` spawn on the inherited environment — a bare spawn reads the
// developer's `~/.gitconfig` and honors an ambient `GIT_DIR`, so the suite
// gives different results on different machines and can touch the Kubic
// repo itself when run under a git hook.
//
// The rule this gate enforces:
//
//   any *.test.ts under packages/worker/src, packages/exec/src,
//   packages/host/src or apps/kubic/src that spawns `git` directly
//   (execFileSync/spawnSync/execSync/execFile/spawn with a 'git' command,
//   quoted or backtick) is an offender — importing the sandbox helper does
//   NOT exempt a file (issue #420: flag the bare spawn per line even in
//   files that import the helper, so a half-migrated file stays red).
//   Tests that need git call `sandbox.git(...)` / `sandbox.gitResult(...)`
//   (scrubbed env) or activate the sandbox into process.env for
//   production code that spawns git on the inherited environment.
// Runs from `npm test` (node --test) so it gates CI alongside the other
// script gates.
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
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCOPED_DIRS = [
  join('packages', 'worker', 'src'),
  join('packages', 'exec', 'src'),
  join('packages', 'host', 'src'),
  join('apps', 'kubic', 'src'),
];

// A direct `git` spawn: `execFileSync('git', …)`, `spawnSync("git", …)`,
// the async `execFile('git', …, cb)` and `spawn` variants, plus backtick
// commands (execSync(`git status`), including `git${…}` interpolation),
// called as bare functions (the `child_process` shape). A bare `'git'`
// string elsewhere (a matcher vocabulary, a FakeExecutionEnv script) is not
// a spawn and must not match — and neither is a `.shell.spawn('git', …)`
// method call: that goes through the ExecutionEnv seam, not
// `child_process` directly (issue #212: the fake's own unit tests drive
// the seam with git argv and stay hermetic). The lookbehind keeps longer
// identifiers (`myspawnSync(`) out as well.
const DIRECT_GIT_SPAWN_RE =
  /(?<![.\w])(?:execFileSync|spawnSync|execSync|execFile|spawn)\s*\(\s*(?:['"]git['"]|`git(?=[\s`$]))/;

function testFiles(root = ROOT) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.test.ts')) found.push(full);
    }
  };
  for (const scoped of SCOPED_DIRS) {
    const base = join(root, scoped);
    if (existsSync(base)) walk(base);
  }
  return found.sort();
}

// `file:line: text` for every test file with a direct git spawn. Importing
// the sandbox helper does not exempt a file: each bare spawn is flagged
// per line (issue #420) so half-migrated files stay red.
function gitOffenders(root = ROOT, files = testFiles(root)) {
  const offenders = [];
  for (const file of files) {
    if (!file.endsWith('.test.ts')) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      if (DIRECT_GIT_SPAWN_RE.test(line)) {
        offenders.push(`${relative(root, file)}:${index + 1}: ${line.trim()}`);
      }
    }
  }
  return offenders;
}

// One walk of the real tree, shared by the gate and its coverage floor.
const SCOPED_TESTS = testFiles();

describe('real-git tests use the shared helper (issues #365, #420)', () => {
  it('no worker, exec, host or apps test spawns git directly', () => {
    // Source-text scan: the Stryker sandbox copy rewrites sources, so the
    // check is meaningless there (mutation work is deferred, #407).
    if (process.env.STRYKER_MUTATOR_WORKER !== undefined) return;
    const offenders = gitOffenders(ROOT, SCOPED_TESTS);
    assert.deepEqual(
      offenders,
      [],
      `real git in tests must go through packages/exec/src/test-support/git-sandbox.ts:\n${offenders.join('\n')}`,
    );
  });

  it('the scan covers the worker+exec+host+apps test tree', () => {
    // The four trees ship 250+ test files; a collapsed walk must fail
    // loudly instead of certifying an empty scan.
    assert.ok(
      SCOPED_TESTS.length >= 250,
      `expected the sandbox-gate scan to cover the tree, saw ${SCOPED_TESTS.length} files`,
    );
  });

  it('flags direct spawns per line, ignores non-spawns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-gate-'));
    try {
      const write = (rel, body) => {
        mkdirSync(join(dir, rel, '..'), { recursive: true });
        writeFileSync(join(dir, rel), body);
      };
      write(
        'packages/exec/src/raw.test.ts',
        "import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['init']);\n",
      );
      write(
        'packages/worker/src/ops/raw.test.ts',
        'const r = spawnSync("git", [\'status\']);\n',
      );
      write(
        'packages/exec/src/ok.test.ts',
        "import { createGitSandbox } from './test-support/git-sandbox.js';\nsandbox.git(['x']);\n",
      );
      // A file that imports the helper but still spawns directly: every
      // bare spawn is flagged anyway (issue #420).
      write(
        'packages/host/src/half.test.ts',
        "import { createGitSandbox } from '../../exec/src/test-support/git-sandbox.js';\nexecFileSync('git', ['init']);\n",
      );
      // The async execFile shape and backtick commands are direct spawns.
      write(
        'apps/kubic/src/async.test.ts',
        "import { execFile } from 'node:child_process';\nexecFile('git', ['status'], () => {});\n",
      );
      write(
        'packages/host/src/tick.test.ts',
        "import { execSync } from 'node:child_process';\nexecSync(`git status`);\n",
      );
      // A matcher vocabulary mentioning git, a fake-env script, and a
      // shell-seam call: not direct spawns, must stay clean.
      write(
        'packages/worker/src/lane/words.test.ts',
        "const words = [\n'git',\n'push',\n];\n/\\bgit\\b/.test('x');\n",
      );
      write(
        'packages/exec/src/fake-seam.test.ts',
        "env.shell.spawn('git', ['status']);\nmySpawnSync('git', []);\n",
      );
      write(
        'packages/host/src/outside.test.ts',
        "execFileSync('git', ['init']);\n",
      );
      write('packages/exec/src/helper.ts', "execFileSync('git', ['x']);\n");
      assert.deepEqual(gitOffenders(dir), [
        `${join('apps', 'kubic', 'src', 'async.test.ts')}:2: execFile('git', ['status'], () => {});`,
        `${join('packages', 'exec', 'src', 'raw.test.ts')}:2: execFileSync('git', ['init']);`,
        `${join('packages', 'host', 'src', 'half.test.ts')}:2: execFileSync('git', ['init']);`,
        `${join('packages', 'host', 'src', 'outside.test.ts')}:1: execFileSync('git', ['init']);`,
        `${join('packages', 'host', 'src', 'tick.test.ts')}:2: execSync(\`git status\`);`,
        `${join('packages', 'worker', 'src', 'ops', 'raw.test.ts')}:1: const r = spawnSync("git", ['status']);`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
