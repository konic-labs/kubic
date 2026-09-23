// Facet layout boundaries (issue #37; §32). RED first.
import { describe, expect, it } from 'vitest';
import { assertFacetImports, FacetBoundaryError } from './facets.js';

describe('facet boundaries (issue #37, §32)', () => {
  it('rejects a tui facet that imports host', () => {
    expect(() =>
      assertFacetImports('tui', ['@kubic/host', '@kubic/core']),
    ).toThrow(FacetBoundaryError);
    expect(() => assertFacetImports('tui', ['../host/budget.js'])).toThrow(
      /tui.*host/i,
    );
  });

  it('rejects a worker facet that imports pi-tui', () => {
    expect(() =>
      assertFacetImports('worker', ['@earendil-works/pi-tui']),
    ).toThrow(FacetBoundaryError);
  });

  it('accepts clean splits: tui on core, worker without pi-tui', () => {
    expect(() => assertFacetImports('tui', ['@kubic/core'])).not.toThrow();
    expect(() =>
      assertFacetImports('worker', ['@kubic/agents', '@kubic/core']),
    ).not.toThrow();
  });

  it('casefolds: ./Host.js is refused for a tui facet', () => {
    expect(() => assertFacetImports('tui', ['./Host.js'])).toThrow(
      FacetBoundaryError,
    );
  });
});
