// Region declarations come from the managed config only, the enterprise
// layer's first; any other layer declaring one is refused by name.
import { describe, expect, it } from 'vitest';
import type { ConfigLayer, KubicConfig } from './config.js';
import { providerRegionsOf } from './provider-regions.js';

function layer(
  name: ConfigLayer,
  regions: Record<string, string>,
): { layer: ConfigLayer; config: KubicConfig } {
  return {
    layer: name,
    config: {
      providers: Object.fromEntries(
        Object.entries(regions).map(([id, region]) => [id, { region }]),
      ),
    },
  };
}

describe('providerRegionsOf', () => {
  it('reads the enterprise and product declarations, the enterprise first', () => {
    expect(
      providerRegionsOf([
        layer('product', { gateway: 'us-east-1', azure: 'westeurope' }),
        layer('enterprise', { gateway: 'eu-west-1' }),
      ]),
    ).toEqual({ gateway: 'eu-west-1', azure: 'westeurope' });
  });

  it('refuses a declaration from any other layer', () => {
    expect(() =>
      providerRegionsOf([layer('global', { anthropic: 'eu-west-1' })]),
    ).toThrow(
      "'[providers.anthropic] region' is read from the enterprise and product layers only; the global layer cannot declare it",
    );
  });
});
