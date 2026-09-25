// Reachability gate tests (issue #102). The gate's job is to fail when a
// dead file lands without a ledger row, when a row goes stale, and when a
// row's file becomes reachable — never to re-report what the ledger already
// carries. Fixtures build throwaway trees so the real repo is never mutated.
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
  parseLedger,
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

test('the ledger parses LOC, path and disposition rows', () => {
  withTree(
    {
      'docs/dead-surface.md':
        '| LOC | file | owner | disposition |\n| --- | --- | --- | --- |\n| 12 | `packages/a/src/x.ts` | #99 | wire: later |\n',
    },
    (root) => {
      const rows = parseLedger(root);
      assert.equal(rows.size, 1);
      assert.deepEqual(rows.get('packages/a/src/x.ts'), {
        loc: 12,
        disposition: '#99 wire: later',
      });
    },
  );
});

test('a 3-column ledger row parses too (disposition only)', () => {
  withTree(
    {
      'docs/dead-surface.md':
        '| LOC | file | disposition |\n| --- | --- | --- |\n| 7 | `packages/a/src/y.ts` | keep: seam |\n',
    },
    (root) => {
      const rows = parseLedger(root);
      assert.deepEqual(rows.get('packages/a/src/y.ts'), {
        loc: 7,
        disposition: 'keep: seam',
      });
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
    cpSync(join(ROOT, 'docs'), join(spaced, 'docs'), { recursive: true });
    mkdirSync(join(spaced, 'packages', 'a', 'src'), { recursive: true });
    mkdirSync(join(spaced, 'apps', 'app', 'src'), { recursive: true });
    writeFileSync(
      join(spaced, 'apps', 'app', 'src', 'main.ts'),
      'export const x = 1;\n',
    );
    // One dead file with no ledger row: the gate MUST fail loudly here.
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
    assert.match(result.stderr, /no ledger row/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the real tree’s gate state is the ledger’s state', () => {
  // Locks in the shipped invariant: every dead file is ledgered, no row is
  // stale and no row has gone reachable. If a sibling issue wires or deletes
  // a file without updating the ledger, this fails with the offending path.
  const result = checkSurface(ROOT);
  assert.deepEqual(result.uncovered, [], 'dead files must all be ledgered');
  assert.deepEqual(result.stale, [], 'no ledger row may name a missing file');
  assert.deepEqual(result.wired, [], 'no ledger row may still be reachable');
});
