// The approval system's public entry: installing the policy a lane runs
// under, its posture, the stores and the full-access switches.
//
// Exports tagged @internal are not part of that API. They expose the
// detectors and the decider service to the composition-root tests in
// apps/kubic, which exercise them alongside the production wiring.
export { /** @internal */ controlPlaneRefusal } from './control-plane.js';
export type { SessionFullAccessGrant } from './full-access.js';
export {
  /** @internal */ enableFullAccess,
  enableSessionFullAccess,
  /** @internal */ FULL_ACCESS_FLAG,
  fullAccessInForceWarning,
} from './full-access.js';
export { installPolicy } from './install.js';
export type { ApprovalConfig, InstalledPolicy } from './installed-policy.js';
export {
  installedPolicyPosture,
  /** @internal */ NO_ANSWER_SURFACE_REASON,
} from './installed-policy.js';
export type { ApprovalVerdict } from './policy.js';
export {
  alwaysAskAutoApprove,
  CAPABILITIES,
  /** @internal */ KUBIC_STATE_WRITE,
  validatePolicy,
} from './policy.js';
export type { ApprovalRequest } from './request.js';
export { /** @internal */ ApprovalService } from './service.js';
export {
  FileApprovalStore,
  /** @internal */ MemoryApprovalStore,
} from './stores.js';
export { TIMEOUT_REASON_MARKER } from './timeout.js';
export type { /** @internal */ TriggerContext } from './triggers.js';
export {
  /** @internal */ detectTriggers,
  /** @internal */ triggerContextFor,
} from './triggers.js';
