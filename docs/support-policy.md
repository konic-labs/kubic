# Support policy

> Which versions and platforms Kubic supports, and how fixes ship.

## Installing and updating

Kubic is the `kubic` package on npm:

```sh
npm install -g kubic          # install
npm install -g kubic@latest   # update to the newest release
```

`kubic --version` names the installed version.

## Supported versions

Kubic is pre-1.0: a minor release may change behaviour, and each change is
described in its release notes. Fixes, security fixes included, land in the
newest release; older releases are not patched.

## Platforms

| Platform | Support |
| --- | --- |
| Node.js | The lowest supported line is 22.19 (`engines`), tested in CI together with the newest LTS line. A Node line is supported until its end of life. |
| Linux | Supported; tested in CI. The bash sandbox needs bubblewrap. |
| macOS | Supported; the bash sandbox uses Seatbelt. |
| Windows | Supported through a POSIX bash for the bash tool (Git Bash, else WSL); a smoke test runs in CI. No bash sandbox. |

## Security fixes

A security fix ships in a new release as soon as it is ready, with an
advisory naming the affected versions and the fix. Report a vulnerability
privately to the maintainers, never in a public issue.

## What a release carries

Every version on npm is signed by the registry, and a version published from
CI also carries a provenance attestation naming its source commit and
workflow; `npm audit signatures` checks both. The release tooling also writes
each package's CycloneDX SBOM and the SHA-256 checksums of its artifacts,
which it signs with an Ed25519 key when given one — see
[release trust](release-trust.md).
