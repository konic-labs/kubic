// Dep-direction lint for the Kubic monorepo (issue #2, design §64 + §3.1).
//
// One-way dependency rule: packages may only import "downward".
// Forbidden edges (importer -> forbidden imported packages):
const FORBIDDEN = {
  core: ['exec', 'worker', 'host', 'agents', 'trajectory', 'eval', 'tui'],
  exec: ['worker', 'host', 'agents', 'trajectory', 'eval', 'tui'],
  worker: ['host', 'tui'],
  host: ['tui'],
  agents: ['host', 'worker', 'tui', 'trajectory', 'eval'],
  trajectory: ['exec', 'worker', 'host', 'agents', 'eval', 'tui'],
  eval: ['exec', 'worker', 'host', 'tui'],
  tui: ['exec', 'worker', 'host', 'agents', 'trajectory', 'eval'],
  // extensions sits above the library layers it dogfoods (core/exec/agents/
  // trajectory/eval) but below the runtime implementations: a bundle facade
  // must never reach into worker/host/tui implementation or the app root.
  // Intra-package facet splits (tui never imports host, worker never pi-tui)
  // are enforced in checkTree below (issue #37, §32).
  extensions: ['worker', 'host', 'tui', 'kubic'],
  // apps/kubic is the composition root: may wire host + tui together.
  kubic: [],
};

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const IMPORT_RE =
  /(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|(?:import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

function tsFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e === 'dist') continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) tsFiles(full, out);
    else if (/\.m?[jt]sx?$/.test(e)) out.push(full);
  }
  return out;
}

// Resolve an import specifier found in `ownerPkg` to an internal package name,
// or null when it is external (node builtin, npm dep) or intra-package.
function resolveTarget(ownerPkg, importerFile, spec, root) {
  if (spec.startsWith('@kubic/')) {
    const name = spec.slice('@kubic/'.length).split('/')[0];
    return name === ownerPkg ? null : name;
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

import { dirname } from 'node:path';

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
          // I/O confinement (§9, issue #12): only packages/exec (the
          // ExecutionEnv binding) touches node:fs/child_process. Tools go
          // through the seam. Test scaffolding is exempt.
          const line = content.slice(0, m.index).split('\n').length;
          violations.push({
            from: owner,
            to: spec,
            file: relative(root, file),
            line,
          });
          continue;
        }
        if (spec.startsWith('@earendil-works/')) {
          // Pi seam rule (§65): only designated boundary files may touch Pi
          // modules — exact path match, no suffix bypass. Worker owns the
          // agent/model seam; TUI owns the presentation seam (it cannot
          // import worker implementation, so it cannot reuse its boundary).
          const rel = relative(root, file);
          const isBoundary =
            (owner === 'worker' &&
              rel === join('packages', 'worker', 'src', 'pi-boundary.ts')) ||
            (owner === 'tui' &&
              rel === join('packages', 'tui', 'src', 'tui-boundary.ts'));
          if (!isBoundary) {
            const line = content.slice(0, m.index).split('\n').length;
            violations.push({
              from: owner,
              to: spec,
              file: relative(root, file),
              line,
            });
          }
          continue;
        }
        const target = resolveTarget(owner, file, spec, root);
        if (target && forbidden.has(target)) {
          const line = content.slice(0, m.index).split('\n').length;
          violations.push({
            from: owner,
            to: target,
            file: relative(root, file),
            line,
          });
        }
        if (owner === 'extensions') {
          // Facet splits, issue #37 §32: a tui facet file (*/tui.ts or
          // */tui/*) never imports host — including the same-package host
          // facet, which the package-level rule above cannot see. A worker
          // facet file never imports pi-tui.
          const rel = relative(root, file);
          const segs = rel.split(sep);
          const base = segs[segs.length - 1] ?? '';
          const isTuiFacet = segs.includes('tui') || base.startsWith('tui.');
          const isWorkerFacet =
            segs.includes('worker') || base.startsWith('worker.');
          const mentionsHost =
            spec === '@kubic/host' ||
            spec.startsWith('@kubic/host/') ||
            target === 'host' ||
            /(^|\/)host(\/|$|\.)/.test(spec);
          if (isTuiFacet && mentionsHost) {
            const line = content.slice(0, m.index).split('\n').length;
            violations.push({
              from: owner,
              to: 'host (tui facet)',
              file: rel,
              line,
            });
          }
          if (isWorkerFacet && spec.includes('pi-tui')) {
            const line = content.slice(0, m.index).split('\n').length;
            violations.push({
              from: owner,
              to: `${spec} (worker facet)`,
              file: rel,
              line,
            });
          }
        }
      }
    }
  }
  return violations;
}

// All internal package-to-package import edges (allowed ones included).
// checkTree above reports only violations; this lists every edge so docs
// can cross-check neighbour lists against the real tree (issue #63
// review: diagram drift must fail CI, not just forbidden imports).
export function listInternalEdges(root) {
  const edges = [];
  const packagesDir = join(root, 'packages');
  let owners = [];
  try {
    owners = readdirSync(packagesDir).filter((e) =>
      statSync(join(packagesDir, e)).isDirectory(),
    );
  } catch {
    return edges;
  }
  owners.push('kubic');
  for (const owner of owners) {
    const srcDir =
      owner === 'kubic'
        ? join(root, 'apps', 'kubic')
        : join(packagesDir, owner);
    for (const file of tsFiles(srcDir)) {
      const content = readFileSync(file, 'utf8');
      for (const m of content.matchAll(IMPORT_RE)) {
        const spec = m[1] ?? m[2];
        const target = resolveTarget(owner, file, spec, root);
        if (target) {
          const line = content.slice(0, m.index).split('\n').length;
          edges.push({
            from: owner,
            to: target,
            file: relative(root, file),
            line,
          });
        }
      }
    }
  }
  return edges;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const root =
    process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
  const violations = checkTree(root);
  for (const v of violations) {
    console.log(`${v.file}:${v.line}: forbidden import ${v.from} -> ${v.to}`);
  }
  if (violations.length > 0) {
    console.log(`${violations.length} forbidden import(s)`);
    process.exit(1);
  }
  console.log('dep-direction OK');
}
