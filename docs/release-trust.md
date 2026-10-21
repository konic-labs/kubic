# Release trust

What a Kubic release carries so it can be verified, and how.

## Provenance

The staged package's manifest sets `publishConfig.provenance`, so a publish
from CI attaches npm's provenance attestation: the package names the source
commit and the workflow that built it. Check an installed package with
`npm audit signatures`.

## The SBOM

`npm run release:stage` writes `release/kubic-<version>.cdx.json`, the
CycloneDX SBOM of the shipped production tree; the staging fails when it
misses a package the shrinkwrap pins.

## Checksums and signature

`npm run release:sign` writes `release/SHA256SUMS` — the SHA-256 of the
packed tarball and the SBOM — and, with `-- --key <private.pem>` (an Ed25519
key), `release/SHA256SUMS.sig`, the base64 signature of that file: the same
detached form Kubic checks for a [signed managed
policy](cli/enterprise.md#signed-managed-files). Verify a release with the
published public key:

```sh
node scripts/release-sign.mjs --verify --pub kubic-release.pub
# or with standard tools:
sha256sum --check SHA256SUMS
openssl pkeyutl -verify -pubin -inkey kubic-release.pub -rawin \
  -in SHA256SUMS -sigfile <(base64 --decode SHA256SUMS.sig)
```

## Code scanning

`.github/workflows/codeql.yml` runs CodeQL on every push and pull request
once the repository is public; on a private repository it does nothing.
