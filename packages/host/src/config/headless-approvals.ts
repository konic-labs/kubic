// What a run without a terminal reads for its approvals: the broker its asks
// go to and the key a pre-approval file must be signed with. Both come from
// the enterprise, product and global layers only — a repository must not
// route a run's asks to a broker of its own, nor bless its own
// pre-approvals — so a project config setting either is refused by name.

import { isAbsolute } from 'node:path';
import { checkCollectorUrl } from '../net/index.js';
import type { ApprovalsConfig, ConfigLayer, KubicConfig } from './config.js';
import { ConfigError } from './errors.js';

export interface RuntimeHeadlessApprovals {
  // `[approvals] broker`, with the variable its bearer token is read from.
  readonly broker?: { readonly url: string; readonly tokenEnv?: string };
  // `[approvals] preApprovalKey`: the Ed25519 public key (PEM path).
  readonly preApprovalKey?: string;
}

const HEADLESS_KEYS = ['broker', 'brokerTokenEnv', 'preApprovalKey'] as const;
const READ_FROM: ReadonlySet<ConfigLayer> = new Set([
  'enterprise',
  'product',
  'global',
]);

export function headlessApprovalsOf(
  perLayer: ReadonlyArray<{ layer: ConfigLayer; config: KubicConfig }>,
  approvals: ApprovalsConfig,
  projectPath?: string,
): RuntimeHeadlessApprovals {
  for (const { layer, config } of perLayer) {
    if (READ_FROM.has(layer)) continue;
    const named = HEADLESS_KEYS.find(
      (key) => config.approvals?.[key] !== undefined,
    );
    if (named !== undefined) {
      throw new ConfigError(
        `'approvals.${named}' is read from the enterprise, product and global layers only; the ${layer} layer${layer === 'project' && projectPath !== undefined ? ` (${projectPath})` : ''} cannot set it`,
      );
    }
  }
  if (
    approvals.brokerTokenEnv !== undefined &&
    approvals.broker === undefined
  ) {
    throw new ConfigError(
      "'approvals.brokerTokenEnv' names a token for a broker, but 'approvals.broker' is not set",
    );
  }
  if (approvals.broker !== undefined) {
    try {
      checkCollectorUrl(approvals.broker);
    } catch (error) {
      throw new ConfigError(
        `'approvals.broker': ${error instanceof Error ? error.message.replace('collector URL', 'broker URL') : String(error)}`,
      );
    }
  }
  if (
    approvals.preApprovalKey !== undefined &&
    !isAbsolute(approvals.preApprovalKey)
  ) {
    throw new ConfigError(
      `'approvals.preApprovalKey' must be an absolute path to a PEM public key, not ${JSON.stringify(approvals.preApprovalKey)}`,
    );
  }
  return {
    ...(approvals.broker === undefined
      ? {}
      : {
          broker: {
            url: approvals.broker,
            ...(approvals.brokerTokenEnv === undefined
              ? {}
              : { tokenEnv: approvals.brokerTokenEnv }),
          },
        }),
    ...(approvals.preApprovalKey === undefined
      ? {}
      : { preApprovalKey: approvals.preApprovalKey }),
  };
}
