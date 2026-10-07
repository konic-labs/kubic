// Dead-surface reachability gate.
//
// Recomputes which non-test source files are unreachable from the binary's
// entry (apps/kubic/src/main.ts — the only module bin/kubic.js can reach) by
// walking VALUE imports (import type is erased, so it never makes a file
// reachable). Compares the result with DEAD_FILES in dead-surface.mjs and
// fails when:
//   - a file is runtime-dead but not listed (a new dead file landed);
//   - a listed file no longer exists or is now reachable (the list went
//     stale).
//
// Usage:
//   node scripts/reachability.mjs            # check against the list
//   node scripts/reachability.mjs --report   # print dead files + LOC, no gate
//   node scripts/reachability.mjs --json     # machine-readable report
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEAD_FILES } from './dead-surface.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = 'apps/kubic/src/main.ts';

// Directories that never participate: fixtures, upstream reference, build
// output, and the tool's own caches.
const SKIP_DIRS = new Set([
  'node_modules',
  'pi',
  'dist',
  '.git',
  'reports',
  'coverage',
]);

function isSource(file) {
  return (
    file.endsWith('.ts') &&
    !file.endsWith('.test.ts') &&
    !file.endsWith('.d.ts')
  );
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// Value imports only: `import x from '...'`, `import { a } from '...'`,
// `import '...'`, and dynamic `import('...')`. `import type ...` is erased
// syntax and deliberately excluded.
const IMPORT_RE =
  /^\s*import\s+(?!type\s)(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]/gm;
const DYNAMIC_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

function importsOf(file) {
  const text = readFileSync(file, 'utf8');
  const specs = new Set();
  for (const m of text.matchAll(IMPORT_RE)) specs.add(m[1]);
  for (const m of text.matchAll(DYNAMIC_RE)) specs.add(m[1]);
  return specs;
}

function resolvesTo(file, spec) {
  if (!spec.startsWith('.')) return null; // package imports are not repo files
  const base = resolve(dirname(file), spec);
  // The codebase uses NodeNext-style `.js` specifiers over `.ts` sources.
  const asTs = base.endsWith('.js') ? `${base.slice(0, -3)}.ts` : `${base}.ts`;
  if (existsSync(asTs)) return asTs;
  if (existsSync(base) && isSource(base)) return base;
  const index = join(base, 'index.ts');
  if (existsSync(index)) return index;
  return null;
}

export function computeReachable(root = ROOT, entry = ENTRY) {
  // `entry` may be repo-relative (the default) or absolute (what entryFor
  // returns for a fixture tree); resolve before walking.
  const entryAbs = entry.startsWith('/') ? entry : join(root, entry);
  const reachable = new Set([entryAbs]);
  const queue = [entryAbs];
  const edges = new Map();
  while (queue.length > 0) {
    const file = queue.pop();
    const outs = [];
    for (const spec of importsOf(file)) {
      const target = resolvesTo(file, spec);
      if (target === null) continue;
      outs.push(target);
      if (!reachable.has(target)) {
        reachable.add(target);
        queue.push(target);
      }
    }
    edges.set(file, outs);
  }
  return { reachable, edges };
}

// The entry for a given root: the repo entry, or the single app entry a
// fixture tree provides (tests build `apps/<name>/src/main.ts`).
function entryFor(root) {
  if (existsSync(join(root, ENTRY))) return join(root, ENTRY);
  const apps = join(root, 'apps');
  if (existsSync(apps)) {
    const candidates = [];
    for (const app of readdirSync(apps)) {
      const main = join(apps, app, 'src', 'main.ts');
      if (existsSync(main)) candidates.push(main);
    }
    if (candidates.length === 1) return candidates[0];
  }
  return join(root, ENTRY);
}

export function allSources(root = ROOT) {
  const out = [];
  const packagesRoot = join(root, 'packages');
  if (existsSync(packagesRoot)) {
    for (const pkg of readdirSync(packagesRoot)) {
      const src = join(packagesRoot, pkg, 'src');
      if (existsSync(src) && statSync(src).isDirectory()) walk(src, out);
    }
  }
  const apps = join(root, 'apps');
  if (existsSync(apps)) {
    for (const app of readdirSync(apps)) {
      const src = join(apps, app, 'src');
      if (existsSync(src) && statSync(src).isDirectory()) walk(src, out);
    }
  }
  return out.filter(isSource);
}

export function deadFiles(root = ROOT) {
  const { reachable } = computeReachable(root, entryFor(root));
  return allSources(root)
    .filter((f) => !reachable.has(f))
    .map((f) => relative(root, f))
    .sort();
}

function lineCount(root, file) {
  return readFileSync(join(root, file), 'utf8').split('\n').length;
}

export function checkSurface(root = ROOT, known = DEAD_FILES) {
  const dead = deadFiles(root);
  const rows = new Map(Object.entries(known));
  const uncovered = dead.filter((f) => !rows.has(f));
  const stale = [...rows.keys()].filter(
    (f) =>
      !dead.includes(f) &&
      !allSources(root)
        .map((x) => relative(root, x))
        .includes(f),
  );
  const wired = [...rows.keys()].filter(
    (f) =>
      !dead.includes(f) &&
      allSources(root)
        .map((x) => relative(root, x))
        .includes(f),
  );
  return { dead, rows, uncovered, stale, wired };
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const report = argv.includes('--report');
  if (report || json) {
    const dead = deadFiles(ROOT);
    const sources = allSources(ROOT).map((x) => relative(ROOT, x));
    const payload = {
      deadFiles: dead.length,
      deadLoc: dead.reduce((sum, f) => sum + lineCount(ROOT, f), 0),
      productionFiles: sources.length,
      unlisted: dead.filter((f) => !Object.hasOwn(DEAD_FILES, f)),
    };
    if (json) console.log(JSON.stringify(payload, null, 2));
    else {
      console.log(
        `production files: ${payload.productionFiles} · dead: ${payload.deadFiles} (${payload.deadLoc} LOC)`,
      );
      for (const f of dead) console.log(`  ${f}`);
    }
    return 0;
  }
  const result = checkSurface();
  const deadLoc = result.dead.reduce((sum, f) => sum + lineCount(ROOT, f), 0);
  let failed = false;
  if (result.uncovered.length > 0) {
    failed = true;
    console.error(
      `dead surface: ${result.uncovered.length} file(s) runtime-dead and not listed:`,
    );
    for (const f of result.uncovered) console.error(`  ${f}`);
    console.error(
      'Wire or delete the file, or list it in scripts/dead-surface.mjs with its reason.',
    );
  }
  if (result.stale.length > 0) {
    failed = true;
    console.error(
      `dead surface: ${result.stale.length} listed file(s) no longer exist:`,
    );
    for (const f of result.stale) console.error(`  ${f}`);
  }
  if (result.wired.length > 0) {
    failed = true;
    console.error(
      `dead surface: ${result.wired.length} listed file(s) are now reachable — remove them from the list:`,
    );
    for (const f of result.wired) console.error(`  ${f}`);
  }
  if (failed) return 1;
  console.log(
    `dead surface OK: ${result.dead.length} dead file(s) (${deadLoc} LOC), every one listed`,
  );
  return 0;
}

// Main-module guard: import.meta.main is spelling-proof (symlinks,
// /var vs /private/var, percent-encoded spaces) — a false guard would make
// the gate exit 0 without checking anything.
const isMain = import.meta.main;

if (isMain) {
  process.exit(main());
}
