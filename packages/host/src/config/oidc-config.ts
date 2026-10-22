// `[oidc]`, validated: which token source, and at least one cloud to use it
// for. A repository must not choose where the job's token goes, so only the
// enterprise, product and global layers may set it — a project config
// setting any key is refused by name.

import type { RuntimeOidc } from '../credentials/index.js';
import type { ConfigLayer, KubicConfig } from './config.js';
import { ConfigError } from './errors.js';

const READ_FROM: ReadonlySet<ConfigLayer> = new Set([
  'enterprise',
  'product',
  'global',
]);

export function oidcOf(
  perLayer: ReadonlyArray<{ layer: ConfigLayer; config: KubicConfig }>,
  merged: KubicConfig,
  projectPath?: string,
): RuntimeOidc | undefined {
  for (const { layer, config } of perLayer) {
    const key = Object.keys(config.oidc ?? {})[0];
    if (key !== undefined && !READ_FROM.has(layer)) {
      throw new ConfigError(
        `'oidc.${key}' is read from the enterprise, product and global layers only; the ${layer} layer${layer === 'project' && projectPath !== undefined ? ` (${projectPath})` : ''} cannot set it`,
      );
    }
  }
  const oidc = merged.oidc;
  if (oidc === undefined || Object.keys(oidc).length === 0) return undefined;
  if (oidc.provider !== 'github' && oidc.provider !== 'env') {
    throw new ConfigError(
      `'oidc.provider' must be "github" or "env" (got ${JSON.stringify(oidc.provider)})`,
    );
  }
  if (oidc.provider === 'env' && oidc.tokenEnv === undefined) {
    throw new ConfigError(
      "'oidc.provider = \"env\"' needs 'oidc.tokenEnv', the variable holding the job's token",
    );
  }
  if (
    oidc.awsRoleArn === undefined &&
    oidc.gcpAudience === undefined &&
    oidc.gatewayAudience === undefined
  ) {
    throw new ConfigError(
      "'[oidc]' names no cloud to use the token for: set awsRoleArn, gcpAudience or gatewayAudience",
    );
  }
  return {
    provider: oidc.provider,
    ...(oidc.tokenEnv === undefined ? {} : { tokenEnv: oidc.tokenEnv }),
    ...(oidc.awsRoleArn === undefined ? {} : { awsRoleArn: oidc.awsRoleArn }),
    ...(oidc.gcpAudience === undefined
      ? {}
      : { gcpAudience: oidc.gcpAudience }),
    ...(oidc.gcpServiceAccount === undefined
      ? {}
      : { gcpServiceAccount: oidc.gcpServiceAccount }),
    ...(oidc.gatewayAudience === undefined
      ? {}
      : { gatewayAudience: oidc.gatewayAudience }),
  };
}
