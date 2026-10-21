// The regions the organization declares for its providers
// (`[providers.<id>] region`), for the providers whose region Kubic cannot
// read from their environment. A region unlocks `[policy] allowed_regions`,
// so only the enterprise and product layers may declare one — the
// enterprise layer's wins — and any other layer declaring one is refused by
// name.

import type { ConfigLayer, KubicConfig } from './config.js';
import { ConfigError } from './errors.js';

const DECLARING_LAYERS: readonly ConfigLayer[] = ['enterprise', 'product'];

export function providerRegionsOf(
  perLayer: ReadonlyArray<{ layer: ConfigLayer; config: KubicConfig }>,
  projectPath?: string,
): Record<string, string> {
  for (const { layer, config } of perLayer) {
    if (DECLARING_LAYERS.includes(layer)) continue;
    const declared = Object.entries(config.providers ?? {}).find(
      ([, facts]) => facts.region !== undefined,
    );
    if (declared !== undefined) {
      throw new ConfigError(
        `'[providers.${declared[0]}] region' is read from the enterprise and product layers only; the ${layer} layer${layer === 'project' && projectPath !== undefined ? ` (${projectPath})` : ''} cannot declare it`,
      );
    }
  }
  const regions: Record<string, string> = {};
  for (const layer of DECLARING_LAYERS) {
    for (const entry of perLayer.filter((each) => each.layer === layer)) {
      for (const [provider, facts] of Object.entries(
        entry.config.providers ?? {},
      )) {
        if (facts.region !== undefined && regions[provider] === undefined) {
          regions[provider] = facts.region;
        }
      }
    }
  }
  return regions;
}
