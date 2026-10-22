// Where a provider's endpoint runs, for `[policy] allowed_regions`: read
// from the environment for Amazon Bedrock (the AWS region) and Vertex AI
// (`GOOGLE_CLOUD_LOCATION`), `local` for the testing provider and a
// models.json provider on this machine, and the managed config's
// declaration (`[providers.<id>] region`) for any other. A model whose region
// is unknown or unlisted is refused before any request.

import type { EffectivePolicy } from '../policy/index.js';
import { awsRegionOf } from './aws-region.js';
import { FAUX_PROVIDER_ID } from './faux-provider.js';

type Env = Readonly<Record<string, string | undefined>>;

export interface RegionContext {
  readonly env: Env;
  readonly home: string;
  // `[providers.<id>] region` from the managed config.
  readonly declared: Readonly<Record<string, string>>;
  // A registered provider's endpoint, to tell one on this machine.
  readonly baseUrlOf?: (provider: string) => string | undefined;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function onThisMachine(baseUrl: string): boolean {
  try {
    return LOOPBACK.has(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * The region `provider` runs in, or undefined when it is not known.
 * @internal
 */
export function providerRegion(
  provider: string,
  ctx: RegionContext,
): string | undefined {
  if (provider === 'amazon-bedrock') return awsRegionOf(ctx.env, ctx.home);
  if (provider === 'google-vertex') {
    const location = ctx.env.GOOGLE_CLOUD_LOCATION;
    return location === undefined || location === '' ? undefined : location;
  }
  if (provider === FAUX_PROVIDER_ID) return 'local';
  const declared = ctx.declared[provider];
  if (declared !== undefined) return declared;
  const baseUrl = ctx.baseUrlOf?.(provider);
  return baseUrl !== undefined && onThisMachine(baseUrl) ? 'local' : undefined;
}

/**
 * A region id or a `*` glob (case-insensitive) against a region.
 * @internal
 */
export function regionMatches(pattern: string, region: string): boolean {
  const body = pattern
    .toLowerCase()
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`).test(region.toLowerCase());
}

/**
 * Why `provider` is refused under `[policy] allowed_regions`; undefined when
 * it is allowed or no region gate is configured.
 */
export function regionRefusal(
  policy: EffectivePolicy | undefined,
  provider: string,
  ctx: RegionContext,
): string | undefined {
  const allowed = policy?.models.regions;
  if (allowed === undefined) return undefined;
  const region = providerRegion(provider, ctx);
  const list = allowed.join(', ');
  if (region === undefined) {
    return `provider '${provider}' has no known region, and [policy] allowed_regions allows only ${list} (the managed config declares it with [providers.${provider}] region)`;
  }
  return allowed.some((pattern) => regionMatches(pattern, region))
    ? undefined
    : `provider '${provider}' runs in ${region}, outside [policy] allowed_regions (${list})`;
}
