// RL dataset export entry (issue #54; design §74).
// Six dataset types over trajectory exports (read-only): SFT, DPO,
// GRPO, preference pairs, tool-use, coding. New files only — this entry
// is self-contained and is not wired into the package index.
export type { CodingRecord, CodingValidation } from './coding.js';
export {
  buildCodingRecord,
  CODING_SCHEMA,
  validateCodingRecord,
} from './coding.js';
export type {
  DatasetDirEntry,
  DatasetErrorCode,
  DatasetExclusion,
  DatasetExportOptions,
  DatasetFs,
  DatasetManifest,
  ExportDatasetType,
} from './dataset.js';
export {
  DATASET_SCHEMA,
  DATASET_TYPES,
  DatasetError,
  exportDataset,
  resolveDatasetFiles,
} from './dataset.js';
export type { DpoBuild, DpoRecord, DpoValidation } from './dpo.js';
export { buildDpoRecord, DPO_SCHEMA, validateDpoRecord } from './dpo.js';
export type { GrpoCandidate, GrpoGroup, GrpoValidation } from './grpo.js';
export { buildGrpoGroup, GRPO_SCHEMA, validateGrpoGroup } from './grpo.js';
export { canonicalJson } from './manifest.js';
export type {
  ExcludedPair,
  ExclusionTag,
  PairBoundary,
  PairBuild,
  PairValidation,
  PreferencePair,
  PreferenceSide,
} from './preference.js';
export {
  buildPreferencePair,
  PAIR_SCHEMA,
  validatePreferencePair,
} from './preference.js';
export type { SftRecord, SftValidation } from './sft.js';
export { buildSftRecord, SFT_SCHEMA, validateSftRecord } from './sft.js';
export type {
  ToolUseRecord,
  ToolUseStep,
  ToolUseValidation,
} from './tooluse.js';
export {
  buildToolUseRecord,
  TOOLUSE_SCHEMA,
  validateToolUseRecord,
} from './tooluse.js';
export type {
  EnvFailureCode,
  FailureLabelCheck,
  RlProvenance,
  TrajectoryFailureCode,
} from './types.js';
export {
  ENV_FAILURE_CODES,
  extractProvenance,
  isEnvFailure,
  isTrajectoryFailureCode,
  RlProvenanceError,
  requireFailureLabel,
} from './types.js';
export type { VerifierVerdict } from './verifier.js';
export { referenceVerifier } from './verifier.js';
