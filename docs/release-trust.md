# Release trust

> What a Kubic release carries so it can be verified, and how.

## Verifying a package

Every version on npm is signed by the registry. In a project that depends on
Kubic (`npm install kubic`), `npm audit signatures` checks the signature of
every installed package, and the provenance attestation of each version that
has one.

## What a release attaches

A release is published by the [release workflow](contributing.md#releasing)
from a version tag, never by hand. The GitHub Release for the tag carries:

- `kubic-<version>.tgz`, the exact tarball on npm;
- `kubic-<version>.cdx.json`, its SBOM;
- `SHA256SUMS`, the checksums of both;
- `SHA256SUMS.sig`, the signature of `SHA256SUMS` by the release key.

The release key's public half is [`kubic-release.pub`](kubic-release.pub) in
this repository.

## Provenance

The staged package's manifest sets `publishConfig.provenance`, so a publish
from the release workflow attaches npm's provenance attestation: the package
names the source commit and the workflow that built it. Check an installed
package with `npm audit signatures`.

## The SBOM

`npm run release:stage` writes `release/kubic-<version>.cdx.json`, the
CycloneDX SBOM of the shipped production tree; the staging fails when it
misses a package the shrinkwrap pins.

## Checksums and signature

`npm run release:sign` writes `release/SHA256SUMS` — the SHA-256 of the
packed tarball and the SBOM — and, with `-- --key <private.pem>` (an Ed25519
key), `release/SHA256SUMS.sig`, the base64 signature of that file: the same
detached form Kubic checks for a [signed managed
policy](cli/enterprise.md#signed-managed-files). Verify a downloaded GitHub
Release with the public key, from a checkout of this repository:

```sh
node scripts/release-sign.mjs --verify --pub docs/kubic-release.pub --dir <download dir>
# or with standard tools, in the download directory:
sha256sum --check SHA256SUMS
openssl pkeyutl -verify -pubin -inkey kubic-release.pub -rawin \
  -in SHA256SUMS -sigfile <(base64 --decode SHA256SUMS.sig)
```

## Code scanning

`.github/workflows/codeql.yml` runs CodeQL on every push and pull request
once the repository is public; on a private repository it does nothing.
