// Stages the npm package in release/ and packs it. The root package.json stays
// private (so `npm publish` cannot run from the monorepo by accident); what
// ships is generated here:
//   - the bundle (dist/kubic.js and its map), the bin wrapper, README.md,
//     LICENSE and NOTICE.md;
//   - a package.json with the published fields of the root manifest only (no
//     workspaces, scripts or devDependencies) and a `files` allow-list;
//   - npm-shrinkwrap.json, the production tree pinned to the versions the
//     root package-lock.json was tested with. It is resolved from that lock
//     without touching the network, then checked: no workspace links, no dev
//     or extraneous entries, no version the tested lock does not have.
//     Optional entries restricted to one platform are left out (see
//     dropPlatformEntries).
// Then `npm pack` writes release/kubic-<version>.tgz, which must stay within
// the size budget, and release/kubic-<version>.cdx.json beside it holds the
// CycloneDX SBOM of the shipped production tree, which must list every
// package the shrinkwrap pins. scripts/pack-install-contract.mjs proves the
// tarball.
//
// Usage: node scripts/release-stage.mjs   (npm run release:stage)
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const RELEASE_DIR = 'release';

// The root manifest fields a published package carries.
const RELEASE_FIELDS = [
  'name',
  'version',
  'description',
  'license',
  'type',
  'bin',
  'engines',
  'dependencies',
  'repository',
  'homepage',
  'bugs',
  'keywords',
  'author',
];

// What npm packs besides package.json, README.md and LICENSE, which it
// always includes.
export const RELEASE_FILES = [
  'bin',
  'dist',
  'npm-shrinkwrap.json',
  'NOTICE.md',
];

// The packed tarball's ceiling. The bundle and its map are most of it.
export const PACK_BUDGET_BYTES = 1.5 * 1024 * 1024;

// The copies staging makes, relative to the repository root.
const COPIED = [
  'bin/kubic.js',
  'bin/node-guard.mjs',
  'bin/env-proxy.mjs',
  'dist/kubic.js',
  'dist/kubic.js.map',
  'README.md',
  'LICENSE',
  'NOTICE.md',
];

export function releaseManifest(root) {
  const manifest = {};
  for (const field of RELEASE_FIELDS) {
    if (root[field] !== undefined) manifest[field] = root[field];
  }
  manifest.files = RELEASE_FILES;
  return manifest;
}

// A lockfile for the release package: the root lock's installed packages,
// without the workspace folders and the links to them, under a root entry
// describing the release manifest. Resolving it against that manifest keeps
// every version the root lock pins and drops what production does not reach.
export function seedLockfile(rootLock, manifest) {
  const packages = {
    '': {
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
      bin: manifest.bin,
      engines: manifest.engines,
      dependencies: manifest.dependencies,
    },
  };
  for (const [path, entry] of Object.entries(rootLock.packages ?? {})) {
    if (path.startsWith('node_modules/') && entry.link !== true) {
      packages[path] = entry;
    }
  }
  return {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages,
  };
}

// An optional entry restricted by `os` or `cpu` is one platform's build, such
// as esbuild's @esbuild/<platform> binaries. npm 11 installs every such entry
// of a dependency's shrinkwrap whatever the platform (npm 10 picks the one
// that matches), which would add every platform's binary to a user's
// install. Left out, they are installed the way the package that wants them
// arranges: esbuild pins its platform packages exactly and fetches the
// matching one in its postinstall.
function isPlatformEntry(entry) {
  return (
    entry.optional === true &&
    (entry.os !== undefined || entry.cpu !== undefined)
  );
}

export function dropPlatformEntries(shrinkwrap) {
  const packages = {};
  const dropped = [];
  for (const [path, entry] of Object.entries(shrinkwrap.packages ?? {})) {
    if (isPlatformEntry(entry)) dropped.push(path);
    else packages[path] = entry;
  }
  return { shrinkwrap: { ...shrinkwrap, packages }, dropped };
}

export function shrinkwrapProblems(shrinkwrap, rootLock) {
  const problems = [];
  for (const [path, entry] of Object.entries(shrinkwrap.packages ?? {})) {
    if (path === '') continue;
    if (!path.startsWith('node_modules/')) {
      problems.push(`${path}: not a node_modules path`);
      continue;
    }
    if (entry.link === true) {
      problems.push(
        `${path}: a link entry (a workspace leaked into the release tree)`,
      );
      continue;
    }
    if (entry.dev === true) {
      problems.push(`${path}: a dev entry`);
      continue;
    }
    if (entry.extraneous === true) {
      problems.push(`${path}: an extraneous entry`);
      continue;
    }
    if (isPlatformEntry(entry)) {
      problems.push(
        `${path}: restricted to one platform; npm 11 would install it on every platform`,
      );
      continue;
    }
    const tested = rootLock.packages?.[path];
    if (tested === undefined) {
      problems.push(
        `${path}: ${entry.version} is not in the tested package-lock.json`,
      );
    } else if (tested.version !== entry.version) {
      problems.push(
        `${path}: ${entry.version}, but the tested package-lock.json has ${tested.version}`,
      );
    }
  }
  return problems;
}

export function packProblems(pack) {
  if (pack.size <= PACK_BUDGET_BYTES) return [];
  return [
    `the tarball is ${pack.size} bytes, above the ${PACK_BUDGET_BYTES}-byte budget`,
  ];
}

// The SBOM file written beside the tarball.
export function sbomFileName(manifest) {
  return `${manifest.name}-${manifest.version}.cdx.json`;
}

// npm names the root component after the directory it ran in (release/), so
// the root takes the package's own name; its bom-ref and purl already carry it.
export function finishSbom(sbom, manifest) {
  return {
    ...sbom,
    metadata: {
      ...sbom.metadata,
      component: { ...sbom.metadata.component, name: manifest.name },
    },
  };
}

// The SBOM must be CycloneDX and list every package the shrinkwrap pins.
export function sbomProblems(sbom, shrinkwrap) {
  if (sbom.bomFormat !== 'CycloneDX') return ['the SBOM is not CycloneDX'];
  const listed = new Set(
    (sbom.components ?? []).map((item) => `${item.name}@${item.version}`),
  );
  const problems = [];
  for (const [path, entry] of Object.entries(shrinkwrap.packages ?? {})) {
    if (path === '') continue;
    const name =
      entry.name ??
      path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (!listed.has(`${name}@${entry.version}`)) {
      problems.push(`the SBOM does not list ${name}@${entry.version}`);
    }
  }
  return problems;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function npm(args, cwd) {
  return execFileSync('npm', args, { cwd, encoding: 'utf8' });
}

function stage(root = REPO_ROOT) {
  execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
  const out = join(root, RELEASE_DIR);
  rmSync(out, { recursive: true, force: true });
  for (const file of COPIED) {
    mkdirSync(dirname(join(out, file)), { recursive: true });
    cpSync(join(root, file), join(out, file));
  }
  const manifest = releaseManifest(readJson(join(root, 'package.json')));
  const rootLock = readJson(join(root, 'package-lock.json'));
  writeFileSync(
    join(out, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  writeFileSync(
    join(out, 'package-lock.json'),
    `${JSON.stringify(seedLockfile(rootLock, manifest), null, 2)}\n`,
  );
  // Lockfile only: no download, no install scripts.
  npm(
    [
      'install',
      '--package-lock-only',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ],
    out,
  );
  const { shrinkwrap } = dropPlatformEntries(
    readJson(join(out, 'package-lock.json')),
  );
  rmSync(join(out, 'package-lock.json'));
  writeFileSync(
    join(out, 'npm-shrinkwrap.json'),
    `${JSON.stringify(shrinkwrap, null, 2)}\n`,
  );
  const problems = shrinkwrapProblems(shrinkwrap, rootLock);
  const [pack] = JSON.parse(
    npm(['pack', '--json', '--pack-destination', out], out),
  );
  problems.push(...packProblems(pack));
  // Resolved from the shrinkwrap, like the lockfile: no download.
  const sbom = finishSbom(
    JSON.parse(
      npm(
        [
          'sbom',
          '--sbom-format',
          'cyclonedx',
          '--sbom-type',
          'application',
          '--package-lock-only',
          '--omit=dev',
        ],
        out,
      ),
    ),
    manifest,
  );
  writeFileSync(
    join(out, sbomFileName(manifest)),
    `${JSON.stringify(sbom, null, 2)}\n`,
  );
  problems.push(...sbomProblems(sbom, shrinkwrap));
  return { out, manifest, pack, sbom, problems };
}

if (import.meta.main) {
  const { out, manifest, pack, sbom, problems } = stage();
  for (const problem of problems) console.error(`release-stage: ${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log(
    `staged ${manifest.name}@${manifest.version}: ${join(out, pack.filename)} (${pack.size} bytes packed, ${pack.unpackedSize} unpacked, ${pack.entryCount} files)`,
  );
  console.log(
    `SBOM: ${join(out, sbomFileName(manifest))} (CycloneDX ${sbom.specVersion}, ${sbom.components.length} components)`,
  );
}
