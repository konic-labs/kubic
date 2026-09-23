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

// Facet boundary hardening (issue #69): near-miss names stay allowed and
// every refusal pins its exact message.
describe('facet boundary hardening (issue #69)', () => {
  it('allows near-miss host names for a tui facet', () => {
    expect(() =>
      assertFacetImports('tui', ['@kubic/hostile', 'services/hostile.js']),
    ).not.toThrow();
    expect(() => assertFacetImports('tui', ['ghost/hosts.js'])).not.toThrow();
  });

  it('pins the exact refusal messages', () => {
    try {
      assertFacetImports('tui', ['@kubic/host']);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).name).toBe('FacetBoundaryError');
      expect((error as Error).message).toMatch(
        /tui facet must never import host/,
      );
    }
    try {
      assertFacetImports('worker', ['@earendil-works/pi-tui']);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).name).toBe('FacetBoundaryError');
      expect((error as Error).message).toMatch(
        /worker facet must never import pi-tui/,
      );
    }
  });

  it('never restricts contract facets or cross-non-banned imports', () => {
    expect(() => assertFacetImports('contract', ['@kubic/host'])).not.toThrow();
    expect(() =>
      assertFacetImports('contract', ['@earendil-works/pi-tui']),
    ).not.toThrow();
    expect(() => assertFacetImports('host', ['@kubic/host'])).not.toThrow();
    expect(() =>
      assertFacetImports('worker', ['@kubic/host', '@kubic/core']),
    ).not.toThrow();
    expect(() => assertFacetImports('tui', [])).not.toThrow();
  });
});
