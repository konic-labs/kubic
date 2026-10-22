// The release workflow's checks. Before anything is built, the pushed tag must
// name the root manifest's version; after the publish, the registry must
// serve that version with its shrinkwrap, its provenance attestation and the
// dist-tag it went out under. npm can take a minute to make a version live,
// so the registry check asks again for a few minutes before it fails.
//
// Usage: node scripts/release-check.mjs tag <tag>
//        node scripts/release-check.mjs registry <version> <dist-tag>
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = 'kubic';
const ATTEMPTS = 20;
const PAUSE_MS = 15_000;

/** What is wrong with releasing `tag` from a manifest at `version`. */
export function tagProblems(tag, version) {
  return tag === `v${version}`
    ? []
    : [
        `tag '${tag}' does not name the manifest version ${version} (v${version})`,
      ];
}

/**
 * What is wrong with `meta` (the `npm view <name>@<version> --json` object,
 * or undefined when the registry has none) as the published `version`.
 */
export function registryProblems(meta, version, distTag) {
  const spec = `${PACKAGE}@${version}`;
  if (meta?.version !== version) return [`${spec} is not on the registry`];
  const problems = [];
  if (meta._hasShrinkwrap !== true) {
    problems.push(`${spec} has no npm-shrinkwrap.json`);
  }
  const predicate = meta.dist?.attestations?.provenance?.predicateType;
  if (
    typeof predicate !== 'string' ||
    !predicate.startsWith('https://slsa.dev/provenance/')
  ) {
    problems.push(`${spec} carries no provenance attestation`);
  }
  const tagged = meta['dist-tags']?.[distTag];
  if (tagged !== version) {
    problems.push(
      `dist-tag '${distTag}' is ${tagged ?? 'unset'}, not ${version}`,
    );
  }
  return problems;
}

function view(version) {
  try {
    const out = execFileSync(
      'npm',
      ['view', `${PACKAGE}@${version}`, '--json'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    return out.trim() === '' ? undefined : JSON.parse(out);
  } catch {
    return undefined;
  }
}

async function checkRegistry(version, distTag) {
  let problems = [];
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    problems = registryProblems(view(version), version, distTag);
    if (problems.length === 0) return problems;
    if (attempt < ATTEMPTS) await sleep(PAUSE_MS);
  }
  return problems;
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  let problems;
  if (command === 'tag' && rest.length === 1) {
    const { version } = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
    );
    problems = tagProblems(rest[0], version);
  } else if (command === 'registry' && rest.length === 2) {
    problems = await checkRegistry(rest[0], rest[1]);
  } else {
    console.error(
      'usage: release-check.mjs tag <tag> | registry <version> <dist-tag>',
    );
    process.exit(2);
  }
  for (const problem of problems) console.error(`release-check: ${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log(`release-check: ${command} ok`);
}
