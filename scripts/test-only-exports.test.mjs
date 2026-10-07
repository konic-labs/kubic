// Symbol-level reachability gate: the check flags exports imported only by
// tests, unless dead-surface.mjs lists them.
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

// A fixture tree shaped like the repo: packages/<pkg>/src for callers. The
// audited scope is fixed inside the script (lane/** + prompts.ts +
// compaction.ts), so fixtures exercise the listing and stale-entry rules
// through compaction.ts.
function fixture({ sources }) {
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
  return dir;
}

describe('checkTestOnlyExports', () => {
  it('flags an export imported only by tests', () => {
    const dir = fixture({
      sources: {
        'packages/worker/src/compaction.ts':
          'export function helper(): number {\n  return 1;\n}\n',
        'packages/worker/src/compaction.test.ts':
          "import { helper } from './compaction.js';\nhelper();\n",
      },
    });
    const { unlisted, stale } = checkTestOnlyExports({
      root: dir,
      unwired: {},
    });
    assert.deepEqual(
      unlisted.map((entry) => entry.symbol),
      ['helper'],
    );
    assert.deepEqual(stale, []);
  });

  it('passes a listed export and counts intra-module use as a caller', () => {
    const unwired = {
      'packages/worker/src/compaction.ts': { kept: 'fixture' },
    };
    const dir = fixture({
      sources: {
        // kept is listed; internal is used inside its own module by
        // user, which a prod file calls — none is test-only surface.
        'packages/worker/src/compaction.ts':
          'export function kept(): number {\n  return 1;\n}\nexport function internal(): number {\n  return 2;\n}\nexport function user(): number {\n  return internal() + 1;\n}\n',
        'packages/worker/src/runner.ts':
          "import { user } from './compaction.js';\nuser();\n",
      },
    });
    const { unlisted, stale } = checkTestOnlyExports({ root: dir, unwired });
    assert.deepEqual(unlisted, []);
    assert.deepEqual(stale, []);
  });

  it('flags stale entries: wired and deleted symbols must leave the list', () => {
    const unwired = {
      'packages/worker/src/compaction.ts': {
        helper: 'fixture',
        gone: 'fixture',
      },
    };
    const dir = fixture({
      sources: {
        'packages/worker/src/compaction.ts':
          'export function helper(): number {\n  return 1;\n}\n',
        'packages/host/src/run-cli.ts':
          "import { helper } from 'x';\nhelper();\n",
      },
    });
    const { unlisted, stale } = checkTestOnlyExports({ root: dir, unwired });
    assert.deepEqual(unlisted, []);
    assert.deepEqual(stale, [
      'packages/worker/src/compaction.ts::helper',
      'packages/worker/src/compaction.ts::gone',
    ]);
  });

  it('the real tree is clean: no unlisted test-only exports, no stale entries', () => {
    const { unlisted, stale } = checkTestOnlyExports({ root: ROOT });
    assert.deepEqual(unlisted, []);
    assert.deepEqual(stale, []);
  });
});
