// Patch @stryker-mutator/vitest-runner 10.0.0 for vitest 5 name matching
// (docs/contributing.md "vitest-runner × vitest 5").
//
// The runner names tests by space-joining suite + test names, then filters
// each mutant run with that name as `testNamePattern`. Vitest 5 matches the
// pattern against `fullTestName` (`" > "`-joined), so every filtered run
// executed zero tests (a false "Survived") and `coverageAnalysis: "perTest"`
// was unusable — each mutant fell back to the full suite (~9h CI runs).
//
// Fix: name tests by vitest's own `fullTestName` (old join kept as fallback
// for older vitest), and anchor the filter so "a" does not also select
// "a b". Runs on `postinstall`; idempotent; fails loudly on an unknown
// runner shape so a runner upgrade can never silently drop the fix.

const MARKER = '/* kubic-patch: vitest5-fullTestName */';

const NAME_FN_OLD = 'collectTestName({ name, suite, }) {';
const NAME_FN_NEW = `collectTestName(task) {\n    ${MARKER}\n    if (typeof task.fullTestName === 'string') return task.fullTestName;\n    const { name, suite } = task;`;

const REGEX_OLD = 'const regex = new RegExp(regexTestNameFilter);';
const REGEX_NEW = `${MARKER}\n            const regex = new RegExp(\`^(?:\${regexTestNameFilter})$\`);`;

export const PATCHES = [
  { file: 'test-helpers.js', old: NAME_FN_OLD, new: NAME_FN_NEW },
  { file: 'stryker-setup.js', old: NAME_FN_OLD, new: NAME_FN_NEW },
  { file: 'vitest-test-runner.js', old: REGEX_OLD, new: REGEX_NEW },
];

// Returns the patched source, or the input unchanged when already patched.
export function patchSource(source, patch) {
  if (source.includes(MARKER)) return source;
  const at = source.indexOf(patch.old);
  if (at === -1 || source.indexOf(patch.old, at + 1) !== -1) {
    throw new Error(
      `patch-vitest-runner: expected exactly one "${patch.old}" in ${patch.file}; ` +
        'the runner changed shape — re-verify before upgrading',
    );
  }
  // Function replacer: the new text contains "$`", which a string
  // replacement would expand to the text preceding the match.
  return source.replace(patch.old, () => patch.new);
}

export function patchDir(dir) {
  const fs = process.getBuiltinModule('node:fs');
  const path = process.getBuiltinModule('node:path');
  const changed = [];
  for (const patch of PATCHES) {
    const file = path.join(dir, patch.file);
    const before = fs.readFileSync(file, 'utf8');
    const after = patchSource(before, patch);
    if (after !== before) {
      fs.writeFileSync(file, after);
      changed.push(patch.file);
    }
  }
  return changed;
}

function main() {
  const fs = process.getBuiltinModule('node:fs');
  const path = process.getBuiltinModule('node:path');
  const dir = path.resolve(
    'node_modules/@stryker-mutator/vitest-runner/dist/src',
  );
  // Production installs (`--omit=dev`) have no runner: nothing to patch.
  if (!fs.existsSync(dir)) return;
  const changed = patchDir(dir);
  if (changed.length > 0) {
    console.log(`patch-vitest-runner: patched ${changed.join(', ')}`);
  }
}

if (import.meta.main) main();
