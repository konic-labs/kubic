// The `[approvals]` a lane runs under: the policy (route, autoApprove, the
// pending bound, justification) with where its route came from, and what a
// run without a terminal reads (the broker, the pre-approval key).

import { validatePolicy } from '../approvals/index.js';
import type { ApprovalsConfig, KubicConfig } from './config.js';
import { ConfigError } from './errors.js';
import { headlessApprovalsOf } from './headless-approvals.js';
import type { LoadedLayers } from './runtime-layers.js';
import type { ConfigValueSource, RuntimeApprovals } from './runtime-types.js';
import { configKey } from './schema.js';

const DEFAULT_APPROVALS_ROUTE = configKey('approvals', 'route').default as
  | 'ask-user'
  | 'deny';

export function runtimeApprovalsOf(
  config: KubicConfig,
  loaded: LoadedLayers,
  routeOverride: 'ask-user' | 'deny' | undefined,
): RuntimeApprovals {
  return {
    ...approvalsFrom(config, loaded.sources, routeOverride),
    ...headlessApprovalsOf(
      loaded.perLayer,
      config.approvals ?? {},
      loaded.paths.project,
    ),
  };
}

function approvalsFrom(
  config: KubicConfig,
  sources: Record<string, ConfigValueSource>,
  routeOverride: 'ask-user' | 'deny' | undefined,
): RuntimeApprovals {
  const approvals: ApprovalsConfig = config.approvals ?? {};
  // The host has exactly one store placement — per session
  // (<session>/approvals.json). A shared, cross-session store is not
  // implemented, so `sessionScoped = false` is refused by name rather than
  // printed as an effective policy that no lane enforces.
  if (approvals.sessionScoped === false) {
    throw new ConfigError(
      "'approvals': 'sessionScoped = false' is not supported — approval decisions are always stored per session (<session>/approvals.json); remove the key or set it to true",
    );
  }
  const route = routeOverride ?? approvals.route ?? DEFAULT_APPROVALS_ROUTE;
  const source: ConfigValueSource =
    routeOverride !== undefined
      ? 'env'
      : (sources['approvals.route'] ?? 'defaults');
  return {
    policy: validatePolicy({
      route,
      autoApprove: approvals.autoApprove ?? [],
      ...(approvals.maxPendingMs === undefined
        ? {}
        : { maxPendingMs: approvals.maxPendingMs }),
      ...(approvals.sessionScoped === undefined
        ? {}
        : { sessionScoped: approvals.sessionScoped }),
      ...(approvals.requireJustification === undefined
        ? {}
        : { requireJustification: approvals.requireJustification }),
    }),
    source,
  };
}
