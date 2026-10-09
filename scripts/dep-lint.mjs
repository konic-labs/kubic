// Dep-direction lint for the Kubic monorepo.
//
// One-way dependency rule: packages may only import "downward".
// Forbidden edges (importer -> forbidden imported packages):
//
// Every non-root package forbids the `kubic` composition root: through the
// app root a package reaches host/agent implementation transitively. The
// rule holds in tests too — a package test reaching the app root is a
// dependency inversion (the composition root's behaviour tests live under
// apps/kubic). A package missing from this table forbids every listed
// target (the `??` fallback in checkTree), so a new package is denied by
// default.
//
// Packages import each other by name only: `@kubic/<pkg>/<subpath>`, through
// the package's exports map. So the edges are read from the `@kubic/*`
// specifiers, and a relative path that leaves its own package is a violation
// of its own, whatever the edge. Root-level code (test/, bin/, the root
// config files and the repo scripts) owns no package, so it gets that
// relative rule and no edge rule.
const FORBIDDEN = {
  core: ['exec', 'agent', 'host', 'trajectory', 'eval', 'tui', 'kubic'],
  exec: ['agent', 'host', 'trajectory', 'eval', 'tui', 'kubic'],
  agent: ['host', 'tui', 'trajectory', 'eval', 'kubic'],
  host: ['tui', 'kubic'],
  trajectory: ['exec', 'agent', 'host', 'eval', 'tui', 'kubic'],
  eval: ['exec', 'agent', 'host', 'tui', 'kubic'],
  tui: ['exec', 'agent', 'host', 'trajectory', 'eval', 'kubic'],
  // apps/kubic is the composition root: may wire host + tui together.
  kubic: [],
};

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Specifiers in a real import position, a require, or a vitest mock call.
const IMPORT_RE =
  /(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|(?:import\s*\(\s*|require\s*\(\s*|vi\.(?:mock|doMock|importActual|importMock|unmock|doUnmock)\s*\(\s*)['"]([^'"]+)['"]/g;

// Test scaffolding lives under test-support/ and serves tests only. A
// production file that imports it would ship fixtures in the product, so only
// test files and test-support modules may import it.
const TEST_SUPPORT_SPEC = /(^|\/)test-support(\/|$)/;
const TEST_FILE = /\.test\.m?[jt]sx?$/;

// The root test/ folder holds the shared test fixtures (the fake terminal,
// the hermetic setup): tests only, the same as test-support/.
function reachesRootTests(importerFile, spec, root) {
  if (!spec.startsWith('.')) return false;
  const rel = relative(root, resolve(dirname(importerFile), spec));
  return rel.split(sep)[0] === 'test';
}

// Packages organised into concern folders, each with an index.ts entry: a
// module in one folder reaches another folder only through that entry, never
// into its internal modules. test-support/ holds shared test fixtures, not a
// concern, so tests import its modules directly.
const FOLDER_ENTRY_PACKAGES = new Set(['host']);

// The concern folder a file under packages/<owner>/src/ belongs to, or null
// for a file at the src root (or outside src).
function concernFolder(owner, file, root) {
  const parts = relative(join(root, 'packages', owner, 'src'), file).split(sep);
  return parts.length > 1 && parts[0] !== '..' ? parts[0] : null;
}

// The app's manifest is `@kubic/cli`; its directory, apps/kubic, is the
// `kubic` owner in FORBIDDEN.
const OWNER_OF_PACKAGE_NAME = { cli: 'kubic' };

function isTestScaffold(rel) {
  return TEST_FILE.test(rel) || rel.split(sep).includes('test-support');
}

function listDir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function tsFiles(dir, out = []) {
  for (const e of listDir(dir)) {
    if (e === 'node_modules' || e === 'dist') continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) tsFiles(full, out);
    else if (/\.m?[jt]sx?$/.test(e)) out.push(full);
  }
  return out;
}

// Root-level code that belongs to no workspace package: the shared test
// fixtures, the launcher, the vitest config and setup, and the repo scripts.
// scripts/*.test.mjs are left out: they hold fixture source inside template
// strings, which a line scan would read as live imports.
function rootSourceFiles(root) {
  const files = [...tsFiles(join(root, 'bin')), ...tsFiles(join(root, 'test'))];
  for (const e of listDir(root)) {
    const full = join(root, e);
    if (/\.m?[jt]sx?$/.test(e) && statSync(full).isFile()) files.push(full);
  }
  for (const e of listDir(join(root, 'scripts'))) {
    if (/\.mjs$/.test(e) && !/\.test\.mjs$/.test(e)) {
      files.push(join(root, 'scripts', e));
    }
  }
  return files;
}

// Resolve an import specifier found in `ownerPkg` (null for root-level code)
// to the workspace package it reaches, or null when it stays inside `ownerPkg`
// or is external (node builtin, npm dep, a path outside every package).
function resolveTarget(ownerPkg, importerFile, spec, root) {
  if (spec.startsWith('@kubic/')) {
    const name = spec.slice('@kubic/'.length).split('/')[0];
    const owner = OWNER_OF_PACKAGE_NAME[name] ?? name;
    return owner === ownerPkg ? null : owner;
  }
  if (spec.startsWith('.')) {
    const abs = resolve(dirname(importerFile), spec);
    const rel = relative(root, abs);
    const parts = rel.split(sep);
    if (parts[0] === 'packages' && parts[1] && parts[1] !== ownerPkg)
      return parts[1];
    if (parts[0] === 'apps' && ownerPkg !== 'kubic') return 'kubic';
  }
  return null;
}

export function checkTree(root) {
  const violations = [];
  const packagesDir = join(root, 'packages');
  let owners = [];
  try {
    owners = readdirSync(packagesDir).filter((e) =>
      statSync(join(packagesDir, e)).isDirectory(),
    );
  } catch {
    return violations;
  }
  owners.push('kubic');
  for (const owner of owners) {
    const srcDir =
      owner === 'kubic'
        ? join(root, 'apps', 'kubic')
        : join(packagesDir, owner);
    const forbidden = new Set(FORBIDDEN[owner] ?? Object.keys(FORBIDDEN));
    for (const file of tsFiles(srcDir)) {
      const content = readFileSync(file, 'utf8');
      for (const m of content.matchAll(IMPORT_RE)) {
        const spec = m[1] ?? m[2];
        const line = content.slice(0, m.index).split('\n').length;
        if (
          (TEST_SUPPORT_SPEC.test(spec) ||
            reachesRootTests(file, spec, root)) &&
          !isTestScaffold(relative(root, file))
        ) {
          // Test scaffolding is for tests: a production file that imports it
          // would ship fixtures in the product.
          violations.push({
            kind: 'test-support',
            from: owner,
            to: spec,
            file: relative(root, file),
            line,
          });
          continue;
        }
        if (
          (spec === 'node:fs' ||
            spec.startsWith('node:fs/') ||
            spec === 'fs' ||
            spec === 'node:child_process' ||
            spec.startsWith('node:child_process/') ||
            spec === 'child_process') &&
          owner !== 'exec' &&
          !file.endsWith('.test.ts')
        ) {
          // I/O confinement: only packages/exec (the
          // ExecutionEnv binding) touches node:fs/child_process. Tools go
          // through the seam. Test scaffolding is exempt.
          violations.push({
            kind: 'io',
            from: owner,
            to: spec,
            file: relative(root, file),
            line,
          });
          continue;
        }
        if (spec.startsWith('@earendil-works/')) {
          // Pi seam rule: only designated boundary files may touch Pi
          // modules — exact path match, no suffix bypass. Agent owns the
          // agent/model seam; TUI owns the presentation seam (it cannot
          // import agent implementation, so it cannot reuse its boundary).
          const rel = relative(root, file);
          const isBoundary =
            (owner === 'agent' &&
              rel === join('packages', 'agent', 'src', 'pi-boundary.ts')) ||
            (owner === 'tui' &&
              rel === join('packages', 'tui', 'src', 'tui-boundary.ts'));
          if (!isBoundary) {
            violations.push({
              kind: 'pi',
              from: owner,
              to: spec,
              file: relative(root, file),
              line,
            });
          }
          continue;
        }
        if (FOLDER_ENTRY_PACKAGES.has(owner) && spec.startsWith('.')) {
          const from = concernFolder(owner, file, root);
          const abs = resolve(dirname(file), spec);
          const to = concernFolder(owner, abs, root);
          const entry =
            to !== null &&
            relative(join(root, 'packages', owner, 'src', to), abs) ===
              'index.js';
          if (
            from !== null &&
            to !== null &&
            from !== to &&
            to !== 'test-support' &&
            !entry
          ) {
            // A deep import into another concern folder: go through its entry.
            violations.push({
              kind: 'folder',
              from: `${owner}/${from}`,
              to: `${owner}/${to}`,
              file: relative(root, file),
              line,
            });
            continue;
          }
        }
        const target = resolveTarget(owner, file, spec, root);
        if (target === null) continue;
        if (spec.startsWith('.')) {
          // A relative path into another package: import it by name instead.
          violations.push({
            kind: 'relative',
            from: owner,
            to: target,
            file: relative(root, file),
            line,
          });
        } else if (forbidden.has(target)) {
          violations.push({
            kind: 'edge',
            from: owner,
            to: target,
            file: relative(root, file),
            line,
          });
        }
      }
    }
  }
  for (const file of rootSourceFiles(root)) {
    const content = readFileSync(file, 'utf8');
    for (const m of content.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2];
      if (!spec.startsWith('.')) continue;
      const target = resolveTarget(null, file, spec, root);
      if (target === null) continue;
      violations.push({
        kind: 'relative',
        from: 'root',
        to: target,
        file: relative(root, file),
        line: content.slice(0, m.index).split('\n').length,
      });
    }
  }
  return violations;
}

const isMain = import.meta.main;
if (isMain) {
  const root =
    process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
  const violations = checkTree(root);
  for (const v of violations) {
    const what =
      v.kind === 'relative'
        ? `relative import into package ${v.to} from ${v.from} (import it by name: @kubic/<pkg>/<subpath>)`
        : v.kind === 'folder'
          ? `deep import into ${v.to}/ from ${v.from}/ (import its entry: ../${v.to.split('/')[1]}/index.js)`
          : `forbidden import ${v.from} -> ${v.to}`;
    console.log(`${v.file}:${v.line}: ${what}`);
  }
  if (violations.length > 0) {
    console.log(`${violations.length} forbidden import(s)`);
    process.exit(1);
  }
  console.log('dep-direction OK');
}
