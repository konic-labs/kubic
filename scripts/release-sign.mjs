// The release artifacts' checksums and their signature: after
// `npm run release:stage`, `release/SHA256SUMS` lists the SHA-256 of the
// packed tarball and the SBOM, and with a key `release/SHA256SUMS.sig` holds
// the base64 Ed25519 signature of that file — the same detached form Kubic
// checks for a managed policy, verifiable with `--verify` or OpenSSL.
//
// Usage: node scripts/release-sign.mjs [--key <private.pem>]
//        node scripts/release-sign.mjs --verify --pub <public.pem> [--dir <dir>]
// `--dir` verifies files downloaded elsewhere, such as a GitHub Release.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SUMS = 'SHA256SUMS';

/** The artifacts a release carries: the tarball and the SBOM. */
export function releaseArtifacts(names) {
  return names
    .filter((name) => name.endsWith('.tgz') || name.endsWith('.cdx.json'))
    .sort();
}

/** `sha256  name` lines, as `sha256sum` writes and checks them. */
export function checksums(dir, names) {
  return names
    .map((name) => {
      const digest = createHash('sha256')
        .update(readFileSync(join(dir, name)))
        .digest('hex');
      return `${digest}  ${name}\n`;
    })
    .join('');
}

export function signText(text, privatePem) {
  return sign(
    null,
    Buffer.from(text, 'utf8'),
    createPrivateKey(privatePem),
  ).toString('base64');
}

/** What is wrong with the release in `dir`: an empty list verifies. */
export function verifyRelease(dir, publicPem) {
  if (!existsSync(join(dir, SUMS))) return [`${SUMS} is missing`];
  const text = readFileSync(join(dir, SUMS), 'utf8');
  const problems = [];
  if (publicPem !== undefined) {
    const signature = existsSync(join(dir, `${SUMS}.sig`))
      ? readFileSync(join(dir, `${SUMS}.sig`), 'utf8').trim()
      : undefined;
    if (signature === undefined) problems.push(`${SUMS}.sig is missing`);
    else if (
      !verify(
        null,
        Buffer.from(text, 'utf8'),
        createPublicKey(publicPem),
        Buffer.from(signature, 'base64'),
      )
    ) {
      problems.push(`${SUMS} does not match its signature`);
    }
  }
  for (const line of text.split('\n').filter(Boolean)) {
    const [digest, name] = line.split(/ {2}/);
    if (!existsSync(join(dir, name))) {
      problems.push(`${name} is missing`);
      continue;
    }
    const actual = createHash('sha256')
      .update(readFileSync(join(dir, name)))
      .digest('hex');
    if (actual !== digest) problems.push(`${name} does not match its checksum`);
  }
  return problems;
}

function flag(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

if (import.meta.main) {
  const dir = flag('--dir') ?? join(REPO_ROOT, 'release');
  if (process.argv.includes('--verify')) {
    const pub = flag('--pub');
    const problems = verifyRelease(
      dir,
      pub === undefined ? undefined : readFileSync(pub, 'utf8'),
    );
    for (const problem of problems) console.error(`release-sign: ${problem}`);
    if (problems.length > 0) process.exit(1);
    console.log(
      `verified ${join(dir, SUMS)}${pub === undefined ? ' (checksums only)' : ' and its signature'}`,
    );
  } else {
    const names = releaseArtifacts(readdirSync(dir));
    if (names.length === 0) {
      console.error(
        'release-sign: no artifact in release/ — run npm run release:stage first',
      );
      process.exit(1);
    }
    const text = checksums(dir, names);
    writeFileSync(join(dir, SUMS), text);
    const key = flag('--key');
    if (key !== undefined) {
      writeFileSync(
        join(dir, `${SUMS}.sig`),
        `${signText(text, readFileSync(key, 'utf8'))}\n`,
      );
    }
    console.log(
      `wrote ${join(dir, SUMS)}${key === undefined ? '' : ' and its signature'} for ${names.join(', ')}`,
    );
  }
}
