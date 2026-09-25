// Reachability gate tests (issue #102). The gate's job is to fail when a
// dead file lands without a ledger row, when a row goes stale, and when a
// row's file becomes reachable — never to re-report what the ledger already
// carries. Fixtures build throwaway trees so the real repo is never mutated.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  allSources,
  computeReachable,
  deadFiles,
  parseLedger,
} from './reachability.mjs';

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
