// Enterprise policy: layer validation and resolution, the tool, model and
// provider gates, their doctor checks, and `kubic policy`.

export { enterpriseDoctorChecks } from './doctor-checks.js';
export {
  assertToolGrantable,
  hasModelPolicy,
  hasToolPolicy,
  isModelAllowed,
  isProviderAllowed,
  /** @internal */ isToolAllowed,
  isToolAllowedByEnterprise,
} from './gates.js';
export type { PolicyOptions } from './policy-cli.js';
export {
  policyFromInstalledAllowlist,
  policyWithInstalledAllowlist,
  runPolicyCommand,
} from './policy-cli.js';
export { layerPolicyFromConfig, resolveEffectivePolicy } from './resolve.js';
export type { AuditSinkKind, EffectivePolicy, PolicyInput } from './types.js';
export { PolicyDeniedError } from './types.js';
