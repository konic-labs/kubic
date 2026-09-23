// Facet layout boundaries (issue #37; §32). A bundle splits into
// contract/host/worker/tui facets. Two splits are structural, not advisory:
// a tui facet never imports host, and a worker facet never imports pi-tui.
// This pure validator backs the rule; scripts/dep-lint.mjs enforces the
// same rule statically on the new package.

import type { FacetKind } from './contract.js';

export class FacetBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FacetBoundaryError';
  }
}

function mentionsHost(spec: string): boolean {
  // Casefolded: filesystems and bundlers may resolve './Host.js' to the host
  // facet, so compare lowercase. NOTE (dynamic-import() static-analysis
  // limitation): this validator only sees static specifier strings handed to
  // it; a dynamic import() with a computed (non-literal) expression cannot be
  // statically analyzed, so runtime loaders must still refuse unowned targets
  // via isOwnedPath/resolve — this check is defense-in-depth, not a sandbox.
  const lower = spec.toLowerCase();
  return (
    lower === '@kubic/host' ||
    lower.startsWith('@kubic/host/') ||
    /(^|\/)host(\/|$|\.|-)/.test(lower)
  );
}

function mentionsPiTui(spec: string): boolean {
  return spec.toLowerCase().includes('pi-tui');
}

export function assertFacetImports(facet: FacetKind, imports: string[]): void {
  if (facet === 'tui') {
    for (const spec of imports) {
      if (mentionsHost(spec)) {
        throw new FacetBoundaryError(
          `tui facet must never import host (found ${JSON.stringify(spec)})`,
        );
      }
    }
  }
  if (facet === 'worker') {
    for (const spec of imports) {
      if (mentionsPiTui(spec)) {
        throw new FacetBoundaryError(
          `worker facet must never import pi-tui (found ${JSON.stringify(spec)})`,
        );
      }
    }
  }
}
