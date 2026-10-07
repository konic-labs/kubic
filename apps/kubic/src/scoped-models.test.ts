// The `/scoped-models` report: the role's resolved
// allowed set as one transcript line.
import { describe, expect, it } from 'vitest';
import { formatScopedModels } from './scoped-models.js';

describe('formatScopedModels', () => {
  it('names the set with per-entry thinking', () => {
    expect(
      formatScopedModels('reviewer', [
        { id: 'local/*' },
        { id: 'acme/big', thinking: 'high' },
      ]),
    ).toBe(
      "scoped-models: role 'reviewer' allows local/*, acme/big (thinking high) only",
    );
  });

  it('reports an unconstrained role and a roleless lane distinctly', () => {
    expect(formatScopedModels('reviewer', undefined)).toBe(
      "scoped-models: role 'reviewer' allows every registered model (no set configured)",
    );
    expect(formatScopedModels('reviewer', [])).toBe(
      "scoped-models: role 'reviewer' allows every registered model (no set configured)",
    );
    expect(formatScopedModels(undefined, undefined)).toBe(
      'scoped-models: no role on this lane — every registered model is allowed',
    );
  });
});
