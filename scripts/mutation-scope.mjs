// Mutation scope helper (issue #66): map changed files to Stryker `--mutate`
// globs so CI mutates touched packages at minimum. Falls back to the proven
// proof scope (trajectory + script SUTs) when nothing relevant changed.
//
// CLI: `node scripts/mutation-scope.mjs [--ref <git-ref>] [--tap|--vitest]`
// prints comma-separated `--mutate` globs for the chosen runner (default
// vitest). Detection failures warn on stderr and print the fallback scope —
// the gate must never go silently empty.

// Proof scope for `npm run test:mutation` (issue #66). Per-area expansion is
// tracked in #67–#70; keep these literals in sync with stryker.conf.json and
// stryker.tap.conf.json.
export const DEFAULT_VITEST_MUTATE = [
  'packages/trajectory/src/**/*.ts',
  '!packages/trajectory/src/**/*.test.ts',
];
export const DEFAULT_TAP_MUTATE = [
  'scripts/dep-lint.mjs',
  'scripts/check-pinned-deps.mjs',
];

// Script test files exercise a sibling SUT (`dep-lint.test.mjs` imports
// `checkTree` from `dep-lint.mjs`); config-wide tests (erasable,
// pi-boundary) read the whole tree, so they conservatively map to every SUT.
const SCRIPT_SUTS = [...DEFAULT_TAP_MUTATE];

function tapScopeForScript(file) {
  const base = file.replace(/\.test\.mjs$/, '.mjs');
  if (SCRIPT_SUTS.includes(base)) return [base];
  if (base === file) return [];
  return [...SCRIPT_SUTS];
}

export function scopeForChangedFiles(files) {
  const vitest = [];
  const tap = [];
  for (const f of files) {
    const m = /^packages\/([^/]+)\//.exec(f);
    if (m) {
      vitest.push(
        `packages/${m[1]}/src/**/*.ts`,
        `!packages/${m[1]}/src/**/*.test.ts`,
      );
    } else if (f.startsWith('scripts/')) {
      tap.push(...tapScopeForScript(f));
    }
  }
  if (vitest.length === 0 && tap.length === 0) {
    return {
      vitest: [...DEFAULT_VITEST_MUTATE],
      tap: [...DEFAULT_TAP_MUTATE],
    };
  }
  return { vitest: [...new Set(vitest)], tap: [...new Set(tap)] };
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
  let files = [];
  try {
    files = ref ? changedFilesSince(ref) : [];
  } catch (err) {
    console.error(
      `mutation-scope: git diff failed (${err.message}), using proof scope`,
    );
  }
  const scope = scopeForChangedFiles(files);
  console.log(scope[runner].join(','));
}

const invokedAsMain =
  process.argv[1] != null &&
  new URL(import.meta.url).pathname === process.argv[1];
if (invokedAsMain) main(process.argv.slice(2));
