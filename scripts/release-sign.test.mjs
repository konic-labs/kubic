// The release checksums and their signature: a signed release verifies, and
// a changed artifact or a signature from another key does not.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  checksums,
  releaseArtifacts,
  SUMS,
  signText,
  verifyRelease,
} from './release-sign.mjs';

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function keys() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privatePem: pair.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString(),
    publicPem: pair.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString(),
  };
}

function signedRelease(privatePem) {
  const dir = mkdtempSync(join(tmpdir(), 'release-sign-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'kubic-0.1.2.tgz'), 'tarball bytes');
  writeFileSync(join(dir, 'kubic-0.1.2.cdx.json'), '{"bomFormat":"CycloneDX"}');
  writeFileSync(join(dir, 'package.json'), '{}');
  const names = releaseArtifacts([
    'package.json',
    'kubic-0.1.2.tgz',
    'kubic-0.1.2.cdx.json',
  ]);
  const text = checksums(dir, names);
  writeFileSync(join(dir, SUMS), text);
  writeFileSync(join(dir, `${SUMS}.sig`), signText(text, privatePem));
  return dir;
}

describe('release checksums and signature', () => {
  it('lists the tarball and the SBOM, and a signed release verifies', () => {
    assert.deepEqual(
      releaseArtifacts(['package.json', 'b.tgz', 'a.cdx.json']),
      ['a.cdx.json', 'b.tgz'],
    );
    const { privatePem, publicPem } = keys();
    assert.deepEqual(verifyRelease(signedRelease(privatePem), publicPem), []);
  });

  it('names a changed artifact and a signature from another key', () => {
    const { privatePem, publicPem } = keys();
    const dir = signedRelease(privatePem);
    writeFileSync(join(dir, 'kubic-0.1.2.tgz'), 'swapped tarball');
    assert.deepEqual(verifyRelease(dir, publicPem), [
      'kubic-0.1.2.tgz does not match its checksum',
    ]);
    assert.deepEqual(
      verifyRelease(signedRelease(privatePem), keys().publicPem),
      [`${SUMS} does not match its signature`],
    );
  });
});
