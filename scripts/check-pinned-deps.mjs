// Exact-pin check (issue #4, design §65; extended to the CLI stack).
// Every dependency spec in every workspace package.json must be an exact
// version — no ^, ~, or ranges — so Pi upgrades AND third-party upgrades
// (commander, consola, @clack/prompts, dev tooling) are
// always deliberate. `overrides` entries stay Pi-only (they may pin nested
// transitive versions by design).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXACT_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

function packageJsonFiles(root) {
  const files = [join(root, 'package.json')];
  for (const area of ['packages', 'apps']) {
    // Stryker disable next-line ArrayDeclaration: a junk seed entry fails
    // statSync and is skipped, so the file list is identical (tracking: #66).
    let entries = [];
    try {
      entries = readdirSync(join(root, area));
      // Stryker disable next-line BlockStatement: without `continue`,
      // `entries` is still [] and the loop below is a no-op (tracking: #66).
    } catch {
      continue;
    }
    for (const e of entries) {
      const f = join(root, area, e, 'package.json');
      try {
        // Stryker disable next-line ConditionalExpression: pushing a
        // non-file is unobservable — readFileSync/parse throw and the
        // entry is skipped just the same (tracking: #66).
        if (statSync(f).isFile()) files.push(f);
      } catch {
        // no manifest — nothing to check
      }
    }
  }
  return files;
}

export function checkPinned(root) {
  const violations = [];
  for (const file of packageJsonFiles(root)) {
    let manifest;
    try {
      // Stryker disable next-line StringLiteral: "" encoding returns a
      // Buffer and JSON.parse coerces it identically (tracking: #66).
      manifest = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    for (const section of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      for (const [dep, spec] of Object.entries(manifest[section] ?? {})) {
        // Stryker disable next-line ConditionalExpression: dropping the
        // typeof guard is unobservable — no non-string JSON value
        // stringifies to an exact-version match (tracking: #66).
        if (typeof spec !== 'string' || !EXACT_RE.test(spec)) {
          violations.push({
            file: relative(root, file),
            dep,
            spec,
            reason: 'range-not-exact',
          });
        }
      }
    }
    for (const [dep, spec] of Object.entries(manifest.overrides ?? {})) {
      if (!dep.startsWith('@earendil-works/')) continue;
      if (typeof spec === 'string' && !EXACT_RE.test(spec)) {
        violations.push({
          file: relative(root, file),
          dep,
          spec,
          reason: 'range-not-exact',
        });
      }
    }
  }
  return violations;
}

const isMain = import.meta.main;
if (isMain) {
  const root =
    process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
  const violations = checkPinned(root);
  for (const v of violations) {
    console.log(
      `${v.file}: ${v.dep}@${v.spec} is not an exact pin (${v.reason})`,
    );
  }
  if (violations.length > 0) {
    console.log(`${violations.length} unpinned dependency(ies)`);
    process.exit(1);
  }
  console.log('dependency pins OK');
}
