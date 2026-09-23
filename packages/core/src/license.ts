// Kubic license identity (issue #59; §75.1): single source of truth for
// the MIT license id. `kubic --version` and the `license:kubic` doctor
// check report these constants, so the CLI can never drift from what
// LICENSE and the package.json license fields declare.

export const KUBIC_LICENSE = 'MIT' as const;

export const KUBIC_LICENSE_FILE = 'LICENSE' as const;

export function formatVersionLine(version: string): string {
  return `kubic ${version} (license: ${KUBIC_LICENSE})`;
}

export function formatLicenseDetail(): string {
  return `${KUBIC_LICENSE} (see ${KUBIC_LICENSE_FILE})`;
}
