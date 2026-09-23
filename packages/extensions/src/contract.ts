// Extension contracts (issue #37; §31–§32). Pure types + refusal error.
// v1 ships first-party bundles only; third-party arrives with Phase-4
// isolated-vm (§83). There is deliberately no bypass flag anywhere.

export const FACET_KINDS = ['contract', 'host', 'worker', 'tui'] as const;

export type FacetKind = (typeof FACET_KINDS)[number];

export interface ExtensionManifest {
  name: string;
  publisher: string;
  version: string;
  sourcePath?: string;
  facets: FacetKind[];
}

export class ExtensionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtensionRefusedError';
  }
}
