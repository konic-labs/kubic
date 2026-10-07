// Single-parser gate (the `--help` convention's sibling;
// extended when the CLI moved onto commander). commander — through
// @commander-js/extra-typings, owned by the composition root
// (apps/kubic/src) — is the single argv parser:
//
//   A. the root routes through commander: apps/kubic/src/dispatch.ts builds
//      the program (createKubicProgram) and holds no `command === '…'`
//      if-chain; each command group registers itself from its own module
//      under apps/kubic/src/commands/;
//   B. no other argv parser is imported anywhere in the product tree
//      (yargs, minimist, meow, arg, node:util parseArgs, bare `commander`),
//      and extra-typings is imported only under apps/kubic/src;
//   C. the legacy hand-rolled layer is gone: packages/core/src/flags.ts
//      (`parseFlagArgs`) and packages/core/src/cli-help.ts (`answerHelp`)
//      were deleted once every command moved onto commander, and must not
//      come back.
//
// Every command used to hand-roll the same value guard —
//
//   const value = args[i + 1];
//   if (value === undefined || value.startsWith('--')) { … }
//
// which made legitimate values unpassable, knew no `--flag=value` form, and
// had no end-of-flags escape. The fix is one parser (commander); this gate
// keeps the copies from coming back:
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
// Rule C: the legacy parser and help modules, deleted by the migration.
const LEGACY = [
  join(ROOT, 'packages', 'core', 'src', 'flags.ts'),
  join(ROOT, 'packages', 'core', 'src', 'cli-help.ts'),
];
// Both quote spellings: biome formats in-repo sources to single quotes, but
// a copy-pasted or generated guard can carry either — matching only
// `startsWith('--')` would let the double-quoted twin slip past.
const HAND_ROLLED_GUARDS = ["startsWith('--')", 'startsWith("--")'];
// Argv parsers other than commander-via-extra-typings (rule B).
const FOREIGN_PARSER_RE =
  /from\s+['"](yargs(?:\/[^'"]*)?|minimist|meow|arg|commander)['"]|import\s*\{[^}]*\bparseArgs\b[^}]*\}\s*from\s*['"](?:node:)?util['"]/;
const EXTRA_TYPINGS_RE = /from\s+['"]@commander-js\/extra-typings['"]/;

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
function sourceFiles(root = ROOT) {
  const found = [];
  for (const top of ['packages', 'apps']) {
    const base = join(root, top);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const src = join(base, entry.name, 'src');
      if (existsSync(src)) walk(src, found);
    }
  }
  return found.sort();
}

// `file:line: text` for every hand-rolled guard under root's sources.
function guardOffenders(root = ROOT, files = sourceFiles(root)) {
  const offenders = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      const guard = HAND_ROLLED_GUARDS.find((candidate) =>
        line.includes(candidate),
      );
      if (guard === undefined) continue;
      offenders.push(`${relative(root, file)}:${index + 1}: ${line.trim()}`);
    }
  }
  return offenders;
}

// `file:line: import` for every foreign parser import, and every
// extra-typings import outside the composition root.
function parserOffenders(root = ROOT, files = sourceFiles(root)) {
  const app = join(root, 'apps', 'kubic', 'src');
  const offenders = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      const foreign = FOREIGN_PARSER_RE.test(line);
      const typedOutsideApp =
        EXTRA_TYPINGS_RE.test(line) && !file.startsWith(app);
      if (!foreign && !typedOutsideApp) continue;
      offenders.push(`${relative(root, file)}:${index + 1}: ${line.trim()}`);
    }
  }
  return offenders;
}

// One walk of the real tree, shared by the gate and its coverage floor.
const REPO_SOURCES = sourceFiles();

describe('commander is the single parser', () => {
  it('the root routes through commander, one registrar module per group', () => {
    const dispatch = readFileSync(
      join(ROOT, 'apps', 'kubic', 'src', 'dispatch.ts'),
      'utf8',
    );
    assert.match(dispatch, /createKubicProgram\(/);
    assert.doesNotMatch(
      dispatch,
      /command === ['"]/,
      'dispatch.ts must not route by string comparison — register a commander command instead',
    );
    const program = readFileSync(
      join(ROOT, 'apps', 'kubic', 'src', 'cli', 'program.ts'),
      'utf8',
    );
    assert.match(program, EXTRA_TYPINGS_RE);
    assert.match(program, /\.exitOverride\(/);
    for (const group of ['solo', 'journal', 'analysis']) {
      const file = join(
        ROOT,
        'apps',
        'kubic',
        'src',
        'commands',
        `${group}.ts`,
      );
      assert.ok(existsSync(file), `missing command module ${group}.ts`);
      assert.match(
        readFileSync(file, 'utf8'),
        /export const register\w+Commands/,
      );
    }
  });

  it('no other argv parser is imported, and extra-typings stays in the app root', () => {
    const offenders = parserOffenders(ROOT, REPO_SOURCES);
    assert.deepEqual(
      offenders,
      [],
      `argv parsing belongs to commander (@commander-js/extra-typings in apps/kubic/src):\n${offenders.join('\n')}`,
    );
  });

  it('flags foreign parsers and extra-typings outside the app, not inside it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parser-gate-'));
    try {
      const write = (rel, body) => {
        mkdirSync(join(dir, rel, '..'), { recursive: true });
        writeFileSync(join(dir, rel), body);
      };
      write('packages/host/src/a.ts', "import yargs from 'yargs';\n");
      write(
        'packages/host/src/b.ts',
        "import { parseArgs } from 'node:util';\n",
      );
      write('packages/eval/src/c.ts', "import { Command } from 'commander';\n");
      write(
        'packages/core/src/d.ts',
        "import { Command } from '@commander-js/extra-typings';\n",
      );
      write(
        'apps/kubic/src/cli/ok.ts',
        "import { Command } from '@commander-js/extra-typings';\n",
      );
      write('packages/host/src/e.ts', "import { format } from 'node:util';\n");
      assert.deepEqual(parserOffenders(dir), [
        `${join('packages', 'core', 'src', 'd.ts')}:1: import { Command } from '@commander-js/extra-typings';`,
        `${join('packages', 'eval', 'src', 'c.ts')}:1: import { Command } from 'commander';`,
        `${join('packages', 'host', 'src', 'a.ts')}:1: import yargs from 'yargs';`,
        `${join('packages', 'host', 'src', 'b.ts')}:1: import { parseArgs } from 'node:util';`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('legacy flag parser', () => {
  it('no hand-rolled startsWith("--") value guard survives', () => {
    const offenders = guardOffenders(ROOT, REPO_SOURCES);
    assert.deepEqual(
      offenders,
      [],
      `argv flags must parse through commander, not a hand-rolled guard:\n${offenders.join('\n')}`,
    );
  });

  it('the legacy parser and help modules are gone and the scan covers the tree', () => {
    // Rule C: every command is a commander definition; the hand-rolled
    // parser and help convention must not come back.
    for (const file of LEGACY) {
      assert.equal(existsSync(file), false, `${relative(ROOT, file)} is back`);
    }
    // The gate itself must keep watching both quote spellings.
    assert.deepEqual(HAND_ROLLED_GUARDS, [
      "startsWith('--')",
      'startsWith("--")',
    ]);
    const files = REPO_SOURCES;
    // The tree ships 200+ non-test sources; a collapsed walk must fail loudly
    // instead of certifying an empty scan.
    assert.ok(
      files.length >= 150,
      `expected the source scan to cover the tree, saw ${files.length} files`,
    );
  });

  it('flags both quote spellings, skipping tests', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flag-gate-'));
    try {
      const write = (rel, body) => {
        mkdirSync(join(dir, rel, '..'), { recursive: true });
        writeFileSync(join(dir, rel), body);
      };
      write(
        'packages/host/src/cli.ts',
        "const v = args[i + 1];\nif (v.startsWith('--')) throw 1;\n",
      );
      write('apps/kubic/src/main.ts', 'if (v.startsWith("--")) throw 1;\n');
      write('packages/core/src/flags.ts', "if (v.startsWith('--')) {}\n");
      write('packages/host/src/cli.test.ts', "v.startsWith('--');\n");
      assert.deepEqual(guardOffenders(dir), [
        `${join('apps', 'kubic', 'src', 'main.ts')}:1: if (v.startsWith("--")) throw 1;`,
        `${join('packages', 'core', 'src', 'flags.ts')}:1: if (v.startsWith('--')) {}`,
        `${join('packages', 'host', 'src', 'cli.ts')}:2: if (v.startsWith('--')) throw 1;`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
