// Shared-flag-parser gate (issue #127; §78, the `--help` convention's
// sibling). Every command used to hand-roll the same value guard —
//
//   const value = args[i + 1];
//   if (value === undefined || value.startsWith('--')) { … }
//
// which made legitimate values unpassable, knew no `--flag=value` form, and
// had no end-of-flags escape. The fix is one parser (packages/core/src/
// flags.ts, `parseFlagArgs`); this gate keeps the copies from coming back:
//
//   1. no non-test source file under packages/*/src or apps/*/src may
//      contain a hand-rolled `startsWith('--')` value guard — the parser is
//      the single implementation of the rule;
//   2. the scan must actually cover the tree (a floor on the file count so
//      a broken walk can never make this gate pass vacuously).
//
// Real repo state, no build needed, zero network. Runs from `npm test`
// (node --test) so it gates CI alongside the other script gates.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PARSER = join(ROOT, 'packages', 'core', 'src', 'flags.ts');
// Both quote spellings: biome formats in-repo sources to single quotes, but
// a copy-pasted or generated guard can carry either — matching only
// `startsWith('--')` would let the double-quoted twin slip past.
const HAND_ROLLED_GUARDS = ["startsWith('--')", 'startsWith("--")'];

function walk(dir, found) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, found);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts')) continue;
    found.push(path);
  }
}

// Non-test TypeScript sources of the product tree, excluding the parser
// itself (the one place the rule may live).
function sourceFiles() {
  const found = [];
  for (const top of ['packages', 'apps']) {
    const base = join(ROOT, top);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const src = join(base, entry.name, 'src');
      if (existsSync(src)) walk(src, found);
    }
  }
  return found.filter((file) => file !== PARSER).sort();
}

describe('shared flag parser (issue #127)', () => {
  it('no hand-rolled startsWith("--") value guard survives outside packages/core/src/flags.ts', () => {
    const offenders = [];
    for (const file of sourceFiles()) {
      const lines = readFileSync(file, 'utf8').split('\n');
      for (const [index, line] of lines.entries()) {
        const guard = HAND_ROLLED_GUARDS.find((candidate) =>
          line.includes(candidate),
        );
        if (guard === undefined) continue;
        offenders.push(`${relative(ROOT, file)}:${index + 1}: ${line.trim()}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `argv flags must parse through parseFlagArgs (packages/core/src/flags.ts), not a hand-rolled guard:\n${offenders.join('\n')}`,
    );
  });

  it('the shared parser is the single implementation and the scan covers the tree', () => {
    const parser = readFileSync(PARSER, 'utf8');
    assert.match(parser, /export function parseFlagArgs\(/);
    assert.match(parser, /startsWith\(['"]--['"]\)|TERMINATOR/);
    // The gate itself must keep watching both quote spellings.
    assert.deepEqual(HAND_ROLLED_GUARDS, [
      "startsWith('--')",
      'startsWith("--")',
    ]);
    const files = sourceFiles();
    // The tree ships 200+ non-test sources; a collapsed walk must fail loudly
    // instead of certifying an empty scan.
    assert.ok(
      files.length >= 150,
      `expected the source scan to cover the tree, saw ${files.length} files`,
    );
  });
});
