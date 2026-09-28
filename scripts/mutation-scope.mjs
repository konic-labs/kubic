// Mutation scope helper (issues #66, #72): map a diff to the Stryker
// `--mutate` files for the per-push gate. Only the touched source files are
// mutated — never their whole package — so a push costs minutes, not hours.
// The full scope lives in stryker.conf.json / stryker.tap.conf.json and runs
// nightly.
//
// CLI: `node scripts/mutation-scope.mjs --ref <git-ref> [--tap|--vitest]`
// prints comma-separated `--mutate` files for the chosen runner (default
// vitest), or nothing when no mutable file changed (the caller skips the
// step). A failed diff exits 1: the gate must never go silently empty or
// silently widen to the full scope.

// Upper bound on per-push vitest files. Over the cap, the first files (sorted)
// are kept and the rest are left to the nightly full run, with a warning.
export const MAX_VITEST_FILES = 25;

// Tap-side systems under test; keep in sync with stryker.tap.conf.json.
const SCRIPT_SUTS = ['scripts/dep-lint.mjs', 'scripts/check-pinned-deps.mjs'];

// Script test files exercise a sibling SUT (`dep-lint.test.mjs` imports
// `checkTree` from `dep-lint.mjs`); config-wide tests (erasable,
// pi-boundary) read the whole tree, so they conservatively map to every SUT.
function tapScopeForScript(file) {
  const base = file.replace(/\.test\.mjs$/, '.mjs');
  if (SCRIPT_SUTS.includes(base)) return [base];
  if (base === file) return [];
  return [...SCRIPT_SUTS];
}

function vitestScopeForFile(file, exists) {
  if (!/^(packages|apps)\/[^/]+\/src\/.+\.ts$/.test(file)) return [];
  if (file.endsWith('.d.ts')) return [];
  const source = file.replace(/\.test\.ts$/, '.ts');
  return exists(source) ? [source] : [];
}

function defaultExists(file) {
  return process.getBuiltinModule('node:fs').existsSync(file);
}

export function scopeForChangedFiles(files, exists = defaultExists) {
  const vitest = new Set();
  const tap = new Set();
  for (const f of files) {
    for (const s of vitestScopeForFile(f, exists)) vitest.add(s);
    if (f.startsWith('scripts/')) {
      for (const s of tapScopeForScript(f)) tap.add(s);
    }
  }
  const sorted = [...vitest].sort();
  return {
    vitest: sorted.slice(0, MAX_VITEST_FILES),
    tap: [...tap],
    dropped: Math.max(0, sorted.length - MAX_VITEST_FILES),
  };
}

function changedFilesSince(ref) {
  const { execFileSync } = process.getBuiltinModule('node:child_process');
  const out = execFileSync('git', ['diff', '--name-only', `${ref}...HEAD`], {
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function main(argv) {
  const ref = argv.includes('--ref') ? argv[argv.indexOf('--ref') + 1] : null;
  const runner = argv.includes('--tap') ? 'tap' : 'vitest';
  if (!ref) {
    console.error('mutation-scope: --ref <git-ref> is required');
    process.exit(1);
  }
  let files;
  try {
    files = changedFilesSince(ref);
  } catch (err) {
    console.error(
      `mutation-scope: git diff ${ref}...HEAD failed: ${err.message}`,
    );
    process.exit(1);
  }
  const scope = scopeForChangedFiles(files);
  if (runner === 'vitest' && scope.dropped > 0) {
    console.error(
      `mutation-scope: ${scope.dropped} changed file(s) over the ${MAX_VITEST_FILES}-file cap are left to the nightly full run`,
    );
  }
  console.log(scope[runner].join(','));
}

if (import.meta.main) main(process.argv.slice(2));
