// Exact-pin check for Pi dependencies (issue #4, design §65).
// Every @earendil-works/* spec in every workspace package.json must be an
// exact version — no ^, ~, or ranges — so Pi upgrades are always deliberate.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXACT_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

function packageJsonFiles(root) {
  const files = [join(root, 'package.json')];
  for (const area of ['packages', 'apps']) {
    let entries = [];
    try {
      entries = readdirSync(join(root, area));
    } catch {
      continue;
    }
    for (const e of entries) {
      const f = join(root, area, e, 'package.json');
      try {
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
        if (!dep.startsWith('@earendil-works/')) continue;
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

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
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
    console.log(`${violations.length} unpinned Pi dependency(ies)`);
    process.exit(1);
  }
  console.log('pi pins OK');
}
