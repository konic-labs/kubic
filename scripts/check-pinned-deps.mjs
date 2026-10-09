// Dependency pin check, over the root manifest and every workspace manifest:
//   - every dependency spec is an exact version (no ^, ~ or range), so Pi
//     upgrades and third-party upgrades (the CLI stack, dev tooling) are
//     always deliberate;
//   - no manifest has `overrides`: npm applies them only in this checkout,
//     never when someone installs kubic, so a pin that matters is a
//     dependency instead;
//   - every workspace dependency is declared by the root manifest with the
//     same spec. The root is the package npm installs, so its dependencies
//     are the runtime tree a user gets.

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
  const [rootFile, ...workspaceFiles] = packageJsonFiles(root);
  const rootDeps = readManifest(rootFile)?.dependencies ?? {};
  for (const file of [rootFile, ...workspaceFiles]) {
    const manifest = readManifest(file);
    if (manifest === undefined) continue;
    for (const section of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      for (const [dep, spec] of Object.entries(manifest[section] ?? {})) {
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
      violations.push({
        file: relative(root, file),
        dep,
        spec,
        reason: 'override',
      });
    }
    if (file === rootFile) continue;
    for (const [dep, spec] of Object.entries(manifest.dependencies ?? {})) {
      if (!Object.hasOwn(rootDeps, dep)) {
        violations.push({
          file: relative(root, file),
          dep,
          spec,
          reason: 'missing-from-root',
        });
      } else if (rootDeps[dep] !== spec) {
        violations.push({
          file: relative(root, file),
          dep,
          spec,
          reason: 'differs-from-root',
          rootSpec: rootDeps[dep],
        });
      }
    }
  }
  return violations;
}

function readManifest(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

// One line per violation, naming what to change.
export function describeViolation(v) {
  switch (v.reason) {
    case 'override':
      return `${v.file}: overrides.${v.dep} is refused: overrides never reach an npm install of kubic, so pin it as a dependency instead`;
    case 'missing-from-root':
      return `${v.file}: ${v.dep}@${v.spec} is not declared by the root package.json, the manifest npm installs`;
    case 'differs-from-root':
      return `${v.file}: ${v.dep}@${v.spec} differs from the root package.json's ${v.rootSpec}`;
    default:
      return `${v.file}: ${v.dep}@${v.spec} is not an exact pin`;
  }
}

const isMain = import.meta.main;
if (isMain) {
  const root =
    process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
  const violations = checkPinned(root);
  for (const v of violations) console.log(describeViolation(v));
  if (violations.length > 0) {
    console.log(`${violations.length} dependency pin problem(s)`);
    process.exit(1);
  }
  console.log('dependency pins OK');
}
