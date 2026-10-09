// `kubic doctor`: the checks and probes, their rendering, the limit
// disclosures (no isolation, detection-only classes) and full-access session
// reporting.

export { /** @internal */ collectDoctorChecks } from './collect.js';
export type { DoctorCommandOptions } from './command.js';
export { runDoctorCommand } from './command.js';
export type { FullAccessSession } from './doctor-full-access.js';
export {
  describeFullAccessSession,
  listFullAccessSessions,
} from './doctor-full-access.js';
export { /** @internal */ policyEnforceabilityCheck } from './doctor-limits.js';
export { /** @internal */ renderDoctorGrouped } from './doctor-render.js';
export {
  emitNoIsolationNotice,
  /** @internal */ NOTICE_OPT_OUT_ENV,
  noIsolationNoticeLines,
  noIsolationTuiLine,
  shouldEmitNotice,
} from './no-isolation-notice.js';
export type {
  ContextRoomProbe,
  DepProbe,
  DoctorCheck,
  DoctorDeps,
  ProviderProbe,
  SessionOverlapProbe,
} from './types.js';
