// Proves the staged release package (release/, from scripts/release-stage.mjs)
// installs and runs the way a user gets it:
//   1. the tarball holds exactly the release files: the bundle, the bin
//      wrapper, the manifest, the shrinkwrap and the notices, and no test,
//      source, tooling or local state;
//   2. installed from the tarball into an empty prefix (empty HOME, empty
//      cache), `kubic --version`, `kubic --help`, `kubic doctor` and a faux
//      `kubic run` work from an empty directory;
//   3. installed from a registry, npm honours npm-shrinkwrap.json: every
//      production package lands at its locked version. A tarball install
//      ignores a shrinkwrap, so this install goes through a loopback registry
//      that serves the staged package as a version with `_hasShrinkwrap`, the
//      flag the public registry sets, and forwards every other request to the
//      public registry. The install is engine-strict, so on the lowest
//      supported Node it also proves no locked package needs a newer one,
//      and it must stay within the install-size budget.
// Step 3 needs the network; `--skip-registry` leaves it out for an offline
// check.
//
// Usage: node scripts/pack-install-contract.mjs [--skip-registry]
//        (npm run release:contract)
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_DIR } from './release-stage.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const UPSTREAM_REGISTRY = 'https://registry.npmjs.org';

// The ceiling for a user's install (everything under node_modules). Most of
// it is the provider SDKs Pi loads; every platform's esbuild binary would add
// about 250 MB more (see dropPlatformEntries in release-stage.mjs).
export const INSTALL_BUDGET_BYTES = 200 * 1024 * 1024;

// The files a user's install needs. npm adds package.json, README.md and
// LICENSE itself; the rest is the release manifest's `files`.
export const REQUIRED_FILES = [
  'package.json',
  'README.md',
  'LICENSE',
  'NOTICE.md',
  'npm-shrinkwrap.json',
  'bin/kubic.js',
  'bin/node-guard.mjs',
  'dist/kubic.js',
];

const OPTIONAL_FILES = ['dist/kubic.js.map'];

// Why a file outside the allow-list must not ship, first match wins.
const DENIED = [
  [/\.test\.(js|mjs|ts)$/, 'a test file'],
  [/\.ts$/, 'TypeScript source'],
  [/^scripts\//, 'repository tooling'],
  [/^docs\//, 'repository docs'],
  [/^test\//, 'test fixtures'],
  [/^\.github\//, 'CI configuration'],
  [/^\.kubic\//, 'local Kubic state'],
  [/^(CLAUDE|AGENTS)\.md$/, 'private agent notes'],
  [/^CODEOWNERS$/, 'repository ownership'],
  [/^package-lock\.json$/, 'the development lockfile'],
  [/^\.npmrc$/, 'npm configuration'],
  [
    /^(tsconfig[^/]*\.json|biome\.json|knip[^/]*\.jsonc?)$/,
    'development configuration',
  ],
  [/^(vitest|stryker)[^/]*$/, 'test configuration'],
  [/^reports\//, 'test reports'],
  [/^pi\//, 'a local Pi clone'],
];

// Entries of `tar -tzf` (each under `package/`), checked against the
// allow-list: every required file present, nothing else.
export function fileListProblems(entries) {
  const files = entries
    .filter((entry) => !entry.endsWith('/'))
    .map((entry) => entry.replace(/^package\//, ''));
  const problems = [];
  for (const file of REQUIRED_FILES) {
    if (!files.includes(file)) problems.push(`missing ${file}`);
  }
  for (const file of files) {
    if (REQUIRED_FILES.includes(file) || OPTIONAL_FILES.includes(file)) {
      continue;
    }
    const denied = DENIED.find(([pattern]) => pattern.test(file));
    problems.push(
      denied === undefined
        ? `unexpected ${file}`
        : `unexpected ${file} (${denied[1]})`,
    );
  }
  return problems;
}

export function versionProblems(result, version) {
  const want = `kubic ${version} (license: MIT)`;
  if (result.code !== 0) {
    return [`kubic --version exited ${result.code}: ${result.stderr.trim()}`];
  }
  const got = result.stdout.trim();
  return got === want
    ? []
    : [
        `kubic --version printed ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
      ];
}

// Doctor's exit code depends on the machine's providers, so only its summary
// line is the contract.
export function doctorProblems(result) {
  if (/^doctor: \d+ pass, \d+ warn, \d+ fail, \d+ skip$/m.test(result.stdout)) {
    return [];
  }
  return [
    `kubic doctor printed no summary (exit ${result.code}): ${result.stderr.trim()}`,
  ];
}

// `KUBIC_PROVIDER=faux kubic run -p hello --json`: one completed envelope.
export function runProblems(result) {
  if (result.code !== 0) {
    return [`faux run exited ${result.code}: ${result.stderr.trim()}`];
  }
  const line = result.stdout.trim().split('\n').at(-1) ?? '';
  let envelope;
  try {
    envelope = JSON.parse(line);
  } catch {
    return [`faux run printed no JSON envelope: ${JSON.stringify(line)}`];
  }
  if (envelope?.ok !== true || envelope?.status !== 'completed') {
    return [
      `faux run envelope: ok ${JSON.stringify(envelope?.ok)}, status ${JSON.stringify(envelope?.status)}, want true and "completed"`,
    ];
  }
  return [];
}

// The registry document for the staged package: its one version, flagged as
// carrying a shrinkwrap, with the tarball served by the loopback registry.
export function packument(manifest, tarball, registryUrl) {
  const { name, version } = manifest;
  return {
    _id: name,
    name,
    'dist-tags': { latest: version },
    versions: {
      [version]: {
        ...manifest,
        _id: `${name}@${version}`,
        _hasShrinkwrap: true,
        dist: {
          tarball: `${registryUrl}/${name}/-/${name}-${version}.tgz`,
          integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
          shasum: createHash('sha1').update(tarball).digest('hex'),
        },
      },
    },
  };
}

// Every production package of the shrinkwrap at its locked version.
// `versionAt(path)` reads the installed version for a shrinkwrap path, or
// undefined when nothing is installed there.
export function installedTreeProblems(shrinkwrap, versionAt) {
  const problems = [];
  for (const [path, entry] of Object.entries(shrinkwrap.packages ?? {})) {
    if (path === '') continue;
    const installed = versionAt(path);
    if (installed === undefined) {
      problems.push(`${path}: not installed (locked at ${entry.version})`);
    } else if (installed !== entry.version) {
      problems.push(
        `${path}: installed ${installed}, locked at ${entry.version}`,
      );
    }
  }
  return problems;
}

export function footprintProblems(bytes) {
  if (bytes <= INSTALL_BUDGET_BYTES) return [];
  return [
    `the registry install is ${bytes} bytes, above the ${INSTALL_BUDGET_BYTES}-byte budget`,
  ];
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

// The bytes of every file under `dir`, links not followed.
function treeBytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += treeBytes(path);
    else if (entry.isFile()) total += lstatSync(path).size;
  }
  return total;
}

// A child environment with nothing from this machine: no npm configuration,
// no provider keys, no KUBIC_* overrides.
function cleanEnv(home) {
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    TMPDIR: process.env.TMPDIR ?? '',
  };
}

function runChild(command, args, { cwd, env }) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 300_000,
  });
  if (result.error !== undefined) throw result.error;
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// The same, without blocking: the loopback registry answers from this
// process while npm runs.
function runChildAsync(command, args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function npmInstallProblems(result, what) {
  return result.code === 0
    ? []
    : [`${what} failed (exit ${result.code}): ${result.stderr.trim()}`];
}

function tarballProblems({ manifest, tarball, scratch }) {
  const home = join(scratch, 'home');
  const prefix = join(scratch, 'tarball-install');
  const work = join(scratch, 'work');
  for (const dir of [home, prefix, work]) mkdirSync(dir, { recursive: true });
  const env = cleanEnv(home);
  const install = runChild(
    'npm',
    [
      'install',
      '--prefix',
      prefix,
      '--cache',
      join(scratch, 'tarball-cache'),
      '--no-audit',
      '--no-fund',
      tarball,
    ],
    { cwd: work, env },
  );
  const problems = npmInstallProblems(install, 'tarball install');
  if (problems.length > 0) return problems;
  const bin = join(prefix, 'node_modules', '.bin', 'kubic');
  const kubic = (args, extraEnv = {}) =>
    runChild(bin, args, { cwd: work, env: { ...env, ...extraEnv } });
  problems.push(...versionProblems(kubic(['--version']), manifest.version));
  const help = kubic(['--help']);
  if (help.code !== 0) problems.push(`kubic --help exited ${help.code}`);
  problems.push(...doctorProblems(kubic(['doctor'])));
  problems.push(
    ...runProblems(
      kubic(['run', '-p', 'hello', '--json'], { KUBIC_PROVIDER: 'faux' }),
    ),
  );
  return problems;
}

// A registry on 127.0.0.1 that serves the staged package and forwards
// everything else upstream.
function loopbackRegistry({ manifest, tarball }) {
  const tarballPath = `/${manifest.name}/-/${manifest.name}-${manifest.version}.tgz`;
  let url = '';
  const server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? '/').split('?')[0];
      if (path === `/${manifest.name}`) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(packument(manifest, tarball, url)));
        return;
      }
      if (path === tarballPath) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(tarball);
        return;
      }
      const upstream = await fetch(`${UPSTREAM_REGISTRY}${req.url}`, {
        headers: { accept: req.headers.accept ?? 'application/json' },
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, {
        'content-type':
          upstream.headers.get('content-type') ?? 'application/octet-stream',
      });
      res.end(body);
    } catch (error) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(String(error));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      url = `http://127.0.0.1:${server.address().port}`;
      resolve({ url, close: () => server.close() });
    });
  });
}

async function registryProblems({ manifest, tarball, shrinkwrap, scratch }) {
  const home = join(scratch, 'registry-home');
  const prefix = join(scratch, 'registry-install');
  for (const dir of [home, prefix]) mkdirSync(dir, { recursive: true });
  const registry = await loopbackRegistry({ manifest, tarball });
  try {
    const install = await runChildAsync(
      'npm',
      [
        'install',
        '--prefix',
        prefix,
        '--registry',
        `${registry.url}/`,
        '--cache',
        join(scratch, 'registry-cache'),
        '--engine-strict',
        '--no-audit',
        '--no-fund',
        `${manifest.name}@${manifest.version}`,
      ],
      { cwd: prefix, env: cleanEnv(home) },
    );
    const problems = npmInstallProblems(install, 'registry install');
    if (problems.length > 0) return problems;
    // Node resolves a dependency of kubic from kubic's own node_modules
    // first, then from the prefix's.
    const roots = [join(prefix, 'node_modules', manifest.name), prefix];
    const versionAt = (path) => {
      for (const root of roots) {
        try {
          return readJson(join(root, path, 'package.json')).version;
        } catch {
          // not installed under this root
        }
      }
      return undefined;
    };
    const bytes = treeBytes(join(prefix, 'node_modules'));
    console.log(`pack contract: the registry install is ${bytes} bytes`);
    return [
      ...installedTreeProblems(shrinkwrap, versionAt),
      ...footprintProblems(bytes),
    ];
  } finally {
    registry.close();
  }
}

async function main(argv) {
  const releaseDir = join(REPO_ROOT, RELEASE_DIR);
  const manifest = readJson(join(releaseDir, 'package.json'));
  const tarballFile = join(
    releaseDir,
    `${manifest.name}-${manifest.version}.tgz`,
  );
  const tarball = readFileSync(tarballFile);
  const shrinkwrap = readJson(join(releaseDir, 'npm-shrinkwrap.json'));
  const listing = execFileSync('tar', ['-tzf', tarballFile], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter((entry) => entry !== '');
  const problems = fileListProblems(listing);
  const scratch = mkdtempSync(join(tmpdir(), 'kubic-pack-contract-'));
  try {
    problems.push(
      ...tarballProblems({ manifest, tarball: tarballFile, scratch }),
    );
    if (!argv.includes('--skip-registry')) {
      problems.push(
        ...(await registryProblems({ manifest, tarball, shrinkwrap, scratch })),
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const files = listing.filter((entry) => !entry.endsWith('/')).length;
  console.log(
    `pack contract: ${manifest.name}@${manifest.version}, ${files} files, ${statSync(tarballFile).size} bytes packed`,
  );
  for (const problem of problems) console.error(`pack contract: ${problem}`);
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
