// Reachability gate tests. The gate's job is to fail when a dead file lands
// without a listing, when a listing goes stale, and when a listed file
// becomes reachable — never to re-report what the list already carries.
// Fixtures build throwaway trees so the real repo is never mutated.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  allSources,
  checkSurface,
  computeReachable,
  deadFiles,
} from './reachability.mjs';

const ROOT = join(import.meta.dirname, '..');

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'reach-gate-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

function withTree(files, fn) {
  const root = tree(files);
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a file reachable through value imports from the entry is not dead', () => {
  withTree(
    {
      'apps/app/src/main.ts': "import { a } from './a.js';\na();\n",
      'apps/app/src/a.ts': 'export const a = 1;\n',
      'apps/app/src/b.ts': "import { a } from './a.js';\nexport const b = a;\n",
    },
    (root) => {
      assert.deepEqual(deadFiles(root), ['apps/app/src/b.ts']);
    },
  );
});

test('a type-only import does not make a file reachable', () => {
  withTree(
    {
      'apps/app/src/main.ts':
        "import type { T } from './types.js';\nexport const x: T = 1;\n",
      'apps/app/src/types.ts': 'export type T = number;\n',
    },
    (root) => {
      assert.deepEqual(deadFiles(root), ['apps/app/src/types.ts']);
    },
  );
});

test('a dynamic import() makes a file reachable', () => {
  withTree(
    {
      'apps/app/src/main.ts':
        "export async function load() {\n  await import('./lazy.js');\n}\n",
      'apps/app/src/lazy.ts': 'export const lazy = 1;\n',
    },
    (root) => {
      assert.deepEqual(deadFiles(root), []);
    },
  );
});

test('.js specifiers resolve to .ts sources (NodeNext layout)', () => {
  withTree(
    {
      'apps/app/src/main.ts':
        "import { a } from './deep/a.js';\nexport const x = a;\n",
      'apps/app/src/deep/a.ts': 'export const a = 1;\n',
    },
    (root) => {
      const { reachable } = computeReachable(root, 'apps/app/src/main.ts');
      assert.equal(reachable.size, 2);
    },
  );
});

test('test files are never counted as production sources', () => {
  withTree(
    {
      'apps/app/src/main.ts': 'export const x = 1;\n',
      'apps/app/src/thing.test.ts': 'export const t = 1;\n',
      'apps/app/src/thing.ts': 'export const thing = 1;\n',
    },
    (root) => {
      const sources = allSources(root).map((f) => f.slice(root.length + 1));
      assert.deepEqual(sources.sort(), [
        'apps/app/src/main.ts',
        'apps/app/src/thing.ts',
      ]);
      assert.deepEqual(deadFiles(root), ['apps/app/src/thing.ts']);
    },
  );
});

test('checkSurface reports uncovered, stale and wired entries separately', () => {
  // The three ways the list and the tree disagree must each go red on
  // their own — a gate that only ever returns [] would pass the real-tree
  // test below vacuously.
  withTree(
    {
      'apps/app/src/main.ts': "import { w } from './wired.js';\nw;\n",
      'apps/app/src/wired.ts': 'export const w = 1;\n',
      'apps/app/src/dead.ts': 'export const d = 1;\n',
      'apps/app/src/ledgered.ts': 'export const l = 1;\n',
    },
    (root) => {
      const result = checkSurface(root, {
        'apps/app/src/ledgered.ts': 'kept as a seam',
        'apps/app/src/wired.ts': 'wired since',
        'apps/app/src/gone.ts': 'deleted since',
      });
      assert.deepEqual(result.dead, [
        'apps/app/src/dead.ts',
        'apps/app/src/ledgered.ts',
      ]);
      assert.deepEqual(result.uncovered, ['apps/app/src/dead.ts']);
      assert.deepEqual(result.stale, ['apps/app/src/gone.ts']);
      assert.deepEqual(result.wired, ['apps/app/src/wired.ts']);
    },
  );
});

test('the CLI gate runs from a path containing a space', () => {
  // The main-module guard must not depend on the raw (percent-encoded)
  // .pathname: under a spaced root that comparison fails and the script
  // exits 0 without checking anything — a gate that silently passes.
  const base = mkdtempSync(join(tmpdir(), 'reach-spaced-'));
  const spaced = join(base, 'a dir with spaces');
  try {
    mkdirSync(spaced);
    cpSync(join(ROOT, 'scripts'), join(spaced, 'scripts'), { recursive: true });
    mkdirSync(join(spaced, 'packages', 'a', 'src'), { recursive: true });
    mkdirSync(join(spaced, 'apps', 'app', 'src'), { recursive: true });
    writeFileSync(
      join(spaced, 'apps', 'app', 'src', 'main.ts'),
      'export const x = 1;\n',
    );
    // One dead file that is not listed: the gate MUST fail loudly here.
    writeFileSync(
      join(spaced, 'packages', 'a', 'src', 'dead.ts'),
      'export const dead = 1;\n',
    );
    const result = spawnSync(
      process.execPath,
      [join(spaced, 'scripts', 'reachability.mjs')],
      { cwd: spaced, encoding: 'utf8' },
    );
    assert.equal(
      result.status,
      1,
      `expected exit 1 from a spaced path, got ${result.status} (silent pass = the bug)`,
    );
    assert.match(result.stderr, /runtime-dead and not listed/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the real tree matches the dead-surface list', () => {
  // Every dead file is listed, no entry names a missing file and no entry
  // has gone reachable. A change that wires or deletes a listed file
  // without updating the list fails here with the offending path.
  const result = checkSurface(ROOT);
  assert.deepEqual(result.uncovered, [], 'dead files must all be listed');
  assert.deepEqual(result.stale, [], 'no entry may name a missing file');
  assert.deepEqual(result.wired, [], 'no entry may still be reachable');
});
