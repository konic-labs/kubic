// Configuration: the TOML layers and their validation, the runtime load every
// command runs on, comment-preserving edits, project trust, the MCP and ACP
// stances, and the `kubic config`, `kubic setup` and `kubic trust` commands.
export type { RoleModelEntry } from './checks.js';
export type {
  AuditTableConfig,
  ConfigLayer,
  KubicConfig,
} from './config.js';
export {
  CONFIG_LAYERS,
  checkModelStreamTuning,
  /** @internal */ parseTomlConfig,
} from './config.js';
export type { ConfigCommandOptions } from './config-cli.js';
export { runConfigCommand } from './config-cli.js';
export { buildConfigDoctorInput, configDoctorProbe } from './config-doctor.js';
export { checkWorkspaceIgnoreSplit } from './ignore-split.js';
export { projectProvidersRefusal } from './project-restriction.js';
export { loadRuntimeConfig, MS_PER_DAY } from './runtime.js';
export type {
  RuntimeConfig,
  RuntimeEscalation,
  RuntimeThinking,
  RuntimeVerify,
} from './runtime-types.js';
export {
  compactionSummaryLine,
  effectiveConfigView,
  /** @internal */ renderEffectiveConfig,
} from './runtime-view.js';
export type {
  SetupCommandOptions,
  SetupDeps,
  SetupProviderChoice,
  SetupUi,
} from './setup-cli.js';
export { runSetupCommand } from './setup-cli.js';
export {
  /** @internal */ MCP_ARRIVAL_REQUIREMENTS,
  mcpRefusalMessage,
} from './stances.js';
export type { TrustCommandOptions } from './trust-cli.js';
export { runTrustCommand } from './trust-cli.js';
export { renderTrustReview } from './trust-review.js';
export type { ProjectTrustCheck, ProjectTrustReport } from './trust-store.js';
export {
  NO_PROJECT_TRUST,
  ProjectTrustStore,
  projectTrustCheck,
  projectTrustReport,
  projectTrustStorePath,
} from './trust-store.js';
