// Extension startup options (issue #283): the opt-in solo `--budget`
// limits ride into the bundle build — carried when given, absent otherwise.
import { describe, expect, it } from 'vitest';
import { prodExtensionStartupOptions } from './extension-startup.js';

describe('prodExtensionStartupOptions (issue #283)', () => {
  it('carries the parsed budget limits into the bundle options', () => {
    const options = prodExtensionStartupOptions('/repo', {
      maxToolCalls: 1,
      maxCostUsd: 0.5,
    });
    expect(options.limits).toEqual({ maxToolCalls: 1, maxCostUsd: 0.5 });
  });

  it('leaves limits out when no budget was passed (never defaulted)', () => {
    const options = prodExtensionStartupOptions('/repo');
    expect('limits' in options).toBe(false);
  });
});
