// The approvals a run without a terminal can get: the `[approvals] broker`
// as its answer seat, with its bearer token read from `brokerTokenEnv`, and a
// signed pre-approval file (`--pre-approvals`, else `KUBIC_PRE_APPROVALS`)
// verified against `[approvals] preApprovalKey` before the run starts.

import { resolve } from 'node:path';
import type { ApprovalBrokerTarget, PreApprovals } from '@kubic/host/approvals';
import { loadPreApprovals } from '@kubic/host/approvals';
import type { CliConfigResult } from '../config/load.js';

export type HeadlessApprovalDeps =
  | {
      readonly approvalBroker?: ApprovalBrokerTarget;
      readonly preApprovals?: PreApprovals;
    }
  | { readonly refused: string };

export function headlessApprovalDeps(
  path: string | undefined,
  cliConfig: CliConfigResult,
  env: NodeJS.ProcessEnv,
  cwd: string,
): HeadlessApprovalDeps {
  const approvals = cliConfig.runtime?.approvals;
  const file =
    path ??
    (env.KUBIC_PRE_APPROVALS === undefined || env.KUBIC_PRE_APPROVALS === ''
      ? undefined
      : env.KUBIC_PRE_APPROVALS);
  let preApprovals: PreApprovals | undefined;
  if (file !== undefined) {
    const keyPath = approvals?.preApprovalKey;
    if (keyPath === undefined) {
      return {
        refused: `the pre-approval file ${file} cannot be checked: no [approvals] preApprovalKey is configured`,
      };
    }
    try {
      preApprovals = loadPreApprovals({ path: resolve(cwd, file), keyPath });
    } catch (error) {
      return {
        refused: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const broker = approvals?.broker;
  let approvalBroker: ApprovalBrokerTarget | undefined;
  if (broker !== undefined) {
    const token =
      broker.tokenEnv === undefined ? undefined : env[broker.tokenEnv];
    if (
      broker.tokenEnv !== undefined &&
      (token === undefined || token === '')
    ) {
      return {
        refused: `[approvals] brokerTokenEnv names ${broker.tokenEnv}, which is not set: the broker would refuse every ask`,
      };
    }
    approvalBroker = {
      url: broker.url,
      ...(token === undefined
        ? {}
        : { headers: { authorization: `Bearer ${token}` } }),
    };
  }
  return {
    ...(approvalBroker === undefined ? {} : { approvalBroker }),
    ...(preApprovals === undefined ? {} : { preApprovals }),
  };
}
