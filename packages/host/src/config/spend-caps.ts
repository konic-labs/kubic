// The spend caps a run is held to: `[policy] max_run_cost_usd` and
// `max_daily_cost_usd`. Unlike the other policy keys, which the highest layer
// owns, every layer may set a cap and the lowest one wins — a user or a
// project can tighten an organization's cap, never loosen it.

import type { ConfigLayer, KubicConfig } from './config.js';

interface SpendCap {
  readonly usd: number;
  // The layer whose value won.
  readonly layer: ConfigLayer;
}

export interface SpendCaps {
  readonly run?: SpendCap;
  readonly daily?: SpendCap;
}

function lowest(
  perLayer: ReadonlyArray<{ layer: ConfigLayer; config: KubicConfig }>,
  read: (config: KubicConfig) => number | undefined,
): SpendCap | undefined {
  let found: SpendCap | undefined;
  for (const { layer, config } of perLayer) {
    const usd = read(config);
    if (usd === undefined) continue;
    if (found === undefined || usd < found.usd) found = { usd, layer };
  }
  return found;
}

/** The caps in force over the loaded layers, highest first. */
export function spendCapsOf(
  perLayer: ReadonlyArray<{ layer: ConfigLayer; config: KubicConfig }>,
): SpendCaps {
  const run = lowest(perLayer, (config) => config.policy?.maxRunCostUsd);
  const daily = lowest(perLayer, (config) => config.policy?.maxDailyCostUsd);
  return {
    ...(run === undefined ? {} : { run }),
    ...(daily === undefined ? {} : { daily }),
  };
}
