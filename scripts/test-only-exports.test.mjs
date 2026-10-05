// Symbol-level reachability gate (issue #215): the check flags exports
// imported only by tests, backed by the dead-surface ledger.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkTestOnlyExports } from './test-only-exports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratchDirs = [];

after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

// A fixture tree shaped like the repo: packages/<pkg>/src for callers,
// docs/dead-surface.md for the ledger. The audited scope is fixed inside
// the script (lane/** + prompts.ts + compaction.ts), so fixtures exercise
// the ledger and stale-row rules through compaction.ts.
function fixture({ sources, ledger }) {
  const dir = mkdtempSync(join(tmpdir(), 'test-only-exports-'));
  scratchDirs.push(dir);
  // The audited scope is fixed (lane/** + prompts.ts + compaction.ts):
  // every fixture carries the untouched members so scopeFiles resolves.
  mkdirSync(join(dir, 'packages/worker/src/lane'), { recursive: true });
  writeFileSync(join(dir, 'packages/worker/src/prompts.ts'), 'export {};\n');
  for (const [rel, content] of Object.entries(sources)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs/dead-surface.md'), ledger);
  return dir;
}

const HEADER =
  '# Dead-surface ledger\n\n## Unwired exports of reachable modules\n\n';

describe('checkTestOnlyExports', () => {
  it('flags an export imported only by tests', () => {
    const dir = fixture({
      sources: {
        'packages/worker/src/compaction.ts':
          'export function helper(): number {\n  return 1;\n}\n',
        'packages/worker/src/compaction.test.ts':
          "import { helper } from './compaction.js';\nhelper();\n",
      },
      ledger: HEADER,
    });
    const { unledgered, stale } = checkTestOnlyExports({
      root: dir,
      ledgerText: HEADER,
    });
    assert.deepEqual(
      unledgered.map((entry) => entry.symbol),
      ['helper'],
    );
    assert.deepEqual(stale, []);
  });

  it('passes a ledgered export and counts intra-module use as a caller', () => {
    const ledger =
      HEADER +
      '| `kept` | `packages/worker/src/compaction.ts` | #215 | keep: fixture |\n';
    const dir = fixture({
      sources: {
        // kept is ledgered; internal is used inside its own module by
        // user, which a prod file calls — none is test-only surface.
        'packages/worker/src/compaction.ts':
          'export function kept(): number {\n  return 1;\n}\nexport function internal(): number {\n  return 2;\n}\nexport function user(): number {\n  return internal() + 1;\n}\n',
        'packages/worker/src/runner.ts':
          "import { user } from './compaction.js';\nuser();\n",
      },
      ledger,
    });
    const { unledgered, stale } = checkTestOnlyExports({
      root: dir,
      ledgerText: ledger,
    });
    assert.deepEqual(unledgered, []);
    assert.deepEqual(stale, []);
  });

  it('flags stale rows: wired symbols and deleted symbols must leave the ledger', () => {
    const ledger =
      HEADER +
      '| `helper` | `packages/worker/src/compaction.ts` | #215 | keep: fixture |\n' +
      '| `gone` | `packages/worker/src/compaction.ts` | #215 | keep: fixture |\n';
    const dir = fixture({
      sources: {
        'packages/worker/src/compaction.ts':
          'export function helper(): number {\n  return 1;\n}\n',
        'packages/host/src/run-cli.ts':
          "import { helper } from 'x';\nhelper();\n",
      },
      ledger,
    });
    const { unledgered, stale } = checkTestOnlyExports({
      root: dir,
      ledgerText: ledger,
    });
    assert.deepEqual(unledgered, []);
    assert.deepEqual(stale, [
      'packages/worker/src/compaction.ts::helper',
      'packages/worker/src/compaction.ts::gone',
    ]);
  });

  it('the real tree is clean: no unledgered test-only exports, no stale rows', () => {
    const { unledgered, stale } = checkTestOnlyExports({ root: ROOT });
    assert.deepEqual(unledgered, []);
    assert.deepEqual(stale, []);
  });
});
