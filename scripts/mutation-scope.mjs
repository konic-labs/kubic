// Mutation scope helper: map a diff to the Stryker
// `--mutate` entries for the per-push gate. The vitest side mutates only the
// changed LINES of touched source files (`path:start-end` ranges) — a whole
// core file can hold ~1k mutants covered by ~500 tests — so a push costs
// minutes. Test-only changes mutate nothing per push: test-strength
// regressions are the nightly full run's ratchet. The full scope lives in
// stryker.conf.json / stryker.tap.conf.json.
//
// CLI: `node scripts/mutation-scope.mjs --ref <git-ref> [--tap|--vitest]`
// prints comma-separated `--mutate` entries for the chosen runner (default
// vitest), or nothing when nothing mutable changed (the caller skips the
// step). A failed diff exits 1: the gate must never go silently empty.

// Upper bound on per-push vitest files. Over the cap, the first files
// (sorted) are kept and the rest are left to the nightly run, with a warning.
export const MAX_VITEST_FILES = 25;

// Upper bound on the CHANGED LINES the per-push vitest run may mutate. A
// mutant costs ~1 s on a hosted runner and changed code yields ~0.7 mutants
// per line, so the 30-minute job holds ~1500 mutants — about 2000 lines. The
// file cap alone let a wave-sized push through to the job timeout, which ends
// 'cancelled' (neither scored nor red); this keeps every push scoreable.
// Files are taken first-fit in sorted order; a lone first file over the
// budget is trimmed to it rather than run unbounded.
export const MAX_VITEST_LINES = 2000;

// Tap-side systems under test; keep in sync with stryker.tap.conf.json.
const SCRIPT_SUTS = ['scripts/dep-lint.mjs', 'scripts/check-pinned-deps.mjs'];

const SOURCE = /^(packages|apps)\/[^/]+\/src\/.+\.ts$/;

function isSource(file) {
  return (
    SOURCE.test(file) && !file.endsWith('.test.ts') && !file.endsWith('.d.ts')
  );
}

// Added/changed line ranges per file from `git diff -U0 --no-prefix`.
export function changedRanges(diff) {
  const ranges = new Map();
  let file = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line === '+++ /dev/null' ? null : line.slice(4);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk === null || file === null) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count === 0) continue; // pure deletion: nothing left to mutate
    if (!ranges.has(file)) ranges.set(file, []);
    ranges.get(file).push([start, start + count - 1]);
  }
  return ranges;
}

const rangeLines = ([start, end]) => end - start + 1;

export function vitestScope(ranges) {
  const files = [...ranges.keys()].filter(isSource).sort();
  const mutate = [];
  let kept = 0;
  let lines = 0;
  for (const file of files) {
    const fileRanges = ranges.get(file);
    const fileLines = fileRanges.reduce((sum, r) => sum + rangeLines(r), 0);
    const room = MAX_VITEST_LINES - lines;
    if (kept >= MAX_VITEST_FILES || room <= 0) continue;
    if (fileLines <= room) {
      mutate.push(...fileRanges.map(([a, b]) => `${file}:${a}-${b}`));
      lines += fileLines;
    } else if (kept === 0) {
      // A lone oversized file: mutate its first `room` changed lines.
      let left = room;
      for (const [a, b] of fileRanges) {
        if (left <= 0) break;
        const take = Math.min(left, rangeLines([a, b]));
        mutate.push(`${file}:${a}-${a + take - 1}`);
        left -= take;
      }
      lines = MAX_VITEST_LINES;
    } else {
      continue;
    }
    kept += 1;
  }
  return { mutate, dropped: files.length - kept };
}

// Script test files exercise a sibling SUT (`dep-lint.test.mjs` imports
// `checkTree` from `dep-lint.mjs`); config-wide tests (erasable,
// pi-boundary) read the whole tree, so they conservatively map to every SUT.
export function tapScope(files) {
  const tap = new Set();
  for (const f of files) {
    if (!f.startsWith('scripts/')) continue;
    const base = f.replace(/\.test\.mjs$/, '.mjs');
    if (SCRIPT_SUTS.includes(base)) tap.add(base);
    else if (base !== f) for (const s of SCRIPT_SUTS) tap.add(s);
  }
  return [...tap];
}

function git(args) {
  const { execFileSync } = process.getBuiltinModule('node:child_process');
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

function main(argv) {
  const ref = argv.includes('--ref') ? argv[argv.indexOf('--ref') + 1] : null;
  if (!ref) {
    console.error('mutation-scope: --ref <git-ref> is required');
    process.exit(1);
  }
  const range = `${ref}...HEAD`;
  try {
    if (argv.includes('--tap')) {
      const files = git(['diff', '--name-only', range]).split('\n');
      console.log(tapScope(files.filter(Boolean)).join(','));
      return;
    }
    const diff = git(['diff', '-U0', '--no-prefix', '--no-color', range]);
    const scope = vitestScope(changedRanges(diff));
    if (scope.dropped > 0) {
      console.error(
        `mutation-scope: ${scope.dropped} changed file(s) over the ${MAX_VITEST_FILES}-file / ${MAX_VITEST_LINES}-changed-line cap are left to the nightly full run`,
      );
    }
    console.log(scope.mutate.join(','));
  } catch (err) {
    console.error(`mutation-scope: git diff ${range} failed: ${err.message}`);
    process.exit(1);
  }
}

if (import.meta.main) main(process.argv.slice(2));
